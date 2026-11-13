//! The one place model-provider HTTP happens. Services talk to an
//! [`HttpTransport`] so tests can answer with a local fake instead of the
//! network, and the real transport can enforce the rules every provider call
//! shares (no redirects, bounded bodies, timeouts).

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

/// Provider responses above this are refused rather than buffered.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

/// An outgoing provider request. Deliberately not `Debug`: headers carry API
/// keys and must never end up in a log line.
#[derive(Clone)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self { method: HttpMethod::Get, url: url.into(), headers: Vec::new(), body: None }
    }

    pub fn post_json(url: impl Into<String>, body: &Value) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(serde_json::to_vec(body).unwrap_or_default()),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// First value of a header (case-insensitive).
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn json_body(&self) -> Option<Value> {
        self.body.as_deref().and_then(|body| serde_json::from_slice(body).ok())
    }
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self { status, body: body.into() }
    }

    pub fn json(status: u16, body: &Value) -> Self {
        Self { status, body: serde_json::to_vec(body).unwrap_or_default() }
    }

    /// `response.ok` from `fetch`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json_value(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// The request never produced a response (connection, TLS, timeout, size).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpError;

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;
}

/// The production transport.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestTransport {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            // A pinned provider endpoint must stay pinned: reqwest only strips
            // `Authorization` on a cross-host redirect, not `x-api-key` or
            // `x-goog-api-key`, so a redirect could otherwise carry a key away.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_default();
        Self { client }
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let mut builder = match request.method {
            HttpMethod::Get => self.client.get(&request.url),
            HttpMethod::Post => self.client.post(&request.url),
        };
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let mut response = builder.send().await.map_err(|_| HttpError)?;
        let status = response.status().as_u16();
        if response.content_length().is_some_and(|length| length as usize > MAX_RESPONSE_BYTES) {
            return Err(HttpError);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| HttpError)? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(HttpError);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Mutex;

    use super::*;

    type Responder = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync>;

    /// Answers every request with `responder` and records what was sent.
    pub struct FakeTransport {
        responder: Responder,
        pub requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeTransport {
        pub fn new(
            responder: impl Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync + 'static,
        ) -> Self {
            Self { responder: Box::new(responder), requests: Mutex::new(Vec::new()) }
        }

        /// Fails every request, as if no network were available.
        pub fn offline() -> Self {
            Self::new(|_| Err(HttpError))
        }

        pub fn sent(&self) -> Vec<HttpRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HttpTransport for FakeTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            let response = (self.responder)(&request);
            self.requests.lock().unwrap().push(request);
            response
        }
    }
}
