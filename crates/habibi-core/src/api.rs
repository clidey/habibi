use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// Request bodies above this are rejected, matching the Node host's limit.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Other,
}

impl Method {
    pub fn parse(value: &str) -> Self {
        match value.to_ascii_uppercase().as_str() {
            "GET" | "HEAD" => Self::Get,
            "POST" => Self::Post,
            "PUT" => Self::Put,
            "PATCH" => Self::Patch,
            "DELETE" => Self::Delete,
            _ => Self::Other,
        }
    }
}

/// One `/api/*` call from the UI.
#[derive(Debug, Clone)]
pub struct ApiRequest {
    pub method: Method,
    /// Path without the query string, e.g. `/api/mail/threads`.
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ApiRequest {
    /// Build from a method and a `path?query` string as the UI sent it.
    pub fn new(method: Method, path_and_query: &str, body: Vec<u8>) -> Self {
        let (path, query) = match path_and_query.split_once('?') {
            Some((path, query)) => (path, query),
            None => (path_and_query, ""),
        };
        let query = form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        Self { method, path: path.to_string(), query, body }
    }

    pub fn get(path_and_query: &str) -> Self {
        Self::new(Method::Get, path_and_query, Vec::new())
    }

    pub fn post(path: &str, body: &Value) -> Self {
        Self::new(Method::Post, path, serde_json::to_vec(body).unwrap_or_default())
    }

    /// True when this is `method path` exactly.
    pub fn is(&self, method: Method, path: &str) -> bool {
        self.method == method && self.path == path
    }

    /// First value of a query parameter.
    pub fn query(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }

    /// The JSON body, or the Node host's `Invalid request.` envelope.
    /// An empty body is `{}`, as it was with `readJson`.
    pub fn json(&self) -> Result<Value, ApiResponse> {
        if self.body.len() > MAX_BODY_BYTES {
            return Err(ApiResponse::invalid_request());
        }
        if self.body.iter().all(u8::is_ascii_whitespace) {
            return Ok(json!({}));
        }
        serde_json::from_slice(&self.body).map_err(|_| ApiResponse::invalid_request())
    }

    /// The JSON body decoded into `T`.
    pub fn parse<T: DeserializeOwned>(&self) -> Result<T, ApiResponse> {
        serde_json::from_value(self.json()?).map_err(|_| ApiResponse::invalid_request())
    }
}

/// What a route sends back. Mirrors the Node host: JSON envelopes are always
/// HTTP 200 with `{ ok, ... }`; only static/binary routes use other statuses.
#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ApiResponse {
    pub fn json(value: &impl Serialize) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status: 200,
                headers: vec![
                    ("Content-Type".into(), "application/json".into()),
                    ("Cache-Control".into(), "no-store".into()),
                ],
                body,
            },
            Err(_) => Self {
                status: 500,
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: br#"{"ok":false,"error":"Could not serialize local response"}"#.to_vec(),
            },
        }
    }

    /// `{ ok: false, error }` — the message must be safe to show the user and
    /// must never carry credentials or a raw provider error.
    pub fn error(message: impl Into<String>) -> Self {
        Self::json(&json!({ "ok": false, "error": message.into() }))
    }

    /// `{ ok: false }` with no message, as several Node routes returned.
    pub fn not_ok() -> Self {
        Self::json(&json!({ "ok": false }))
    }

    pub fn invalid_request() -> Self {
        Self::error("Invalid request.")
    }

    pub fn bytes(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), content_type.into())],
            body,
        }
    }

    pub fn status(status: u16, text: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "text/plain".into())],
            body: text.as_bytes().to_vec(),
        }
    }

    pub fn not_found() -> Self {
        Self::status(404, "Not found")
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Parse a JSON body back (tests and the IPC bridge use this).
    pub fn json_value(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// A group of routes. Return `None` for requests this group does not own so
/// the [`Router`] can try the next one.
#[async_trait]
pub trait Routes: Send + Sync {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse>;
}

/// Tries each route group in order; the first `Some` wins.
#[derive(Default, Clone)]
pub struct Router {
    groups: Vec<Arc<dyn Routes>>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, group: Arc<dyn Routes>) -> Self {
        self.groups.push(group);
        self
    }

    pub async fn handle(&self, request: &ApiRequest) -> ApiResponse {
        for group in &self.groups {
            if let Some(response) = group.handle(request).await {
                return response;
            }
        }
        ApiResponse::not_found()
    }
}

/// Unwrap a `Result<_, ApiResponse>` inside a route handler that returns
/// `Option<ApiResponse>`: `let body = body!(request.json());`
#[macro_export]
macro_rules! body {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(response) => return Some(response),
        }
    };
}

/// `String(value || '')` from the Node host: strings pass through, numbers and
/// booleans are stringified, everything else is empty.
pub fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(true)) => "true".into(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_and_query() {
        let request = ApiRequest::get("/api/mail/threads?provider=gmail&q=a%20b");
        assert_eq!(request.path, "/api/mail/threads");
        assert_eq!(request.query("provider"), Some("gmail"));
        assert_eq!(request.query("q"), Some("a b"));
    }

    #[test]
    fn empty_body_is_an_empty_object_and_bad_json_is_invalid() {
        assert_eq!(ApiRequest::new(Method::Post, "/x", vec![]).json().unwrap(), json!({}));
        let bad = ApiRequest::new(Method::Post, "/x", b"{".to_vec()).json().unwrap_err();
        assert_eq!(bad.json_value().unwrap(), json!({ "ok": false, "error": "Invalid request." }));
    }

    #[test]
    fn oversized_bodies_are_rejected() {
        let body = vec![b' '; MAX_BODY_BYTES + 1];
        assert!(ApiRequest::new(Method::Post, "/x", body).json().is_err());
    }

    #[test]
    fn text_matches_js_string_coercion_for_common_inputs() {
        assert_eq!(text(Some(&json!("a"))), "a");
        assert_eq!(text(Some(&json!(3))), "3");
        assert_eq!(text(Some(&json!(null))), "");
        assert_eq!(text(None), "");
    }
}
