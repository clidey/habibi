//! Test doubles shared by the module tests.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use habibi_core::services::{CompletionRequest, CompletionResult, Llm, LlmState};

/// A model that answers from a queue and records every request.
pub struct FakeLlm {
    pub state: LlmState,
    pub answers: Mutex<VecDeque<String>>,
    pub fallback: String,
    pub requests: Mutex<Vec<CompletionRequest>>,
}

impl FakeLlm {
    pub fn new(provider: Option<&str>, answers: Vec<String>) -> Self {
        Self {
            state: LlmState { configured: provider.is_some(), provider: provider.map(str::to_string) },
            answers: Mutex::new(answers.into()),
            fallback: String::new(),
            requests: Mutex::new(Vec::new()),
        }
    }

    pub fn with_fallback(mut self, fallback: &str) -> Self {
        self.fallback = fallback.into();
        self
    }

    pub fn calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

#[async_trait]
impl Llm for FakeLlm {
    async fn state(&self) -> LlmState {
        self.state.clone()
    }

    async fn complete(&self, request: CompletionRequest) -> CompletionResult {
        self.requests.lock().unwrap().push(request);
        let text = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| self.fallback.clone());
        CompletionResult { ok: true, text: Some(text), ..Default::default() }
    }
}

/// An HTTP transport answered by a closure; records every request.
pub struct FakeHttp {
    pub requests: Mutex<Vec<crate::http::HttpRequest>>,
    #[allow(clippy::type_complexity)]
    pub answer: Box<
        dyn Fn(&crate::http::HttpRequest) -> Result<crate::http::HttpResponse, crate::http::HttpError> + Send + Sync,
    >,
}

impl FakeHttp {
    pub fn new(
        answer: impl Fn(&crate::http::HttpRequest) -> Result<crate::http::HttpResponse, crate::http::HttpError>
            + Send
            + Sync
            + 'static,
    ) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { requests: Mutex::new(Vec::new()), answer: Box::new(answer) })
    }

    pub fn urls(&self) -> Vec<String> {
        self.requests.lock().unwrap().iter().map(|request| request.url.clone()).collect()
    }
}

/// A 200 JSON response.
pub fn json_response(value: serde_json::Value) -> Result<crate::http::HttpResponse, crate::http::HttpError> {
    Ok(crate::http::HttpResponse { status: 200, body: serde_json::to_vec(&value).unwrap() })
}

#[async_trait]
impl crate::http::HttpFetch for FakeHttp {
    async fn send(
        &self,
        request: crate::http::HttpRequest,
    ) -> Result<crate::http::HttpResponse, crate::http::HttpError> {
        self.requests.lock().unwrap().push(request.clone());
        (self.answer)(&request)
    }
}
