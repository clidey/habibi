//! Builds every Habibi service and routes UI requests to them.
//!
//! The Tauri shell owns exactly one [`Server`]. It forwards each `/api/*`
//! request to [`Server::handle`] and each backend-owned native-bridge message
//! to [`Server::native_message`].

use std::sync::Arc;

use habibi_agent::AgentServices;
use habibi_calendar::CalendarService;
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Paths, Router};
use habibi_files::FileTools;
use habibi_integrations::Integrations;
use habibi_local::LocalServices;
use habibi_mail::MailService;
use serde_json::{Value, json};

pub struct Server {
    pub paths: Paths,
    pub approvals: Arc<ApprovalService>,
    router: Router,
    calendar: Arc<CalendarService>,
    integrations: Arc<Integrations>,
}

/// Delivers a value to a `window.__habibi…` callback in the launcher, for
/// services that report progress after their reply (the WhatsApp component).
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

impl Server {
    /// Build every service. Call from inside the async runtime so services
    /// that start background work (the file index watcher) can attach to it.
    pub fn new(paths: Paths) -> Arc<Self> {
        let approvals = Arc::new(ApprovalService::default());
        let agent = AgentServices::new(paths.clone(), approvals.clone());
        let llm = agent.llm();
        let local = LocalServices::new(paths.clone(), approvals.clone(), llm.clone());
        let mail = MailService::new(paths.clone(), approvals.clone(), local.recent(), llm.clone());
        let files = FileTools::new(paths.clone(), approvals.clone(), llm.clone());
        let calendar = CalendarService::new(paths.clone(), approvals.clone());
        let integrations = Integrations::new(paths.clone(), approvals.clone(), llm.clone(), agent.mcp());

        // Route groups own disjoint path prefixes; the general local routes go
        // last so a more specific service always answers its own paths.
        let router = Router::new()
            .with(files)
            .with(calendar.clone())
            .with(mail)
            .with(integrations.clone())
            .with(agent)
            .with(local);
        Arc::new(Self { paths, approvals, router, calendar, integrations })
    }

    /// Route one `/api/*` request. Unknown routes are a plain 404.
    pub async fn handle(&self, request: &ApiRequest) -> ApiResponse {
        self.router.handle(request).await
    }

    /// Answer a `habibiNative` bridge message that a backend service owns
    /// (calendar access/events, `dailyUtility` `reminders.*`, the WhatsApp
    /// component, contacts). Returns the reply object the Swift app produced,
    /// or `None` when no backend service owns the message.
    pub async fn native_message(&self, message: &Value) -> Option<Value> {
        if message.get("type").and_then(Value::as_str) == Some("contacts") {
            return Some(contacts_reply().await);
        }
        if let Some(reply) = self.calendar.native_message(message).await {
            return Some(reply);
        }
        self.integrations.native_message(message).await
    }

    /// Where services push progress the UI shows before the final reply.
    pub fn set_event_sink(&self, sink: Option<EventSink>) {
        self.integrations.set_whatsapp_component_listener(sink.map(|sink| {
            Arc::new(move |state: Value| sink("__habibiWhatsAppComponent", state)) as Arc<dyn Fn(Value) + Send + Sync>
        }));
    }

    /// Stop child processes (the OpenWA runtime) before the app exits.
    pub async fn shutdown(&self) {
        self.integrations.shutdown().await;
    }
}

/// The `contacts` reply the Swift app sent to `__habibiNativeContacts`.
async fn contacts_reply() -> Value {
    use habibi_platform::contacts::{self, Access};
    let mut access = contacts::access();
    if access == Access::NotDetermined {
        let _ = tokio::task::spawn_blocking(contacts::request_access).await;
        access = contacts::access();
    }
    let reason = match access {
        Access::Granted => None,
        Access::NotDetermined => Some("notDetermined"),
        Access::Denied => Some("denied"),
        Access::Unavailable => Some("unavailable"),
    };
    if let Some(reason) = reason {
        return json!({ "ok": false, "contacts": [], "reason": reason });
    }
    let found = tokio::task::spawn_blocking(contacts::read).await.unwrap_or_default();
    json!({ "ok": true, "contacts": found })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> (tempfile::TempDir, Arc<Server>) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let app_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let paths = Paths::new(app_root, dir.path().join("state"), home);
        (dir, Server::new(paths))
    }

    #[tokio::test]
    async fn every_service_answers_its_own_routes() {
        let (_dir, server) = server();
        for path in ["/api/llm/status", "/api/mail/status", "/api/skills", "/api/calendar/accounts", "/api/file-tools/paths", "/api/whodb/status"] {
            let response = server.handle(&ApiRequest::get(path)).await;
            assert_eq!(response.status, 200, "{path}");
            assert!(response.json_value().is_some(), "{path} returns JSON");
        }
        assert_eq!(server.handle(&ApiRequest::get("/api/nope")).await.status, 404);
    }

    #[tokio::test]
    async fn approvals_issued_by_the_route_are_consumed_by_services() {
        let (_dir, server) = server();
        let issued = server
            .handle(&ApiRequest::post("/api/approvals", &json!({ "action": "system.lock", "payload": { "action": "lock" } })))
            .await
            .json_value()
            .unwrap();
        let token = issued["approval"]["token"].as_str().unwrap();
        assert!(server.approvals.consume(Some(token), "system.lock", &json!({ "action": "lock" })));
    }
}
