//! Kubernetes (`/api/kubernetes/*`), WhoDB (`/api/whodb/*`) and WhatsApp
//! (`/api/whatsapp/*`, `/api/openwa/*`), including supervision of the OpenWA
//! Node component. See ARCHITECTURE.md.

pub mod http;
pub mod kubernetes;
mod util;
pub mod whatsapp;
pub mod whodb;

#[cfg(test)]
mod testing;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use habibi_core::services::{Llm, McpHub};
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Paths, Routes};
use serde_json::Value;

use http::{HttpFetch, ReqwestFetch};
use kubernetes::{Kubernetes, SystemKubectl};
use whatsapp::WhatsApp;
use whatsapp::openwa::OpenwaClient;
use whatsapp::runtime::{Layout, OpenwaRuntime, StatusListener};
use whodb::WhoDb;
use whodb::store::{SystemSecrets, TokenStore};

pub struct Integrations {
    kubernetes: Kubernetes,
    whodb: WhoDb,
    whatsapp: WhatsApp,
    runtime: OpenwaRuntime,
}

impl Integrations {
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>, llm: Arc<dyn Llm>, mcp: Arc<dyn McpHub>) -> Arc<Self> {
        let http: Arc<dyn HttpFetch> = Arc::new(ReqwestFetch::new());
        let opener: whodb::auth::Opener = Arc::new(|url: &str| habibi_platform::open::open_detached(url).is_ok());
        Arc::new(Self {
            kubernetes: Kubernetes::new(paths.state_root.clone(), Arc::new(SystemKubectl::new()), llm.clone()),
            whodb: WhoDb::new(
                paths.state_root.join(".habibi"),
                mcp,
                llm,
                http.clone(),
                TokenStore::new(Arc::new(SystemSecrets)),
                opener,
                Duration::from_secs(300),
            ),
            whatsapp: WhatsApp::new(
                paths.state_root.join(".habibi"),
                OpenwaClient::new(paths.state_root.clone(), http.clone()),
                approvals,
            ),
            runtime: OpenwaRuntime::new(Layout::detect(&paths), http),
        })
    }

    /// Answer a `habibiNative` bridge message this crate owns. Only
    /// `{ type: "whatsappComponent" }` is handled: it prepares and starts the
    /// OpenWA runtime and returns the final status the Swift app sent to
    /// `window.__habibiWhatsAppComponent` — `{ state: "ready", ok: true }` or
    /// `{ state: "failed", ok: false, error }`. Intermediate states go to the
    /// listener set with [`Self::set_whatsapp_component_listener`].
    pub async fn native_message(&self, message: &Value) -> Option<Value> {
        match message.get("type").and_then(Value::as_str) {
            Some("whatsappComponent") => Some(self.runtime.prepare().await),
            _ => None,
        }
    }

    /// Receive `verifying` / `downloading` (with `progress`) / `starting`
    /// states while [`Self::native_message`] runs, for delivery to
    /// `window.__habibiWhatsAppComponent?.(state)`.
    pub fn set_whatsapp_component_listener(&self, listener: Option<StatusListener>) {
        self.runtime.set_listener(listener);
    }

    /// Read the WhatsApp Desktop window via Accessibility (macOS only).
    pub async fn whatsapp_desktop_snapshot(&self) -> Value {
        whatsapp::desktop::snapshot().await
    }

    /// Stop the OpenWA runtime this process started (call on quit).
    pub async fn shutdown(&self) {
        self.runtime.shutdown().await;
    }
}

#[async_trait]
impl Routes for Integrations {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        let path = request.path.as_str();
        if path.starts_with("/api/kubernetes/") {
            self.kubernetes.handle(request).await
        } else if path.starts_with("/api/whodb/") {
            self.whodb.handle(request).await
        } else if path.starts_with("/api/whatsapp/") || path.starts_with("/api/openwa/") {
            self.whatsapp.handle(request).await
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use habibi_core::services::{McpServerInfo, McpSession, ServiceError, ServiceResult};
    use serde_json::json;

    use super::*;
    use crate::testing::FakeLlm;

    struct NoMcp;

    #[async_trait]
    impl McpHub for NoMcp {
        fn servers(&self) -> Vec<McpServerInfo> {
            Vec::new()
        }

        async fn open(&self, _: &str) -> ServiceResult<Box<dyn McpSession>> {
            Err(ServiceError::new("none"))
        }
    }

    #[tokio::test]
    async fn routes_and_native_messages_dispatch_to_their_owners() {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths::new(root.path().join("app"), root.path().join("state"), root.path());
        let integrations =
            Integrations::new(paths, Arc::new(ApprovalService::default()), Arc::new(FakeLlm::new(None, vec![])), Arc::new(NoMcp));
        let status = integrations.handle(&ApiRequest::get("/api/whodb/status")).await.unwrap().json_value().unwrap();
        assert_eq!(status["connected"], false);
        assert_eq!(status["auth"], "mcp");
        let rejected = integrations
            .handle(&ApiRequest::post("/api/kubernetes/query", &json!({ "query": "delete pod x" })))
            .await
            .unwrap();
        assert_eq!(rejected.json_value().unwrap()["ok"], false);
        // No OpenWA key exists in a fresh state root, so nothing is contacted.
        let openwa = integrations.handle(&ApiRequest::get("/api/openwa/status")).await.unwrap();
        assert_eq!(openwa.json_value().unwrap(), json!({ "ok": false }));
        assert!(integrations.handle(&ApiRequest::get("/api/mail/status")).await.is_none());
        assert_eq!(integrations.native_message(&json!({ "type": "calendarAccess" })).await, None);
        integrations.shutdown().await;
    }
}
