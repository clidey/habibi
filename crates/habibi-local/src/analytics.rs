//! Server-side PostHog proxy: enforces the privacy event contract centrally.
//! Ported from `src/server/services/analytics-service.ts`.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use serde_json::{Map, Value, json};

const ALLOWED_EVENTS: &[&str] = &[
    "habibi.launcher.opened",
    "habibi.settings.opened",
    "habibi.search.submitted",
    "habibi.result.opened",
    "habibi.chat.opened",
    "habibi.chat.sent",
    "habibi.connector.connected",
    "habibi.system-action.confirmed",
    "habibi.file-investigation.started",
    "habibi.file-investigation.completed",
];

const ALLOWED_PROPERTIES: &[&str] = &[
    "surface",
    "result_type",
    "connector_type",
    "provider_type",
    "action",
    "outcome",
    "query_length_bucket",
    "query_word_count_bucket",
    "message_length_bucket",
    "attachment_count_bucket",
    "has_attachments",
    "file_candidate_count_bucket",
    "trace_step_count_bucket",
    "app_type",
    "app_version",
];

const DEFAULT_HOST: &str = "https://z.clidey.com";
const DEFAULT_KEY: &str = "phc_utRRB2N5CpkmSMTaNmkHCyVi3UzaGpBoHnGmCB4heeLe";

/// Sends one capture request. Errors are swallowed by the caller.
#[async_trait]
pub trait AnalyticsTransport: Send + Sync {
    async fn post(&self, url: &str, body: Value) -> bool;
}

struct HttpTransport {
    client: reqwest::Client,
}

#[async_trait]
impl AnalyticsTransport for HttpTransport {
    async fn post(&self, url: &str, body: Value) -> bool {
        self.client.post(url).json(&body).send().await.is_ok()
    }
}

fn safe_properties(value: Option<&Value>) -> Map<String, Value> {
    static SAFE: OnceLock<Regex> = OnceLock::new();
    let safe = SAFE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9 _+.-]+$").expect("valid pattern"));
    let mut out = Map::new();
    let Some(Value::Object(properties)) = value else {
        return out;
    };
    for (key, item) in properties {
        if !ALLOWED_PROPERTIES.contains(&key.as_str()) {
            continue;
        }
        match item {
            Value::Bool(_) => {
                out.insert(key.clone(), item.clone());
            }
            Value::String(text) if crate::util::utf16_len(text) <= 64 && safe.is_match(text) => {
                out.insert(key.clone(), item.clone());
            }
            _ => {}
        }
    }
    out
}

pub struct Analytics {
    host: String,
    api_key: String,
    transport: Arc<dyn AnalyticsTransport>,
}

impl Analytics {
    /// `HABIBI_POSTHOG_HOST` / `HABIBI_POSTHOG_KEY` override the defaults.
    pub fn from_env() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self::new(
            std::env::var("HABIBI_POSTHOG_HOST").unwrap_or_else(|_| DEFAULT_HOST.into()),
            std::env::var("HABIBI_POSTHOG_KEY").unwrap_or_else(|_| DEFAULT_KEY.into()),
            Arc::new(HttpTransport { client }),
        )
    }

    pub fn new(host: String, api_key: String, transport: Arc<dyn AnalyticsTransport>) -> Self {
        Self {
            host,
            api_key,
            transport,
        }
    }

    /// Forward one allowlisted, anonymous event. False when it was refused
    /// or could not be sent.
    pub async fn capture(&self, payload: &Value) -> bool {
        static ID: OnceLock<Regex> = OnceLock::new();
        let id = ID.get_or_init(|| Regex::new(r"(?i)^[a-f0-9-]{36}$").expect("valid pattern"));
        let event = payload.get("event").and_then(Value::as_str).unwrap_or("");
        let distinct_id = payload
            .get("distinctId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !ALLOWED_EVENTS.contains(&event) || !id.is_match(distinct_id) || self.api_key.is_empty()
        {
            return false;
        }
        let mut properties = Map::new();
        properties.insert("distinct_id".into(), json!(distinct_id));
        properties.insert("product".into(), json!("habibi"));
        properties.extend(safe_properties(payload.get("properties")));
        let body = json!({ "api_key": self.api_key, "event": event, "properties": properties });
        self.transport
            .post(
                &format!("{}/capture/", self.host.trim_end_matches('/')),
                body,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl AnalyticsTransport for Recorder {
        async fn post(&self, url: &str, body: Value) -> bool {
            self.calls.lock().unwrap().push((url.into(), body));
            true
        }
    }

    #[tokio::test]
    async fn analytics_forwards_only_allowlisted_anonymous_product_fields() {
        let recorder = Arc::new(Recorder::default());
        let analytics = Analytics::new(
            "https://analytics.example".into(),
            "test-key".into(),
            recorder.clone(),
        );
        let captured = analytics
            .capture(&json!({
                "event": "habibi.search.submitted",
                "distinctId": "5beee387-4b03-49c6-8ca0-96bd64372088",
                "properties": {
                    "query_length_bucket": "21-80",
                    "query": "passport for Alice",
                    "filename": "/Users/alice/visa.pdf",
                    "has_attachments": false,
                },
            }))
            .await;
        assert!(captured);
        let calls = recorder.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "https://analytics.example/capture/");
        assert_eq!(
            calls[0].1["properties"],
            json!({
                "distinct_id": "5beee387-4b03-49c6-8ca0-96bd64372088",
                "product": "habibi",
                "query_length_bucket": "21-80",
                "has_attachments": false,
            })
        );
    }

    #[tokio::test]
    async fn analytics_rejects_unknown_events_and_malformed_identities() {
        let recorder = Arc::new(Recorder::default());
        let analytics = Analytics::new(DEFAULT_HOST.into(), "test-key".into(), recorder.clone());
        assert!(
            !analytics
                .capture(&json!({ "event": "habibi.chat.prompt", "distinctId": "not-an-id" }))
                .await
        );
        assert!(recorder.calls.lock().unwrap().is_empty());
    }
}
