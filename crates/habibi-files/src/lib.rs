//! File tools: `/api/file-tools/*`.
//!
//! The model may only *propose* a plan over paths the user mentioned; every
//! preview, apply and undo needs a fresh approval bound to the exact
//! selection, and every step re-verifies that the files are still the ones
//! that were scanned. PDF, image and OCR work runs in-process in
//! [`native`] (formerly the Swift `HabibiFileTools` helper).

pub mod access;
mod analysis;
pub mod contract;
pub mod daily_plan;
pub mod error;
mod execution;
pub mod native;
pub mod planner;
mod service;
mod util;

use std::sync::Arc;

use async_trait::async_trait;
use habibi_core::services::{ChatMessage, CompletionRequest, Llm};
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method, Paths, Routes};
use serde_json::{Map, Value, json};

pub use error::{FileError, FileResult};
pub use native::{LocalNativeTools, NativeFileTools};

use service::Service;

/// Request bodies above this are refused, as the Node router did.
const MAX_REQUEST_BYTES: usize = 128_000;

pub struct FileTools {
    service: Arc<Service>,
    approvals: Arc<ApprovalService>,
    llm: Arc<dyn Llm>,
}

impl FileTools {
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>, llm: Arc<dyn Llm>) -> Arc<FileTools> {
        Self::with_native(paths, approvals, llm, Arc::new(LocalNativeTools))
    }

    /// Same as [`FileTools::new`] with a substitute for the PDF/image/Trash
    /// implementation (tests use a fake).
    pub fn with_native(
        paths: Paths,
        approvals: Arc<ApprovalService>,
        llm: Arc<dyn Llm>,
        native: Arc<dyn NativeFileTools>,
    ) -> Arc<FileTools> {
        Arc::new(FileTools { service: Arc::new(Service::new(&paths, native)), approvals, llm })
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Service) -> FileResult<T> + Send + 'static,
    ) -> FileResult<T> {
        let service = self.service.clone();
        tokio::task::spawn_blocking(move || work(&service)).await.map_err(|_| FileError::Access)?
    }

    /// The model's text plus which provider and model answered.
    async fn complete(
        &self,
        system_prompt: String,
        text: String,
        failure: &str,
    ) -> FileResult<(String, Option<String>, Option<String>)> {
        let result = self
            .llm
            .complete(CompletionRequest {
                system_prompt: Some(system_prompt),
                messages: vec![ChatMessage { role: "user".into(), text }],
                ..Default::default()
            })
            .await;
        if !result.ok {
            return Err(FileError::user(failure));
        }
        Ok((result.text.unwrap_or_default(), result.provider, result.model))
    }

    async fn prepare(&self, body: Map<String, Value>) -> FileResult<Value> {
        let scan = self.blocking(move |service| service.scan(&body)).await?;
        let (proposal, provider, model) = match &scan.model_input {
            Some(input) => {
                let (text, provider, model) = self
                    .complete(
                        planner::file_planning_prompt(&scan.task, scan.cleanup),
                        input.clone(),
                        "The configured model could not prepare this plan. Check model settings and try again.",
                    )
                    .await?;
                let proposal = service::parse_model_json(&text).ok_or_else(|| {
                    FileError::user("The model returned an unreadable plan. Try a more specific request.")
                })?;
                let provider = match provider {
                    Some(provider) => provider,
                    None => self.llm.state().await.provider.unwrap_or_else(|| "configured model".into()),
                };
                (proposal, provider, model.unwrap_or_default())
            }
            None => (
                json!({ "summary": "Local scan complete. No files have changed.", "changes": [], "findings": [] }),
                "local".to_string(),
                String::new(),
            ),
        };
        self.blocking(move |service| service.plan(scan, &proposal, provider, model)).await
    }

    async fn daily(&self, request: Option<&Value>) -> FileResult<Value> {
        let request = match request {
            Some(Value::String(request)) if !request.trim().is_empty() && util::js_len(request) <= 4000 => request,
            _ => return Err(FileError::user("Describe the task and time.")),
        };
        let (text, _, _) = self
            .complete(
                daily_plan::daily_planning_prompt(chrono::Local::now()),
                request.clone(),
                "The configured model could not prepare this utility. Check model settings.",
            )
            .await?;
        let parsed = service::parse_model_json(&text)
            .ok_or_else(|| FileError::user("The model returned an unreadable utility plan."))?;
        let plan = daily_plan::normalize_daily_plan(&parsed)?;
        Ok(json!({ "ok": true, "plan": plan }))
    }

    fn approved(&self, body: &Map<String, Value>, action: &str, payload: Value) -> bool {
        let token = body.get("approvalToken").and_then(Value::as_str);
        self.approvals.consume(token, action, &payload)
    }

    async fn route(&self, request: &ApiRequest) -> FileResult<ApiResponse> {
        let path = request.path.as_str();
        if request.method == Method::Get && path.ends_with("/paths") {
            let query = util::js_slice(request.query("q").unwrap_or(""), 2000);
            let items = self.blocking(move |service| Ok(service.paths(&query))).await?;
            return Ok(ApiResponse::json(&json!({ "ok": true, "items": items })));
        }
        if request.method == Method::Get && path.ends_with("/preview") {
            let plan = request.query("plan").unwrap_or("").to_string();
            let index = util::js_number(&Value::String(request.query("index").unwrap_or("").to_string()));
            let file = self.blocking(move |service| service.preview_file(&plan, index)).await?;
            let extension = util::path_extname(&file).to_lowercase();
            let content_type = match extension.as_str() {
                ".pdf" => "application/pdf",
                ".png" => "image/png",
                ".jpg" | ".jpeg" => "image/jpeg",
                ".csv" => "text/plain; charset=utf-8",
                _ => "application/octet-stream",
            };
            let Ok(bytes) = tokio::fs::read(&file).await else { return Ok(ApiResponse::not_found()) };
            return Ok(ApiResponse::bytes(content_type, bytes)
                .with_header("Cache-Control", "no-store")
                .with_header("Content-Disposition", &format!("inline; filename=\"Preview{extension}\"")));
        }
        // The Node router also required `Content-Type: application/json`;
        // IPC requests carry no headers, so only the method is checked.
        if request.method != Method::Post {
            return Err(FileError::user("Use a JSON request."));
        }
        if request.body.len() > MAX_REQUEST_BYTES {
            return Err(FileError::user("The request is too large."));
        }
        let Value::Object(body) = serde_json::from_slice(&request.body).map_err(|_| FileError::Access)? else {
            return Err(FileError::user("Invalid file request."));
        };
        let plan_id = body.get("planId").and_then(Value::as_str).unwrap_or("").to_string();
        let value = match path {
            "/api/file-tools/daily" => self.daily(body.get("request")).await?,
            "/api/file-tools/grant" => {
                let path = body.get("path").cloned();
                let grant = self.blocking(move |service| service.grant(path.as_ref())).await?;
                json!({ "ok": true, "grant": grant })
            }
            "/api/file-tools/inspect" => {
                let grants = body.get("grants").cloned();
                let (id, entries, limited, storage) =
                    self.blocking(move |service| service.inspect(grants.as_ref())).await?;
                json!({ "ok": true, "id": id, "entries": entries, "limited": limited, "storage": storage })
            }
            "/api/file-tools/prepare" => self.prepare(body).await?,
            "/api/file-tools/preview" => {
                let payload = pick(&body, &["planId", "selected"], None);
                if !self.approved(&body, "file-tools.preview", payload) {
                    return Err(FileError::user("Confirm these exact output previews before any conversion starts."));
                }
                let selected = body.get("selected").cloned();
                self.blocking(move |service| service.preview(&plan_id, selected.as_ref())).await?
            }
            "/api/file-tools/apply" => {
                let acknowledged = body.get("cleanupAcknowledged") == Some(&Value::Bool(true));
                let payload = pick(&body, &["planId", "selected"], Some(acknowledged));
                if !self.approved(&body, "file-tools.apply", payload) {
                    return Err(FileError::user("Review the plan and approve these exact changes before applying."));
                }
                let selected = body.get("selected").cloned();
                self.blocking(move |service| service.apply(&plan_id, selected.as_ref(), acknowledged)).await?
            }
            "/api/file-tools/undo" => {
                if !self.approved(&body, "file-tools.undo", pick(&body, &["planId"], None)) {
                    return Err(FileError::user("Undo requires a fresh approval."));
                }
                self.blocking(move |service| service.undo(&plan_id)).await?
            }
            _ => {
                let mut response = ApiResponse::error("File action unavailable.");
                response.status = 404;
                return Ok(response);
            }
        };
        Ok(ApiResponse::json(&value))
    }
}

/// The approval payload re-derived from the body. Keys the body lacks are
/// left out, exactly as `JSON.stringify` drops `undefined`.
fn pick(body: &Map<String, Value>, keys: &[&str], cleanup_acknowledged: Option<bool>) -> Value {
    let mut payload = Map::new();
    for key in keys {
        if let Some(value) = body.get(*key) {
            payload.insert((*key).to_string(), value.clone());
        }
    }
    if let Some(acknowledged) = cleanup_acknowledged {
        payload.insert("cleanupAcknowledged".into(), Value::Bool(acknowledged));
    }
    Value::Object(payload)
}

#[async_trait]
impl Routes for FileTools {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        if !request.path.starts_with("/api/file-tools/") {
            return None;
        }
        Some(match self.route(request).await {
            Ok(response) => response,
            Err(error) => {
                let mut response = ApiResponse::error(error.message());
                response.status = 400;
                response
            }
        })
    }
}

#[cfg(test)]
mod tests;
