//! Interfaces one service uses to reach another without depending on its
//! crate. The app shell wires the concrete implementations together.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Records something the user opened so it appears in Recent.
pub trait RecentFiles: Send + Sync {
    /// Fire-and-forget; failures are swallowed like `record(...).catch(() => {})`.
    fn record(&self, target: &str);
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_configuration: bool,
    /// Which provider and model answered, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LlmState {
    pub configured: bool,
    /// Provider id such as `ollama`, `lmstudio`, `openai`, `anthropic`, `gemini`.
    pub provider: Option<String>,
}

/// The configured model, for services that need a plain completion.
#[async_trait]
pub trait Llm: Send + Sync {
    async fn state(&self) -> LlmState;
    async fn complete(&self, request: CompletionRequest) -> CompletionResult;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
    /// The server declared the tool read-only (`annotations.readOnlyHint`).
    #[serde(default)]
    pub read_only_hint: bool,
}

/// One open connection to an MCP server.
#[async_trait]
pub trait McpSession: Send {
    async fn list_tools(&mut self) -> ServiceResult<Vec<McpTool>>;
    async fn call_tool(&mut self, name: &str, arguments: Value) -> ServiceResult<Value>;
}

/// Configured local MCP servers (from Habibi's MCP config).
#[async_trait]
pub trait McpHub: Send + Sync {
    fn servers(&self) -> Vec<McpServerInfo>;
    async fn open(&self, server_id: &str) -> ServiceResult<Box<dyn McpSession>>;
}

/// Error from another service. The message must be safe to show the user.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct ServiceError(pub String);

impl ServiceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;
