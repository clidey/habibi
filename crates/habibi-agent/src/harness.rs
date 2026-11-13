//! Habibi's agent harness: minimal provider clients and a bounded tool loop.
//!
//! This replaces the Pi runtime. Habibi owns model transport and the tool-use
//! loop as well as identities, privacy filtering, tool policy and
//! confirmation. Every tool call goes through [`crate::policy`] before it
//! runs, and no tool registered here can make an external write.
//!
//! Providers:
//! - OpenAI-compatible chat completions (OpenAI, LM Studio, Ollama at
//!   `<endpoint>/v1`);
//! - Anthropic Messages;
//! - Google Gemini `generateContent`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::http::{HttpRequest, HttpResponse, HttpTransport};
use crate::policy::{ToolPolicyDecision, evaluate_tool_call};
use crate::providers::provider;
use crate::util::encode_uri_component;

/// Model rounds a single turn may take while it is calling tools.
pub const MAX_TOOL_ROUNDS: usize = 8;
/// Output budget when the caller does not set one (Pi's `maxTokens`).
pub const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Tool output passed back to the model is capped locally.
const MAX_TOOL_RESULT_CHARS: usize = 24_000;

/// A tool the model may call. Implementations must be reads or local draft
/// preparation; external writes belong to approved routes, never here.
#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema for the arguments object.
    fn input_schema(&self) -> Value;
    /// The text handed back to the model, or a user-safe error.
    async fn run(&self, arguments: Value) -> Result<String, String>;
}

/// Redeems a single-use approval for one tool call (see [`evaluate_tool_call`]).
pub type ApprovalRedeemer<'a> = dyn Fn(&str) -> bool + Send + Sync + 'a;

#[derive(Clone)]
pub struct ModelConfig {
    pub provider: String,
    /// Already resolved through [`crate::providers::resolve_endpoint`].
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageInput {
    pub mime: String,
    /// The whole `data:image/...;base64,...` URL.
    pub data_url: String,
}

impl ImageInput {
    fn base64(&self) -> &str {
        self.data_url.split(',').nth(1).unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    pub call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Turn {
    User { text: String, images: Vec<ImageInput> },
    Assistant { text: String, tool_calls: Vec<ToolCall>, native: Option<Value> },
    ToolResults(Vec<ToolOutcome>),
}

impl Turn {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User { text: text.into(), images: Vec::new() }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self::Assistant { text: text.into(), tool_calls: Vec::new(), native: None }
    }
}

#[derive(Default)]
pub struct AgentRequest<'a> {
    pub system_prompt: String,
    pub turns: Vec<Turn>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub tools: Vec<Arc<dyn AgentTool>>,
    pub redeem_approval: Option<&'a ApprovalRedeemer<'a>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentResult {
    pub text: String,
    /// Every tool result produced this turn, blocked ones included.
    pub tool_events: Vec<ToolOutcome>,
}

/// A user-safe failure. Provider error bodies are never forwarded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentError(pub String);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Api {
    OpenAi,
    Anthropic,
    Gemini,
}

fn api_for(provider: &str) -> Api {
    match provider {
        "anthropic" => Api::Anthropic,
        "gemini" => Api::Gemini,
        _ => Api::OpenAi,
    }
}

fn label(provider_id: &str) -> &'static str {
    provider(provider_id).map(|definition| definition.label).unwrap_or("The provider")
}

/// Base URL of the OpenAI-compatible API for a provider.
pub fn openai_base(provider: &str, endpoint: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    if provider == "ollama" { format!("{endpoint}/v1") } else { endpoint.to_string() }
}

struct Reply {
    text: String,
    tool_calls: Vec<ToolCall>,
    native: Value,
}

/// Run one agent turn: call the model, run approved tools, repeat at most
/// [`MAX_TOOL_ROUNDS`] times.
pub async fn run(
    http: &dyn HttpTransport,
    config: &ModelConfig,
    request: AgentRequest<'_>,
) -> Result<AgentResult, AgentError> {
    let api = api_for(&config.provider);
    let mut turns = request.turns;
    let mut tool_events = Vec::new();
    let mut last_text = String::new();
    for _ in 0..MAX_TOOL_ROUNDS {
        let body = match api {
            Api::OpenAi => openai_body(
                config,
                &request.system_prompt,
                &turns,
                &request.tools,
                request.temperature,
                request.max_tokens,
            ),
            Api::Anthropic => anthropic_body(
                config,
                &request.system_prompt,
                &turns,
                &request.tools,
                request.temperature,
                request.max_tokens,
            ),
            Api::Gemini => {
                gemini_body(&request.system_prompt, &turns, &request.tools, request.temperature, request.max_tokens)
            }
        };
        let http_request = match api {
            Api::OpenAi => {
                let request = HttpRequest::post_json(
                    format!("{}/chat/completions", openai_base(&config.provider, &config.endpoint)),
                    &body,
                );
                match config.api_key.as_deref().filter(|key| !key.is_empty()) {
                    Some(key) => request.header("Authorization", &format!("Bearer {key}")),
                    None => request,
                }
            }
            Api::Anthropic => {
                HttpRequest::post_json(format!("{}/v1/messages", config.endpoint.trim_end_matches('/')), &body)
                    .header("x-api-key", config.api_key.as_deref().unwrap_or(""))
                    .header("anthropic-version", "2023-06-01")
            }
            // The key goes in a header rather than `?key=` so it never sits in a URL.
            Api::Gemini => HttpRequest::post_json(
                format!(
                    "{}/models/{}:generateContent",
                    config.endpoint.trim_end_matches('/'),
                    encode_uri_component(&config.model)
                ),
                &body,
            )
            .header("x-goog-api-key", config.api_key.as_deref().unwrap_or("")),
        };
        let response = http.send(http_request).await.map_err(|_| AgentError("The provider is unavailable.".into()))?;
        if !response.ok() {
            return Err(AgentError(provider_failure(&config.provider, &response)));
        }
        let data =
            response.json_value().ok_or_else(|| AgentError(format!("{} could not answer", label(&config.provider))))?;
        let reply = match api {
            Api::OpenAi => openai_reply(&data),
            Api::Anthropic => anthropic_reply(&data),
            Api::Gemini => gemini_reply(&data),
        };
        last_text = reply.text.clone();
        if reply.tool_calls.is_empty() {
            return Ok(AgentResult { text: reply.text, tool_events });
        }
        let calls = reply.tool_calls.clone();
        turns.push(Turn::Assistant { text: reply.text, tool_calls: reply.tool_calls, native: Some(reply.native) });
        let mut outcomes = Vec::new();
        for call in calls {
            let outcome = execute_tool(&call, &request.tools, request.redeem_approval).await;
            outcomes.push(outcome);
        }
        tool_events.extend(outcomes.iter().cloned());
        turns.push(Turn::ToolResults(outcomes));
    }
    Ok(AgentResult { text: last_text, tool_events })
}

async fn execute_tool(
    call: &ToolCall,
    tools: &[Arc<dyn AgentTool>],
    redeem: Option<&ApprovalRedeemer<'_>>,
) -> ToolOutcome {
    let blocked =
        |content: String| ToolOutcome { call_id: call.id.clone(), name: call.name.clone(), content, is_error: true };
    // The policy runs before anything else, including the lookup, so an
    // unknown tool name is treated exactly like a known one.
    let redeem = redeem.map(|redeem| redeem as &(dyn Fn(&str) -> bool + Sync));
    if let ToolPolicyDecision::RequireConfirmation { reason } = evaluate_tool_call(&call.name, redeem) {
        return blocked(reason);
    }
    let Some(tool) = tools.iter().find(|tool| tool.name() == call.name) else {
        return blocked(format!("{} is not an available tool.", call.name));
    };
    match tool.run(call.arguments.clone()).await {
        Ok(content) => ToolOutcome {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: content.chars().take(MAX_TOOL_RESULT_CHARS).collect(),
            is_error: false,
        },
        Err(error) => blocked(error),
    }
}

/// A fixed, user-safe message for a failed provider response.
fn provider_failure(provider: &str, response: &HttpResponse) -> String {
    if provider == "openai" {
        return match response.status {
            401 => "OpenAI rejected the saved API key. Paste the complete key again in Model settings.",
            403 => "OpenAI denied this request. Check the API project and model permissions.",
            429 => "OpenAI has no available quota or is rate-limited. Check API billing and usage limits.",
            404 => "This OpenAI model is unavailable for your API key. Choose another model in Model settings.",
            _ => "OpenAI could not complete this request. Check the selected model and its API settings.",
        }
        .into();
    }
    format!("{} could not answer", label(provider))
}

fn tool_definitions(tools: &[Arc<dyn AgentTool>]) -> impl Iterator<Item = (&str, &str, Value)> {
    tools.iter().map(|tool| (tool.name(), tool.description(), tool.input_schema()))
}

fn object_or_empty(value: &Value) -> Value {
    if value.is_object() { value.clone() } else { json!({}) }
}

// ---------------------------------------------------------------- OpenAI ----

fn openai_body(
    config: &ModelConfig,
    system: &str,
    turns: &[Turn],
    tools: &[Arc<dyn AgentTool>],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    for turn in turns {
        match turn {
            Turn::User { text, images } if images.is_empty() => {
                messages.push(json!({ "role": "user", "content": text }))
            }
            Turn::User { text, images } => {
                let mut content = vec![json!({ "type": "text", "text": text })];
                content.extend(
                    images.iter().map(|image| json!({ "type": "image_url", "image_url": { "url": image.data_url } })),
                );
                messages.push(json!({ "role": "user", "content": content }));
            }
            Turn::Assistant { native: Some(native), .. } if native.get("role").is_some() => {
                messages.push(native.clone())
            }
            Turn::Assistant { text, tool_calls, .. } => {
                let mut message = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    message["tool_calls"] = tool_calls
                        .iter()
                        .map(|call| {
                            json!({ "id": call.id, "type": "function", "function": { "name": call.name, "arguments": call.arguments.to_string() } })
                        })
                        .collect();
                }
                messages.push(message);
            }
            Turn::ToolResults(results) => {
                for result in results {
                    messages.push(json!({ "role": "tool", "tool_call_id": result.call_id, "content": result.content }));
                }
            }
        }
    }
    let mut body = json!({ "model": config.model, "messages": messages, "stream": false });
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature);
    }
    if let Some(max_tokens) = max_tokens {
        // OpenAI's current models take `max_completion_tokens`; local
        // OpenAI-compatible servers still read `max_tokens`.
        let field = if config.provider == "openai" { "max_completion_tokens" } else { "max_tokens" };
        body[field] = json!(max_tokens);
    }
    if !tools.is_empty() {
        body["tools"] = tool_definitions(tools)
            .map(|(name, description, schema)| {
                json!({ "type": "function", "function": { "name": name, "description": description, "parameters": object_or_empty(&schema) } })
            })
            .collect();
    }
    body
}

fn openai_reply(data: &Value) -> Reply {
    let message = data.pointer("/choices/0/message").cloned().unwrap_or_else(|| json!({}));
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        // Some servers return content parts.
        Some(Value::Array(parts)) => parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect(),
        _ => String::new(),
    };
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .filter_map(|(index, call)| {
                    let function = call.get("function")?;
                    let name = function.get("name")?.as_str()?.to_string();
                    let arguments = match function.get("arguments") {
                        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or_else(|_| json!({})),
                        Some(value @ Value::Object(_)) => value.clone(),
                        _ => json!({}),
                    };
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_{index}"));
                    Some(ToolCall { id, name, arguments })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut native = Map::new();
    native.insert("role".into(), json!("assistant"));
    native.insert("content".into(), message.get("content").cloned().unwrap_or(Value::Null));
    if let Some(calls) = message.get("tool_calls") {
        native.insert("tool_calls".into(), calls.clone());
    }
    Reply { text, tool_calls, native: Value::Object(native) }
}

// ------------------------------------------------------------- Anthropic ----

fn anthropic_body(
    config: &ModelConfig,
    system: &str,
    turns: &[Turn],
    tools: &[Arc<dyn AgentTool>],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Value {
    let messages: Vec<Value> = turns
        .iter()
        .map(|turn| match turn {
            Turn::User { text, images } if images.is_empty() => json!({ "role": "user", "content": text }),
            Turn::User { text, images } => {
                let mut content = vec![json!({ "type": "text", "text": text })];
                content.extend(images.iter().map(|image| {
                    json!({ "type": "image", "source": { "type": "base64", "media_type": image.mime, "data": image.base64() } })
                }));
                json!({ "role": "user", "content": content })
            }
            Turn::Assistant { native: Some(native), .. } if native.is_array() => json!({ "role": "assistant", "content": native }),
            Turn::Assistant { text, tool_calls, .. } if tool_calls.is_empty() => json!({ "role": "assistant", "content": text }),
            Turn::Assistant { text, tool_calls, .. } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                content.extend(
                    tool_calls
                        .iter()
                        .map(|call| json!({ "type": "tool_use", "id": call.id, "name": call.name, "input": object_or_empty(&call.arguments) })),
                );
                json!({ "role": "assistant", "content": content })
            }
            Turn::ToolResults(results) => json!({
                "role": "user",
                "content": results.iter().map(|result| json!({
                    "type": "tool_result",
                    "tool_use_id": result.call_id,
                    "content": result.content,
                    "is_error": result.is_error,
                })).collect::<Vec<_>>(),
            }),
        })
        .collect();
    let mut body = json!({
        "model": config.model,
        "max_tokens": max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "system": system,
        "messages": messages,
    });
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature);
    }
    if !tools.is_empty() {
        body["tools"] = tool_definitions(tools)
            .map(|(name, description, schema)| json!({ "name": name, "description": description, "input_schema": object_or_empty(&schema) }))
            .collect();
    }
    body
}

fn anthropic_reply(data: &Value) -> Reply {
    let content = data.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let text = content
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    let tool_calls = content
        .iter()
        .enumerate()
        .filter(|(_, part)| part.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|(index, part)| {
            Some(ToolCall {
                id: part
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("toolu_{index}")),
                name: part.get("name")?.as_str()?.to_string(),
                arguments: part.get("input").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect();
    Reply { text, tool_calls, native: Value::Array(content) }
}

// ---------------------------------------------------------------- Gemini ----

fn gemini_body(
    system: &str,
    turns: &[Turn],
    tools: &[Arc<dyn AgentTool>],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Value {
    let contents: Vec<Value> = turns
        .iter()
        .map(|turn| match turn {
            Turn::User { text, images } => {
                let mut parts = vec![json!({ "text": text })];
                parts.extend(images.iter().map(|image| json!({ "inlineData": { "mimeType": image.mime, "data": image.base64() } })));
                json!({ "role": "user", "parts": parts })
            }
            // Echo the model's own parts so signatures attached to function
            // calls survive the round trip.
            Turn::Assistant { native: Some(native), .. } if native.is_array() => json!({ "role": "model", "parts": native }),
            Turn::Assistant { text, tool_calls, .. } => {
                let mut parts = Vec::new();
                if !text.is_empty() || tool_calls.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                parts.extend(tool_calls.iter().map(|call| json!({ "functionCall": { "name": call.name, "args": object_or_empty(&call.arguments) } })));
                json!({ "role": "model", "parts": parts })
            }
            Turn::ToolResults(results) => json!({
                "role": "user",
                "parts": results.iter().map(|result| {
                    let response = if result.is_error { json!({ "error": result.content }) } else { json!({ "content": result.content }) };
                    json!({ "functionResponse": { "name": result.name, "response": response } })
                }).collect::<Vec<_>>(),
            }),
        })
        .collect();
    let mut body = json!({ "systemInstruction": { "parts": [{ "text": system }] }, "contents": contents });
    let mut generation = Map::new();
    if let Some(temperature) = temperature {
        generation.insert("temperature".into(), json!(temperature));
    }
    if let Some(max_tokens) = max_tokens {
        generation.insert("maxOutputTokens".into(), json!(max_tokens));
    }
    if !generation.is_empty() {
        body["generationConfig"] = Value::Object(generation);
    }
    if !tools.is_empty() {
        let declarations: Vec<Value> = tool_definitions(tools)
            .map(|(name, description, schema)| json!({ "name": name, "description": description, "parameters": object_or_empty(&schema) }))
            .collect();
        body["tools"] = json!([{ "functionDeclarations": declarations }]);
    }
    body
}

fn gemini_reply(data: &Value) -> Reply {
    let parts = data.pointer("/candidates/0/content/parts").and_then(Value::as_array).cloned().unwrap_or_default();
    let text = parts
        .iter()
        .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    let tool_calls = parts
        .iter()
        .filter_map(|part| part.get("functionCall"))
        .enumerate()
        .filter_map(|(index, call)| {
            Some(ToolCall {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_{index}")),
                name: call.get("name")?.as_str()?.to_string(),
                arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect();
    Reply { text, tool_calls, native: Value::Array(parts) }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::http::testing::FakeTransport;

    fn config(provider: &str, endpoint: &str, key: Option<&str>) -> ModelConfig {
        ModelConfig {
            provider: provider.into(),
            endpoint: endpoint.into(),
            model: "m".into(),
            api_key: key.map(str::to_string),
        }
    }

    struct Recorder {
        calls: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl AgentTool for Recorder {
        fn name(&self) -> &str {
            "search_notes"
        }
        fn description(&self) -> &str {
            "Search notes"
        }
        fn input_schema(&self) -> Value {
            json!({ "type": "object", "properties": { "q": { "type": "string" } } })
        }
        async fn run(&self, arguments: Value) -> Result<String, String> {
            self.calls.lock().unwrap().push(arguments);
            Ok("3 notes".into())
        }
    }

    fn recorder() -> Arc<Recorder> {
        Arc::new(Recorder { calls: Mutex::new(Vec::new()) })
    }

    fn image() -> ImageInput {
        ImageInput { mime: "image/png".into(), data_url: "data:image/png;base64,AAAA".into() }
    }

    #[tokio::test]
    async fn openai_compatible_text_turn_for_ollama_uses_v1_and_no_key() {
        let http = FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "choices": [{ "message": { "content": "Hi" } }] })))
        });
        let request =
            AgentRequest { system_prompt: "sys".into(), turns: vec![Turn::user("hello")], ..Default::default() };
        let result = run(&http, &config("ollama", "http://127.0.0.1:11434", None), request).await.unwrap();
        assert_eq!(result.text, "Hi");
        let sent = http.sent();
        assert_eq!(sent[0].url, "http://127.0.0.1:11434/v1/chat/completions");
        assert_eq!(sent[0].header_value("Authorization"), None);
        let body = sent[0].json_body().unwrap();
        assert_eq!(body["messages"][0], json!({ "role": "system", "content": "sys" }));
        assert_eq!(body["messages"][1], json!({ "role": "user", "content": "hello" }));
        assert!(body.get("tools").is_none());
    }

    #[tokio::test]
    async fn openai_sends_images_as_data_urls_and_the_bearer_key() {
        let http = FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "choices": [{ "message": { "content": "A cat" } }] })))
        });
        let request = AgentRequest {
            system_prompt: "sys".into(),
            turns: vec![Turn::User { text: "what is this".into(), images: vec![image()] }],
            ..Default::default()
        };
        run(&http, &config("openai", "https://api.openai.com/v1", Some("sk-x")), request).await.unwrap();
        let sent = http.sent();
        assert_eq!(sent[0].url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(sent[0].header_value("Authorization"), Some("Bearer sk-x"));
        let content = &sent[0].json_body().unwrap()["messages"][1]["content"];
        assert_eq!(content[1], json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }));
    }

    #[tokio::test]
    async fn openai_errors_are_fixed_messages_not_provider_bodies() {
        let http = FakeTransport::new(|_| {
            Ok(HttpResponse::json(401, &json!({ "error": { "message": "Incorrect key sk-abc" } })))
        });
        let request = AgentRequest { turns: vec![Turn::user("x")], ..Default::default() };
        let error =
            run(&http, &config("openai", "https://api.openai.com/v1", Some("sk-abc")), request).await.unwrap_err();
        assert_eq!(error.0, "OpenAI rejected the saved API key. Paste the complete key again in Model settings.");
        let http =
            FakeTransport::new(|_| Ok(HttpResponse::json(500, &json!({ "error": { "message": "secret detail" } }))));
        let request = AgentRequest { turns: vec![Turn::user("x")], ..Default::default() };
        let error =
            run(&http, &config("anthropic", "https://api.anthropic.com", Some("k")), request).await.unwrap_err();
        assert_eq!(error.0, "Anthropic could not answer");
        let request = AgentRequest { turns: vec![Turn::user("x")], ..Default::default() };
        let error = run(&FakeTransport::offline(), &config("lmstudio", "http://127.0.0.1:1234/v1", None), request)
            .await
            .unwrap_err();
        assert_eq!(error.0, "The provider is unavailable.");
    }

    #[tokio::test]
    async fn anthropic_messages_shape_and_headers() {
        let http = FakeTransport::new(|_| {
            Ok(HttpResponse::json(
                200,
                &json!({ "content": [{ "type": "text", "text": "Hel" }, { "type": "text", "text": "lo" }] }),
            ))
        });
        let request = AgentRequest {
            system_prompt: "sys".into(),
            turns: vec![Turn::user("a"), Turn::assistant("b"), Turn::User { text: "c".into(), images: vec![image()] }],
            ..Default::default()
        };
        let result =
            run(&http, &config("anthropic", "https://api.anthropic.com", Some("ant-key")), request).await.unwrap();
        assert_eq!(result.text, "Hello");
        let sent = http.sent();
        assert_eq!(sent[0].url, "https://api.anthropic.com/v1/messages");
        assert_eq!(sent[0].header_value("x-api-key"), Some("ant-key"));
        assert_eq!(sent[0].header_value("anthropic-version"), Some("2023-06-01"));
        let body = sent[0].json_body().unwrap();
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(body["messages"][1], json!({ "role": "assistant", "content": "b" }));
        assert_eq!(
            body["messages"][2]["content"][1],
            json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } })
        );
    }

    #[tokio::test]
    async fn gemini_keeps_the_key_out_of_the_url() {
        let http = FakeTransport::new(|_| {
            Ok(HttpResponse::json(200, &json!({ "candidates": [{ "content": { "parts": [{ "text": "ok" }] } }] })))
        });
        let request = AgentRequest {
            system_prompt: "sys".into(),
            turns: vec![Turn::User { text: "look".into(), images: vec![image()] }],
            ..Default::default()
        };
        let mut model = config("gemini", "https://generativelanguage.googleapis.com/v1beta", Some("g-key"));
        model.model = "gemini-2.5-flash".into();
        assert_eq!(run(&http, &model, request).await.unwrap().text, "ok");
        let sent = http.sent();
        assert_eq!(
            sent[0].url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert!(!sent[0].url.contains("g-key"));
        assert_eq!(sent[0].header_value("x-goog-api-key"), Some("g-key"));
        let body = sent[0].json_body().unwrap();
        assert_eq!(body["systemInstruction"], json!({ "parts": [{ "text": "sys" }] }));
        assert_eq!(
            body["contents"][0]["parts"][1],
            json!({ "inlineData": { "mimeType": "image/png", "data": "AAAA" } })
        );
    }

    fn openai_tool_reply(round: usize) -> Value {
        if round == 0 {
            json!({ "choices": [{ "message": { "content": null, "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "search_notes", "arguments": "{\"q\":\"tax\"}" } }
            ] } }] })
        } else {
            json!({ "choices": [{ "message": { "content": "Found 3" } }] })
        }
    }

    #[tokio::test]
    async fn tool_calls_without_an_approval_are_blocked_and_never_run() {
        let round = AtomicUsize::new(0);
        let http = FakeTransport::new(move |_| {
            Ok(HttpResponse::json(200, &openai_tool_reply(round.fetch_add(1, Ordering::SeqCst))))
        });
        let tool = recorder();
        let request =
            AgentRequest { turns: vec![Turn::user("find tax notes")], tools: vec![tool.clone()], ..Default::default() };
        let result = run(&http, &config("lmstudio", "http://127.0.0.1:1234/v1", None), request).await.unwrap();
        assert_eq!(result.text, "Found 3");
        assert!(tool.calls.lock().unwrap().is_empty());
        assert_eq!(result.tool_events.len(), 1);
        assert!(result.tool_events[0].is_error);
        assert_eq!(result.tool_events[0].content, "search_notes needs an explicit Habibi approval.");
        // The refusal is sent back to the model as the tool result.
        let second = http.sent()[1].json_body().unwrap();
        let messages = second["messages"].as_array().unwrap();
        assert_eq!(messages[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(
            messages[3],
            json!({ "role": "tool", "tool_call_id": "c1", "content": "search_notes needs an explicit Habibi approval." })
        );
        assert_eq!(second["tools"][0]["function"]["name"], "search_notes");
    }

    #[tokio::test]
    async fn approved_tool_calls_run_once_per_redeemed_approval() {
        let round = AtomicUsize::new(0);
        let http = FakeTransport::new(move |_| {
            Ok(HttpResponse::json(200, &openai_tool_reply(round.fetch_add(1, Ordering::SeqCst))))
        });
        let tool = recorder();
        let redeemed = AtomicUsize::new(0);
        let redeem = |name: &str| name == "search_notes" && redeemed.fetch_add(1, Ordering::SeqCst) == 0;
        let request = AgentRequest {
            turns: vec![Turn::user("find tax notes")],
            tools: vec![tool.clone()],
            redeem_approval: Some(&redeem),
            ..Default::default()
        };
        let result = run(&http, &config("openai", "https://api.openai.com/v1", Some("k")), request).await.unwrap();
        assert_eq!(*tool.calls.lock().unwrap(), vec![json!({ "q": "tax" })]);
        assert_eq!(result.tool_events[0].content, "3 notes");
        assert!(!result.tool_events[0].is_error);
    }

    #[tokio::test]
    async fn the_tool_loop_is_bounded() {
        let http = FakeTransport::new(|_| Ok(HttpResponse::json(200, &openai_tool_reply(0))));
        let request = AgentRequest { turns: vec![Turn::user("loop")], tools: vec![recorder()], ..Default::default() };
        let result = run(&http, &config("lmstudio", "http://127.0.0.1:1234/v1", None), request).await.unwrap();
        assert_eq!(http.sent().len(), MAX_TOOL_ROUNDS);
        assert_eq!(result.tool_events.len(), MAX_TOOL_ROUNDS);
    }

    #[tokio::test]
    async fn anthropic_and_gemini_tool_rounds_echo_native_content() {
        let round = AtomicUsize::new(0);
        let http = FakeTransport::new(move |_| {
            Ok(HttpResponse::json(
                200,
                &if round.fetch_add(1, Ordering::SeqCst) == 0 {
                    json!({ "content": [{ "type": "tool_use", "id": "t1", "name": "search_notes", "input": { "q": "a" } }], "stop_reason": "tool_use" })
                } else {
                    json!({ "content": [{ "type": "text", "text": "done" }] })
                },
            ))
        });
        let request = AgentRequest { turns: vec![Turn::user("x")], tools: vec![recorder()], ..Default::default() };
        let result = run(&http, &config("anthropic", "https://api.anthropic.com", Some("k")), request).await.unwrap();
        assert_eq!(result.text, "done");
        let second = http.sent()[1].json_body().unwrap();
        assert_eq!(second["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(second["messages"][2]["content"][0]["tool_use_id"], "t1");
        assert_eq!(second["messages"][2]["content"][0]["is_error"], true);
        assert_eq!(second["tools"][0]["input_schema"]["type"], "object");

        let round = AtomicUsize::new(0);
        let http = FakeTransport::new(move |_| {
            Ok(HttpResponse::json(
                200,
                &if round.fetch_add(1, Ordering::SeqCst) == 0 {
                    json!({ "candidates": [{ "content": { "role": "model", "parts": [
                    { "functionCall": { "name": "search_notes", "args": { "q": "a" } }, "thoughtSignature": "sig" }
                ] } }] })
                } else {
                    json!({ "candidates": [{ "content": { "parts": [{ "text": "thinking", "thought": true }, { "text": "done" }] } }] })
                },
            ))
        });
        let request = AgentRequest { turns: vec![Turn::user("x")], tools: vec![recorder()], ..Default::default() };
        let result =
            run(&http, &config("gemini", "https://generativelanguage.googleapis.com/v1beta", Some("k")), request)
                .await
                .unwrap();
        assert_eq!(result.text, "done");
        let second = http.sent()[1].json_body().unwrap();
        assert_eq!(second["contents"][1]["parts"][0]["thoughtSignature"], "sig");
        assert_eq!(second["contents"][2]["parts"][0]["functionResponse"]["name"], "search_notes");
        assert_eq!(second["tools"][0]["functionDeclarations"][0]["name"], "search_notes");
    }
}
