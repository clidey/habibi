//! Supported model providers, endpoint pinning and the chat intent hint.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct ProviderDefinition {
    pub label: &'static str,
    /// `local` (a process on this machine) or `external` (hosted, needs a key).
    pub kind: &'static str,
    pub endpoint: &'static str,
    pub model: &'static str,
}

impl ProviderDefinition {
    pub fn is_local(&self) -> bool {
        self.kind == "local"
    }
}

/// The `PROVIDERS` table, in the order the Node host declared it.
#[derive(Debug, Serialize)]
pub struct Providers {
    pub ollama: ProviderDefinition,
    pub lmstudio: ProviderDefinition,
    pub openai: ProviderDefinition,
    pub anthropic: ProviderDefinition,
    pub gemini: ProviderDefinition,
}

pub const PROVIDERS: Providers = Providers {
    ollama: ProviderDefinition {
        label: "Ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
        model: "llama3.2",
    },
    lmstudio: ProviderDefinition {
        label: "LM Studio",
        kind: "local",
        endpoint: "http://127.0.0.1:1234/v1",
        model: "local-model",
    },
    openai: ProviderDefinition {
        label: "OpenAI",
        kind: "external",
        endpoint: "https://api.openai.com/v1",
        model: "chat-latest",
    },
    anthropic: ProviderDefinition {
        label: "Anthropic",
        kind: "external",
        endpoint: "https://api.anthropic.com",
        model: "claude-sonnet-4-5",
    },
    gemini: ProviderDefinition {
        label: "Google Gemini",
        kind: "external",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-flash",
    },
};

pub fn provider(id: &str) -> Option<&'static ProviderDefinition> {
    match id {
        "ollama" => Some(&PROVIDERS.ollama),
        "lmstudio" => Some(&PROVIDERS.lmstudio),
        "openai" => Some(&PROVIDERS.openai),
        "anthropic" => Some(&PROVIDERS.anthropic),
        "gemini" => Some(&PROVIDERS.gemini),
        _ => None,
    }
}

pub fn providers_json() -> Value {
    serde_json::to_value(&PROVIDERS).unwrap_or(Value::Null)
}

/// Resolves the base URL to talk to a provider.
///
/// A hosted provider's endpoint is always the pinned value from [`PROVIDERS`]:
/// the request carries a stored API key, so honouring a caller-supplied
/// endpoint would let one config call redirect the key to an arbitrary host.
/// Local providers may be moved, but only to a loopback address — they are
/// meant to be another process on this machine, not a route off it.
pub fn resolve_endpoint(provider_id: &str, requested: &str) -> String {
    let Some(definition) = provider(provider_id) else { return String::new() };
    let pinned = definition.endpoint.strip_suffix('/').unwrap_or(definition.endpoint).to_string();
    if !definition.is_local() || requested.is_empty() {
        return pinned;
    }
    if let Ok(url) = url::Url::parse(requested) {
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
        if matches!(url.scheme(), "http" | "https") && loopback {
            return requested.strip_suffix('/').unwrap_or(requested).to_string();
        }
    }
    // Fall through to the pinned default.
    pinned
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Intent {
    pub kind: &'static str,
    pub label: &'static str,
    pub detail: &'static str,
}

static WHATSAPP_INTENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bwhatsapp\b|\b(?:message|text|ping)\s+(?:a\s+)?(?:person|contact|someone|them)\b").unwrap()
});
static CALENDAR_INTENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(calendar|schedule|meeting|event|book|remind)\b").unwrap());
static EMAIL_INTENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(email|gmail|mail)\b").unwrap());

/// A related draft capability the chat UI can offer under an answer.
pub fn infer_intent(text: &str) -> Option<Intent> {
    let value = text.to_lowercase();
    if WHATSAPP_INTENT.is_match(&value) {
        return Some(Intent {
            kind: "whatsapp_draft",
            label: "WhatsApp draft",
            detail: "Find the recipient, review the recent chat, then show a draft for approval.",
        });
    }
    if CALENDAR_INTENT.is_match(&value) {
        return Some(Intent {
            kind: "calendar_draft",
            label: "Calendar draft",
            detail: "Extract the time and attendees, then show an event draft for approval.",
        });
    }
    if EMAIL_INTENT.is_match(&value) {
        return Some(Intent {
            kind: "email_draft",
            label: "Email draft",
            detail: "Prepare a reply or new email for approval.",
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_endpoints_are_pinned() {
        assert_eq!(resolve_endpoint("openai", "http://attacker.example/v1"), PROVIDERS.openai.endpoint);
        assert_eq!(resolve_endpoint("anthropic", "https://attacker.example"), PROVIDERS.anthropic.endpoint);
        assert_eq!(resolve_endpoint("gemini", "http://127.0.0.1:1"), PROVIDERS.gemini.endpoint);
        assert_eq!(resolve_endpoint("nope", "http://127.0.0.1"), "");
    }

    #[test]
    fn local_endpoints_move_only_to_loopback() {
        assert_eq!(resolve_endpoint("ollama", "http://127.0.0.1:11500/"), "http://127.0.0.1:11500");
        assert_eq!(resolve_endpoint("ollama", "http://localhost:11434"), "http://localhost:11434");
        assert_eq!(resolve_endpoint("lmstudio", "http://[::1]:1234/v1"), "http://[::1]:1234/v1");
        for endpoint in [
            "http://evil.tld:11434",
            "https://attacker.example",
            "http://169.254.169.254",
            "file:///etc/passwd",
            "not-a-url",
            "http://localhost.attacker.example",
            "http://127.0.0.1@attacker.example",
        ] {
            assert_eq!(resolve_endpoint("ollama", endpoint), PROVIDERS.ollama.endpoint, "{endpoint}");
        }
    }

    #[test]
    fn intents_are_inferred_from_the_last_message() {
        assert_eq!(infer_intent("Message them on WhatsApp").unwrap().kind, "whatsapp_draft");
        assert_eq!(infer_intent("schedule a meeting").unwrap().kind, "calendar_draft");
        assert_eq!(infer_intent("reply to this email").unwrap().kind, "email_draft");
        assert_eq!(infer_intent("what is rust?"), None);
    }
}
