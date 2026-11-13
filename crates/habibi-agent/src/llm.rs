//! `/api/llm/*`: model configuration, model lists and chat completion.
//! Ported from `src/server/services/llm-service.js`.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use habibi_core::api::text;
use habibi_core::services::{CompletionRequest, CompletionResult, Llm, LlmState};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::harness::{self, AgentRequest, ImageInput, ModelConfig, Turn};
use crate::http::{HttpRequest, HttpTransport};
use crate::keys::{KeyStore, key_account};
use crate::providers::{PROVIDERS, infer_intent, provider, providers_json, resolve_endpoint};
use crate::util::{encode_uri_component, now_iso, take_chars, write_private_file};

/// Conversation turns sent to a provider.
const MAX_TURNS: usize = 20;
const MAX_ATTACHED_TEXT_CHARS: usize = 24_000;
const MAX_ATTACHED_TEXT_TOTAL_CHARS: usize = 48_000;

static SUPPORTS_VISION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:vision|\bvl\b|llava|qwen.*vl|gpt-4o|gpt-4\.1|gemini|claude)").unwrap());

/// The configured provider, re-resolved from disk on every read.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigState {
    pub configured: bool,
    pub provider: Option<String>,
    pub model: String,
    pub endpoint: String,
}

pub struct LlmService {
    config_file: PathBuf,
    keys: Arc<dyn KeyStore>,
    http: Arc<dyn HttpTransport>,
}

/// One message as the UI sends it to `/api/llm/chat`.
#[derive(Debug, Clone, Default)]
pub struct IncomingMessage {
    pub role: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Default)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub text: Option<String>,
    pub data_url: String,
}

impl IncomingMessage {
    pub fn from_value(value: &Value) -> Self {
        let field = |name: &str| value.get(name).filter(|value| crate::util::truthy(Some(value)));
        let message = field("text").or_else(|| field("content")).map(crate::util::js_string).unwrap_or_default();
        let attachments = value
            .get("attachments")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.is_object())
                    .map(|item| Attachment {
                        name: item.get("name").map(crate::util::js_string).unwrap_or_else(|| "undefined".into()),
                        mime: text(item.get("mime")),
                        text: item.get("text").and_then(Value::as_str).map(str::to_string),
                        data_url: text(item.get("dataUrl")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { role: text(value.get("role")), text: message, attachments }
    }
}

/// What a completion produced, before it becomes a route envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub ok: bool,
    pub text: Option<String>,
    pub error: Option<String>,
    pub needs_configuration: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub proposal: Option<crate::providers::Intent>,
}

impl Completion {
    pub fn to_json(&self) -> Value {
        if self.needs_configuration {
            return json!({ "ok": false, "needsConfiguration": true, "error": self.error });
        }
        if self.ok {
            json!({ "ok": true, "text": self.text, "provider": self.provider, "model": self.model, "proposal": self.proposal })
        } else {
            json!({ "ok": false, "error": self.error, "provider": self.provider, "model": self.model })
        }
    }
}

impl LlmService {
    pub fn new(config_file: PathBuf, keys: Arc<dyn KeyStore>, http: Arc<dyn HttpTransport>) -> Self {
        Self { config_file, keys, http }
    }

    fn read_config(&self) -> Map<String, Value> {
        std::fs::read(&self.config_file)
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default()
    }

    async fn get_key(&self, provider: &str) -> Option<String> {
        let keys = self.keys.clone();
        let account = key_account(provider);
        tokio::task::spawn_blocking(move || keys.get(&account)).await.ok().flatten().filter(|key| !key.is_empty())
    }

    /// Store the key, then read it back: a store that truncates long keys
    /// must not be reported as a successful save.
    async fn save_key(&self, provider: &str, api_key: &str) -> bool {
        let keys = self.keys.clone();
        let account = key_account(provider);
        let secret = api_key.to_string();
        let stored = tokio::task::spawn_blocking(move || keys.set(&account, &secret)).await.unwrap_or(false);
        stored && self.get_key(provider).await.as_deref() == Some(api_key)
    }

    pub async fn state(&self) -> ConfigState {
        let config = self.read_config();
        let provider_id = text(config.get("provider"));
        let Some(definition) = provider(&provider_id) else {
            return ConfigState { configured: false, provider: None, model: String::new(), endpoint: String::new() };
        };
        let has_key = definition.is_local() || self.get_key(&provider_id).await.is_some();
        let model = text(config.get("model"));
        // Re-resolved on read, not just on write: a config file poisoned before
        // the pinning guard existed must not keep redirecting requests that
        // carry an API key.
        let endpoint = resolve_endpoint(&provider_id, &text(config.get("endpoint")));
        ConfigState {
            configured: has_key,
            model: if model.is_empty() { definition.model.into() } else { model },
            provider: Some(provider_id),
            endpoint,
        }
    }

    /// `GET /api/llm/status`.
    pub async fn status(&self) -> Value {
        let state = self.state().await;
        match state.provider {
            None => json!({ "ok": true, "configured": false, "providers": providers_json() }),
            Some(provider) => json!({
                "ok": true,
                "configured": state.configured,
                "provider": provider,
                "model": state.model,
                "endpoint": state.endpoint,
                "providers": providers_json(),
            }),
        }
    }

    async fn validate_openai(&self, api_key: &str, model: &str) -> Option<String> {
        let request = HttpRequest::get(format!("{}/models/{}", PROVIDERS.openai.endpoint, encode_uri_component(model)))
            .header("Authorization", &format!("Bearer {api_key}"));
        let Ok(response) = self.http.send(request).await else {
            return Some(
                "Could not reach OpenAI to verify the key. Check your internet connection and try again.".into(),
            );
        };
        if response.ok() {
            return None;
        }
        Some(match response.status {
            401 | 403 => "OpenAI rejected that API key. Create an API key in the OpenAI platform and try again.".into(),
            429 => "OpenAI accepted the key, but the API account has no available quota or is rate-limited. Check API billing and usage limits, then try again.".into(),
            404 => format!("This OpenAI API key cannot use the “{model}” model. Choose another model and try again."),
            _ => "OpenAI could not verify this key and model. Check your API project permissions and try again.".into(),
        })
    }

    /// `POST /api/llm/configure`.
    pub async fn configure(&self, body: &Value) -> Value {
        let provider_id = body.get("provider").and_then(Value::as_str).unwrap_or("");
        let Some(definition) = provider(provider_id) else {
            return json!({ "ok": false, "error": "Unsupported provider" });
        };
        let selected_model = match body.get("model").and_then(Value::as_str).map(str::trim) {
            Some(model) if !model.is_empty() => model.to_string(),
            _ => definition.model.to_string(),
        };
        let supplied_key = body.get("apiKey").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        if !definition.is_local() && supplied_key.is_empty() && self.get_key(provider_id).await.is_none() {
            return json!({ "ok": false, "error": "An API key is required for this provider." });
        }
        if provider_id == "openai"
            && !supplied_key.is_empty()
            && let Some(error) = self.validate_openai(&supplied_key, &selected_model).await
        {
            return json!({ "ok": false, "error": error });
        }
        if !supplied_key.is_empty() && !self.save_key(provider_id, &supplied_key).await {
            return json!({
                "ok": false,
                "error": "The complete API key could not be saved and verified. Update Habibi, then paste the key again in Model settings.",
            });
        }
        let config = json!({
            "provider": provider_id,
            "model": selected_model,
            "endpoint": resolve_endpoint(provider_id, &text(body.get("endpoint"))),
            "updatedAt": now_iso(),
        });
        let serialized = serde_json::to_vec_pretty(&config).unwrap_or_default();
        if write_private_file(&self.config_file, &serialized).is_err() {
            return json!({ "ok": false, "error": "The model settings could not be saved." });
        }
        self.status().await
    }

    /// `/api/llm/models` (GET and POST).
    pub async fn models(&self, provider_id: &str, endpoint: &str, api_key: &str) -> Value {
        let failed = json!({ "ok": false, "models": [] });
        if provider(provider_id).is_none() {
            return failed;
        }
        let base = resolve_endpoint(provider_id, endpoint);
        let fetch = |request: HttpRequest| async move {
            let response = self.http.send(request).await.ok()?;
            Some((response.ok(), response.json_value()?))
        };
        let ids = |data: &Value, list: &str, field: &str| -> Vec<String> {
            data.get(list)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get(field).and_then(Value::as_str))
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        let result = match provider_id {
            "ollama" => fetch(HttpRequest::get(format!("{base}/api/tags")))
                .await
                .map(|(ok, data)| (ok, ids(&data, "models", "name"))),
            "lmstudio" => {
                fetch(HttpRequest::get(format!("{base}/models"))).await.map(|(ok, data)| (ok, ids(&data, "data", "id")))
            }
            _ => {
                let supplied = api_key.trim();
                let key =
                    if supplied.is_empty() { self.get_key(provider_id).await } else { Some(supplied.to_string()) };
                let Some(key) = key else { return failed };
                let mut listed = match provider_id {
                    "openai" => fetch(
                        HttpRequest::get(format!("{base}/models")).header("Authorization", &format!("Bearer {key}")),
                    )
                    .await
                    .map(|(ok, data)| (ok, ids(&data, "data", "id"))),
                    "anthropic" => fetch(
                        HttpRequest::get(format!("{base}/v1/models"))
                            .header("x-api-key", &key)
                            .header("anthropic-version", "2023-06-01"),
                    )
                    .await
                    .map(|(ok, data)| (ok, ids(&data, "data", "id"))),
                    // The key travels in a header so it is never part of a URL.
                    _ => fetch(HttpRequest::get(format!("{base}/models")).header("x-goog-api-key", &key)).await.map(
                        |(ok, data)| {
                            let models = data
                                .get("models")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter(|item| {
                                            match item.get("supportedGenerationMethods").and_then(Value::as_array) {
                                                Some(methods) => {
                                                    methods.iter().any(|method| method == "generateContent")
                                                }
                                                None => true,
                                            }
                                        })
                                        .map(|item| text(item.get("name")))
                                        .map(|name| name.strip_prefix("models/").map(str::to_string).unwrap_or(name))
                                        .filter(|name| !name.is_empty())
                                        .collect()
                                })
                                .unwrap_or_default();
                            (ok, models)
                        },
                    ),
                };
                if let Some((_, models)) = listed.as_mut() {
                    models.sort();
                }
                listed
            }
        };
        match result {
            Some((ok, models)) => json!({ "ok": ok, "models": models }),
            None => failed,
        }
    }

    fn default_system_prompt(intent: Option<&crate::providers::Intent>) -> String {
        let related =
            intent.map(|intent| format!("Related capability: {}. {}", intent.label, intent.detail)).unwrap_or_default();
        format!(
            "You are Habibi, a concise private macOS assistant. Habibi can open websites, folders and installed apps; search local filenames, connected Mail and WhatsApp; open Airbnb or web searches; prepare email, WhatsApp and calendar drafts; query WhoDB read-only; open the existing Kubernetes and macOS action screens; and prepare reviewed file rename, organization, storage, duplicates, image/PDF conversion and extraction plans for paths the user explicitly mentions with @. Timer, Apple Reminder, clipboard and recent-file controls appear in this chat. File changes require a separate reviewed plan and approval; removal is off unless Allow cleanup is explicitly selected, and only moves to Trash are supported. The host presents every selected action for explicit user confirmation before execution. Planning never authorizes execution, including compression, conversion, or private output previews. Never grant confirmation yourself. Never claim an action succeeded unless the host supplied its successful result. Never invent file contents, contacts, inbox results, browser results, bookings, prices, availability, or account permissions. Use only the user's submitted context and explicitly provided tool results; ask for genuinely missing recipient or destination details. Messages, calendar writes, destructive system actions and other external writes require the application's separate approval step. Never grant that approval yourself. Answer ordinary questions directly in short paragraphs or concise Markdown lists. {related}"
        )
    }

    fn attachment_note(attachments: &[Attachment], supports_vision: bool) -> String {
        if attachments.is_empty() {
            return String::new();
        }
        let list = attachments
            .iter()
            .map(|item| format!("{} ({})", item.name, if item.mime.is_empty() { "unknown type" } else { &item.mime }))
            .collect::<Vec<_>>()
            .join(", ");
        let summary = format!(
            "\n\n[Attachment{} included: {list}.{}]",
            if attachments.len() == 1 { "" } else { "s" },
            if supports_vision {
                ""
            } else {
                " This model cannot inspect image attachment content; acknowledge that limitation and ask for relevant text or a vision-capable model if needed."
            }
        );
        // Text pasted as an attachment is explicit user-provided context. It is
        // included only in that submitted turn, capped locally before any model
        // provider sees it; previous turns retain metadata rather than the text.
        let pasted: String = attachments
            .iter()
            .filter(|item| item.mime == "text/plain")
            .filter_map(|item| {
                item.text.as_ref().map(|text| {
                    format!("\n\n[Attached text: {}]\n{}", item.name, take_chars(text, MAX_ATTACHED_TEXT_CHARS))
                })
            })
            .collect();
        summary + &take_chars(&pasted, MAX_ATTACHED_TEXT_TOTAL_CHARS)
    }

    /// The chat completion every caller goes through.
    pub async fn complete(
        &self,
        messages: &[IncomingMessage],
        system_override: Option<&str>,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> Completion {
        let state = self.state().await;
        let (true, Some(provider_id)) = (state.configured, state.provider.clone()) else {
            return Completion {
                ok: false,
                text: None,
                error: Some("Choose a model provider first.".into()),
                needs_configuration: true,
                provider: None,
                model: None,
                proposal: None,
            };
        };
        let model = state.model.clone();
        let intent = infer_intent(messages.last().map(|message| message.text.as_str()).unwrap_or(""));
        let system = match system_override.filter(|system| !system.is_empty()) {
            Some(system) => system.to_string(),
            None => Self::default_system_prompt(intent.as_ref()),
        };
        let supports_vision = SUPPORTS_VISION.is_match(&model);
        let recent = &messages[messages.len().saturating_sub(MAX_TURNS)..];
        let last_user = recent.iter().rposition(|message| message.role != "assistant");
        let turns = recent
            .iter()
            .enumerate()
            .map(|(index, message)| {
                let content =
                    format!("{}{}", message.text, Self::attachment_note(&message.attachments, supports_vision));
                if message.role == "assistant" {
                    return Turn::assistant(content);
                }
                // Only the latest user turn carries image bytes, and only to a
                // model that can read them.
                let images = if supports_vision && Some(index) == last_user {
                    message
                        .attachments
                        .iter()
                        .filter(|item| item.mime.starts_with("image/") && item.data_url.starts_with("data:image/"))
                        .map(|item| ImageInput { mime: item.mime.clone(), data_url: item.data_url.clone() })
                        .collect()
                } else {
                    Vec::new()
                };
                Turn::User { text: content, images }
            })
            .collect::<Vec<_>>();
        let api_key = if provider(&provider_id).is_some_and(|definition| definition.is_local()) {
            None
        } else {
            self.get_key(&provider_id).await
        };
        let config = ModelConfig {
            provider: provider_id.clone(),
            endpoint: state.endpoint.clone(),
            model: model.clone(),
            api_key,
        };
        let request = AgentRequest { system_prompt: system, turns, temperature, max_tokens, ..Default::default() };
        match harness::run(self.http.as_ref(), &config, request).await {
            Ok(result) => Completion {
                ok: true,
                text: Some(result.text),
                error: None,
                needs_configuration: false,
                provider: Some(provider_id),
                model: Some(model),
                proposal: intent,
            },
            Err(error) => Completion {
                ok: false,
                text: None,
                error: Some(error.0),
                needs_configuration: false,
                provider: Some(provider_id),
                model: Some(model),
                proposal: None,
            },
        }
    }

    /// `POST /api/llm/chat`.
    pub async fn chat(&self, body: &Value) -> Value {
        let messages: Vec<IncomingMessage> = body
            .get("messages")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(IncomingMessage::from_value).collect())
            .unwrap_or_default();
        self.complete(&messages, None, None, None).await.to_json()
    }
}

#[async_trait]
impl Llm for LlmService {
    async fn state(&self) -> LlmState {
        let state = LlmService::state(self).await;
        LlmState { configured: state.configured, provider: state.provider }
    }

    async fn complete(&self, request: CompletionRequest) -> CompletionResult {
        let messages: Vec<IncomingMessage> = request
            .messages
            .into_iter()
            .map(|message| IncomingMessage { role: message.role, text: message.text, attachments: Vec::new() })
            .collect();
        let result = LlmService::complete(
            self,
            &messages,
            request.system_prompt.as_deref(),
            request.temperature,
            request.max_tokens,
        )
        .await;
        CompletionResult {
            ok: result.ok,
            text: result.text,
            error: result.error,
            needs_configuration: result.needs_configuration,
            provider: result.provider,
            model: result.model,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::http::testing::FakeTransport;
    use crate::http::{HttpError, HttpResponse};
    use crate::keys::MemoryKeyStore;

    fn service(dir: &tempfile::TempDir, keys: Arc<dyn KeyStore>, http: Arc<FakeTransport>) -> LlmService {
        LlmService::new(dir.path().join(".habibi/llm-config.json"), keys, http)
    }

    fn ok_transport() -> Arc<FakeTransport> {
        Arc::new(FakeTransport::new(|_| Ok(HttpResponse::json(200, &json!({})))))
    }

    fn stored(dir: &tempfile::TempDir) -> Value {
        serde_json::from_slice(&std::fs::read(dir.path().join(".habibi/llm-config.json")).unwrap()).unwrap()
    }

    // Requests to a hosted provider carry a stored API key. If a caller could
    // choose the endpoint, one /api/llm/configure call would redirect that key
    // — and the whole conversation — to a host of its choosing.
    #[tokio::test]
    async fn a_hosted_provider_endpoint_cannot_be_redirected_by_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), ok_transport());
        let result = llm
            .configure(&json!({ "provider": "openai", "endpoint": "http://attacker.example/v1", "apiKey": "sk-test" }))
            .await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["endpoint"], PROVIDERS.openai.endpoint);
        // The rejected endpoint must not reach disk either.
        let config = stored(&dir);
        assert_eq!(config["endpoint"], PROVIDERS.openai.endpoint);
        assert!(!config.to_string().contains("attacker.example"));
    }

    #[tokio::test]
    async fn a_config_file_poisoned_before_the_guard_existed_is_re_pinned_on_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".habibi")).unwrap();
        std::fs::write(
            dir.path().join(".habibi/llm-config.json"),
            json!({ "provider": "anthropic", "model": "claude-sonnet-4-5", "endpoint": "https://attacker.example" })
                .to_string(),
        )
        .unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        keys.set("provider:anthropic", "ant-key");
        let http = Arc::new(FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "content": [{ "type": "text", "text": "hi" }] })))
        }));
        let llm = service(&dir, keys, http.clone());
        assert_eq!(llm.status().await["endpoint"], PROVIDERS.anthropic.endpoint);
        // And a completion carrying the key goes to the pinned host.
        let result = llm
            .complete(
                &[IncomingMessage { role: "user".into(), text: "hello".into(), ..Default::default() }],
                None,
                None,
                None,
            )
            .await;
        assert!(result.ok);
        assert!(http.sent().iter().all(|request| request.url.starts_with("https://api.anthropic.com/")));
    }

    #[tokio::test]
    async fn a_local_provider_may_move_but_only_to_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), ok_transport());
        let moved = llm.configure(&json!({ "provider": "ollama", "endpoint": "http://127.0.0.1:11500" })).await;
        assert_eq!(moved["endpoint"], "http://127.0.0.1:11500");
        let named = llm.configure(&json!({ "provider": "ollama", "endpoint": "http://localhost:11434" })).await;
        assert_eq!(named["endpoint"], "http://localhost:11434");
        for endpoint in [
            "http://evil.tld:11434",
            "https://attacker.example",
            "http://169.254.169.254",
            "file:///etc/passwd",
            "not-a-url",
        ] {
            let rejected = llm.configure(&json!({ "provider": "ollama", "endpoint": endpoint })).await;
            assert_eq!(rejected["endpoint"], PROVIDERS.ollama.endpoint, "{endpoint} should not be accepted");
        }
    }

    #[tokio::test]
    async fn openai_setup_verifies_a_supplied_key_before_saving_it() {
        let dir = tempfile::tempdir().unwrap();
        let http = ok_transport();
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), http.clone());
        let result =
            llm.configure(&json!({ "provider": "openai", "model": " chat-latest ", "apiKey": " sk-test " })).await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["model"], "chat-latest");
        let sent = http.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].url, "https://api.openai.com/v1/models/chat-latest");
        assert_eq!(sent[0].header_value("Authorization"), Some("Bearer sk-test"));
    }

    #[tokio::test]
    async fn openai_setup_explains_rejected_keys_without_saving_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let http = Arc::new(FakeTransport::new(|_| Ok(HttpResponse::new(401, ""))));
        let llm = service(&dir, keys.clone(), http);
        let result = llm.configure(&json!({ "provider": "openai", "apiKey": "sk-invalid" })).await;
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("rejected that API key"));
        assert!(keys.get("provider:openai").is_none());
        assert!(!dir.path().join(".habibi/llm-config.json").exists());
        let offline = service(&dir, Arc::new(MemoryKeyStore::new()), Arc::new(FakeTransport::offline()));
        let result = offline.configure(&json!({ "provider": "openai", "apiKey": "sk-x" })).await;
        assert!(result["error"].as_str().unwrap().starts_with("Could not reach OpenAI"));
    }

    #[tokio::test]
    async fn hosted_providers_need_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), ok_transport());
        assert_eq!(
            llm.configure(&json!({ "provider": "anthropic" })).await["error"],
            "An API key is required for this provider."
        );
        assert_eq!(llm.configure(&json!({ "provider": "nope" })).await["error"], "Unsupported provider");
    }

    #[tokio::test]
    async fn long_provider_keys_survive_storage_and_a_fresh_service_reads_the_entire_credential() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        let api_key = format!("sk-project-dummy-{}", "long-key-fixture-".repeat(30));
        let saved = service(&dir, keys.clone(), ok_transport())
            .configure(&json!({ "provider": "openai", "model": "test-model", "apiKey": api_key }))
            .await;
        assert_eq!(saved["ok"], true);
        let restarted = service(&dir, keys.clone(), ok_transport()).status().await;
        assert_eq!(restarted["configured"], true);
        assert_eq!(restarted["model"], "test-model");
        assert_eq!(keys.get("provider:openai").as_deref(), Some(api_key.as_str()));
        let config = std::fs::read_to_string(dir.path().join(".habibi/llm-config.json")).unwrap();
        assert!(!config.contains(&api_key));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(".habibi/llm-config.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let dir_mode = std::fs::metadata(dir.path().join(".habibi")).unwrap().permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
    }

    /// A store that accepts a write but reads back a truncated value.
    struct TruncatingStore(Mutex<Option<String>>);

    impl KeyStore for TruncatingStore {
        fn get(&self, _: &str) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn set(&self, _: &str, secret: &str) -> bool {
            *self.0.lock().unwrap() = Some(secret.chars().take(128).collect());
            true
        }
    }

    #[tokio::test]
    async fn a_successful_save_with_truncated_read_back_is_rejected_before_configuration_is_published() {
        let dir = tempfile::tempdir().unwrap();
        let llm = service(&dir, Arc::new(TruncatingStore(Mutex::new(None))), ok_transport());
        let result = llm.configure(&json!({ "provider": "openai", "apiKey": "dummy-long-key-".repeat(30) })).await;
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("complete API key could not be saved and verified"));
        assert!(!dir.path().join(".habibi/llm-config.json").exists());
    }

    #[tokio::test]
    async fn unconfigured_chat_asks_for_a_provider() {
        let dir = tempfile::tempdir().unwrap();
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), ok_transport());
        let result = llm.chat(&json!({ "messages": [{ "role": "user", "text": "hi" }] })).await;
        assert_eq!(
            result,
            json!({ "ok": false, "needsConfiguration": true, "error": "Choose a model provider first." })
        );
        let status = llm.status().await;
        assert_eq!(status["configured"], false);
        assert_eq!(status["providers"]["openai"]["endpoint"], PROVIDERS.openai.endpoint);
    }

    #[tokio::test]
    async fn chat_keeps_twenty_turns_attaches_capped_text_and_images_only_for_vision_models() {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "choices": [{ "message": { "content": "ok" } }] })))
        }));
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), http.clone());
        llm.configure(&json!({ "provider": "lmstudio", "model": "qwen2-vl" })).await;
        let mut messages: Vec<Value> = (0..24).map(|index| json!({ "role": if index % 2 == 0 { "user" } else { "assistant" }, "text": format!("t{index}") })).collect();
        messages.push(json!({
            "role": "user",
            "text": "send an email about this",
            "attachments": [
                { "name": "a.png", "mime": "image/png", "dataUrl": "data:image/png;base64,AAAA" },
                { "name": "notes.txt", "mime": "text/plain", "text": "x".repeat(30_000) },
            ],
        }));
        let result = llm.chat(&json!({ "messages": messages })).await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["proposal"]["kind"], "email_draft");
        assert_eq!(result["provider"], "lmstudio");
        let body = http.sent()[0].json_body().unwrap();
        let sent = body["messages"].as_array().unwrap();
        assert_eq!(sent.len(), 21);
        let last = &sent[20]["content"];
        assert!(
            last[0]["text"]
                .as_str()
                .unwrap()
                .contains("[Attachments included: a.png (image/png), notes.txt (text/plain).]")
        );
        assert!(last[0]["text"].as_str().unwrap().contains(&"x".repeat(24_000)));
        assert!(!last[0]["text"].as_str().unwrap().contains(&"x".repeat(24_001)));
        assert_eq!(last[1]["image_url"]["url"], "data:image/png;base64,AAAA");

        llm.configure(&json!({ "provider": "lmstudio", "model": "plain-model" })).await;
        let result = llm
            .chat(&json!({ "messages": [{ "role": "user", "text": "look", "attachments": [{ "name": "a.png", "mime": "image/png", "dataUrl": "data:image/png;base64,AAAA" }] }] }))
            .await;
        assert_eq!(result["proposal"], Value::Null);
        let body = http.sent()[1].json_body().unwrap();
        let content = body["messages"][1]["content"].as_str().unwrap();
        assert!(content.contains("cannot inspect image attachment content"));
    }

    #[tokio::test]
    async fn provider_failures_return_fixed_errors() {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(MemoryKeyStore::new());
        keys.set("provider:openai", "sk-saved");
        let http = Arc::new(FakeTransport::new(|request: &HttpRequest| {
            if request.url.ends_with("/chat/completions") {
                Ok(HttpResponse::json(429, &json!({ "error": { "message": "raw provider text sk-saved" } })))
            } else {
                Err(HttpError)
            }
        }));
        std::fs::create_dir_all(dir.path().join(".habibi")).unwrap();
        std::fs::write(
            dir.path().join(".habibi/llm-config.json"),
            json!({ "provider": "openai", "model": "gpt-x" }).to_string(),
        )
        .unwrap();
        let llm = service(&dir, keys, http);
        let result = llm.chat(&json!({ "messages": [{ "role": "user", "text": "hi" }] })).await;
        assert_eq!(
            result,
            json!({
                "ok": false,
                "error": "OpenAI has no available quota or is rate-limited. Check API billing and usage limits.",
                "provider": "openai",
                "model": "gpt-x",
            })
        );
    }

    #[tokio::test]
    async fn model_lists_use_the_pinned_endpoint_and_never_put_keys_in_urls() {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeTransport::new(|request: &HttpRequest| {
            Ok(HttpResponse::json(
                200,
                &if request.url.contains("googleapis") {
                    json!({ "models": [
                    { "name": "models/gemini-b", "supportedGenerationMethods": ["generateContent"] },
                    { "name": "models/embed", "supportedGenerationMethods": ["embedContent"] },
                    { "name": "models/gemini-a" },
                ] })
                } else if request.url.ends_with("/api/tags") {
                    json!({ "models": [{ "name": "llama3.2" }, { "name": "" }] })
                } else {
                    json!({ "data": [{ "id": "z" }, { "id": "a" }] })
                },
            ))
        }));
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), http.clone());
        assert_eq!(
            llm.models("gemini", "", " g-key ").await,
            json!({ "ok": true, "models": ["gemini-a", "gemini-b"] })
        );
        assert_eq!(
            llm.models("openai", "http://attacker.example", "sk").await,
            json!({ "ok": true, "models": ["a", "z"] })
        );
        assert_eq!(llm.models("ollama", "", "").await, json!({ "ok": true, "models": ["llama3.2"] }));
        assert_eq!(llm.models("lmstudio", "", "").await, json!({ "ok": true, "models": ["z", "a"] }));
        assert_eq!(llm.models("anthropic", "", "").await, json!({ "ok": false, "models": [] }));
        assert_eq!(llm.models("other", "", "").await, json!({ "ok": false, "models": [] }));
        let sent = http.sent();
        assert_eq!(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models");
        assert_eq!(sent[0].header_value("x-goog-api-key"), Some("g-key"));
        assert_eq!(sent[1].url, "https://api.openai.com/v1/models");
        assert_eq!(sent[2].url, "http://127.0.0.1:11434/api/tags");
        assert!(sent.iter().all(|request| !request.url.contains("key")));
    }

    #[tokio::test]
    async fn the_llm_trait_completes_with_a_system_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "message": {}, "choices": [{ "message": { "content": "{}" } }] })))
        }));
        let llm = service(&dir, Arc::new(MemoryKeyStore::new()), http.clone());
        llm.configure(&json!({ "provider": "ollama" })).await;
        let state = Llm::state(&llm).await;
        assert_eq!(state, LlmState { configured: true, provider: Some("ollama".into()) });
        let result = Llm::complete(
            &llm,
            CompletionRequest {
                system_prompt: Some("Return JSON".into()),
                messages: vec![habibi_core::services::ChatMessage { role: "user".into(), text: "q".into() }],
                temperature: Some(0.0),
                max_tokens: Some(100),
            },
        )
        .await;
        assert_eq!(
            result,
            CompletionResult {
                ok: true,
                text: Some("{}".into()),
                provider: Some("ollama".into()),
                model: Some("llama3.2".into()),
                ..Default::default()
            }
        );
        let body = http.sent()[0].json_body().unwrap();
        assert_eq!(body["messages"][0]["content"], "Return JSON");
        assert_eq!(body["max_tokens"], 100);
        assert_eq!(body["model"], "llama3.2");
    }
}
