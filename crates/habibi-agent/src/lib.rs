//! Habibi's model, agent and MCP services.
//!
//! - `/api/llm/*` — provider configuration and chat ([`llm`]);
//! - `/api/agent/route` — capability routing ([`router`]);
//! - `/api/mcp/*` — local MCP servers ([`mcp`], also the [`McpHub`]);
//! - `/api/agent-skills*` — imported Codex/Claude/MCP capabilities ([`skills`]).
//!
//! The agent loop and its tool policy live in [`harness`] and [`policy`].
//! See ARCHITECTURE.md for how this crate fits the app.

use std::sync::Arc;

use async_trait::async_trait;
use habibi_core::api::text;
use habibi_core::services::{Llm, McpHub};
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method, Paths, Routes, body};
use serde_json::{Value, json};

mod browser_url;
pub mod harness;
pub mod http;
pub mod keys;
pub mod llm;
pub mod mcp;
pub mod policy;
pub mod providers;
pub mod router;
pub mod skills;
mod util;

use http::{HttpTransport, ReqwestTransport};
use keys::{KeyStore, PlatformKeyStore};
use llm::{IncomingMessage, LlmService};
use mcp::McpBridge;
use skills::{SkillImportService, TerminalLauncher};

/// What the services reach the outside world through. [`AgentServices::new`]
/// uses the real ones; tests (here and in other crates) can swap in fakes so
/// they never touch the network, the credential store or a terminal.
pub struct Backends {
    pub keys: Arc<dyn KeyStore>,
    pub http: Arc<dyn HttpTransport>,
    pub terminal: TerminalLauncher,
}

impl Default for Backends {
    fn default() -> Self {
        Self {
            keys: Arc::new(PlatformKeyStore),
            http: Arc::new(ReqwestTransport::new()),
            terminal: skills::platform_terminal(),
        }
    }
}

pub struct AgentServices {
    llm: Arc<LlmService>,
    mcp: Arc<McpBridge>,
    skills: SkillImportService,
    approvals: Arc<ApprovalService>,
}

impl AgentServices {
    pub fn new(paths: Paths, approvals: Arc<ApprovalService>) -> Arc<Self> {
        Self::with_backends(paths, approvals, Backends::default())
    }

    pub fn with_backends(paths: Paths, approvals: Arc<ApprovalService>, backends: Backends) -> Arc<Self> {
        let llm = Arc::new(LlmService::new(paths.state("llm-config.json"), backends.keys, backends.http));
        let mcp = Arc::new(McpBridge::new(paths.state("mcp-servers.json")));
        let skills = SkillImportService::new(
            paths.app_root.clone(),
            paths.state_root.clone(),
            paths.home.clone(),
            backends.terminal,
        );
        Arc::new(Self { llm, mcp, skills, approvals })
    }

    /// The configured model, for services that need a plain completion.
    pub fn llm(&self) -> Arc<dyn Llm> {
        self.llm.clone()
    }

    /// Configured local MCP servers.
    pub fn mcp(&self) -> Arc<dyn McpHub> {
        self.mcp.clone()
    }

    async fn route_assistant(&self, body: &Value) -> Value {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let llm = self.llm.clone();
        router::route(&text(body.get("text")), &text(body.get("context")), &today, |user, system| async move {
            let message = IncomingMessage { role: "user".into(), text: user, attachments: Vec::new() };
            let result = llm.complete(&[message], Some(&system), None, None).await;
            router::RouterCompletion {
                ok: result.ok,
                text: result.text,
                error: result.error,
                needs_configuration: result.needs_configuration,
            }
        })
        .await
    }

    async fn execute_skill(&self, body: &Value) -> Value {
        let id = text(body.get("id"));
        let tool_name =
            util::truthy(body.get("toolName")).then(|| body.get("toolName").map(util::js_string).unwrap_or_default());
        let tool_input = body.get("toolInput").filter(|value| !value.is_null());
        // The token is bound to this exact payload, re-derived here from the
        // request body, so a token issued for one skill call cannot authorize
        // a different one.
        let payload = json!({ "id": id, "toolName": tool_name, "toolInput": tool_input });
        let token = body.get("approvalToken").and_then(Value::as_str);
        if !self.approvals.consume(token, "agent-skill.execute", &payload) {
            return json!({ "ok": false, "error": "Running an imported skill needs explicit approval." });
        }
        self.skills.execute(&id, tool_name.as_deref(), body.get("toolInput")).await
    }
}

#[async_trait]
impl Routes for AgentServices {
    async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        let value = match (request.method, request.path.as_str()) {
            (Method::Get, "/api/llm/status") => self.llm.status().await,
            (Method::Get, "/api/llm/models") => {
                self.llm
                    .models(request.query("provider").unwrap_or(""), request.query("endpoint").unwrap_or(""), "")
                    .await
            }
            (Method::Post, "/api/llm/models") => {
                let body = body!(request.json());
                let provider = body.get("provider").and_then(Value::as_str).unwrap_or("");
                let api_key = body.get("apiKey").and_then(Value::as_str).unwrap_or("");
                self.llm.models(provider, &text(body.get("endpoint")), api_key).await
            }
            (Method::Post, "/api/llm/configure") => self.llm.configure(&body!(request.json())).await,
            (Method::Post, "/api/llm/chat") => self.llm.chat(&body!(request.json())).await,
            (Method::Post, "/api/agent/route") => self.route_assistant(&body!(request.json())).await,
            (Method::Get, "/api/mcp/servers") => self.mcp.list_json(),
            (Method::Get, "/api/mcp/tools") => self.mcp.discover(request.query("server").unwrap_or("")).await,
            (Method::Get, "/api/agent-skills") => json!({ "ok": true, "skills": self.skills.list() }),
            (Method::Post, "/api/agent-skills/preview") => {
                self.skills.preview(&text(body!(request.json()).get("id"))).await
            }
            (Method::Post, "/api/agent-skills/execute") => self.execute_skill(&body!(request.json())).await,
            _ => return None,
        };
        Some(ApiResponse::json(&value))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Mutex;

    use super::*;
    use crate::http::HttpResponse;
    use crate::http::testing::FakeTransport;
    use crate::keys::MemoryKeyStore;

    type Launches = Arc<Mutex<Vec<Vec<String>>>>;

    fn services(dir: &Path, http: Arc<FakeTransport>) -> (Arc<AgentServices>, Arc<ApprovalService>, Launches) {
        let approvals = Arc::new(ApprovalService::default());
        let launches: Launches = Arc::default();
        let recorded = launches.clone();
        let backends = Backends {
            keys: Arc::new(MemoryKeyStore::new()),
            http,
            terminal: Arc::new(move |_: &Path, _: &str, args: &[String]| {
                recorded.lock().unwrap().push(args.to_vec());
                Ok(())
            }),
        };
        let paths = Paths::new(dir, dir, dir.join("home"));
        (AgentServices::with_backends(paths, approvals.clone(), backends), approvals, launches)
    }

    async fn call(services: &AgentServices, request: ApiRequest) -> Value {
        services.handle(&request).await.expect("route is handled").json_value().unwrap()
    }

    #[tokio::test]
    async fn routes_cover_llm_status_configure_chat_and_route() {
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeTransport::new(|request: &http::HttpRequest| {
            let body = request.json_body().unwrap_or_default();
            let routing =
                body["messages"][0]["content"].as_str().is_some_and(|system| system.contains("Return ONE JSON action"));
            let content = if routing { r#"{"action":"open_folder","folder":"downloads"}"# } else { "Hello!" };
            Ok(HttpResponse::json(200, &json!({ "choices": [{ "message": { "content": content } }] })))
        }));
        let (services, _, _) = services(dir.path(), http);
        assert_eq!(call(&services, ApiRequest::get("/api/llm/status")).await["configured"], false);
        let configured =
            call(&services, ApiRequest::post("/api/llm/configure", &json!({ "provider": "lmstudio" }))).await;
        assert_eq!(configured["configured"], true);
        assert_eq!(configured["model"], "local-model");
        let chat = call(
            &services,
            ApiRequest::post("/api/llm/chat", &json!({ "messages": [{ "role": "user", "text": "hi" }] })),
        )
        .await;
        assert_eq!(
            chat,
            json!({ "ok": true, "text": "Hello!", "provider": "lmstudio", "model": "local-model", "proposal": null })
        );
        let routed = call(&services, ApiRequest::post("/api/agent/route", &json!({ "text": "open downloads" }))).await;
        assert_eq!(routed, json!({ "ok": true, "action": "open_folder", "folder": "Downloads" }));
        let invalid = services.handle(&ApiRequest::new(Method::Post, "/api/llm/chat", b"{".to_vec())).await.unwrap();
        assert_eq!(invalid.json_value().unwrap(), json!({ "ok": false, "error": "Invalid request." }));
        assert!(services.handle(&ApiRequest::get("/api/llm/chat")).await.is_none());
        assert!(services.handle(&ApiRequest::get("/api/mail/threads")).await.is_none());
    }

    #[tokio::test]
    async fn the_router_reports_an_unconfigured_model() {
        let dir = tempfile::tempdir().unwrap();
        let (services, _, _) = services(dir.path(), Arc::new(FakeTransport::offline()));
        let routed = call(&services, ApiRequest::post("/api/agent/route", &json!({ "text": "open downloads" }))).await;
        assert_eq!(routed["ok"], false);
        assert_eq!(routed["needsConfiguration"], true);
    }

    #[tokio::test]
    async fn imported_skills_run_only_with_an_approval_for_the_exact_payload() {
        let dir = tempfile::tempdir().unwrap();
        let commands = dir.path().join(".claude/commands");
        std::fs::create_dir_all(&commands).unwrap();
        std::fs::write(commands.join("ship.md"), "# Ship\nPrepare a release.").unwrap();
        let (services, approvals, launches) = services(dir.path(), Arc::new(FakeTransport::offline()));
        let listed = call(&services, ApiRequest::get("/api/agent-skills")).await;
        let id = listed["skills"][0]["id"].as_str().unwrap().to_string();
        let preview = call(&services, ApiRequest::post("/api/agent-skills/preview", &json!({ "id": id }))).await;
        assert_eq!(preview["ok"], true);

        let refused = json!({ "ok": false, "error": "Running an imported skill needs explicit approval." });
        let unapproved =
            call(&services, ApiRequest::post("/api/agent-skills/execute", &json!({ "id": id, "toolInput": "go" })))
                .await;
        assert_eq!(unapproved, refused);
        // A token for a different input does not authorize this one.
        let other = approvals.issue("agent-skill.execute", json!({ "id": id, "toolName": null, "toolInput": "other" }));
        let mismatched = call(
            &services,
            ApiRequest::post(
                "/api/agent-skills/execute",
                &json!({ "id": id, "toolInput": "go", "approvalToken": other.token }),
            ),
        )
        .await;
        assert_eq!(mismatched, refused);
        assert!(launches.lock().unwrap().is_empty());

        let approval = approvals.issue("agent-skill.execute", json!({ "id": id, "toolName": null, "toolInput": "go" }));
        let body = json!({ "id": id, "toolInput": "go", "approvalToken": approval.token });
        assert_eq!(call(&services, ApiRequest::post("/api/agent-skills/execute", &body)).await, json!({ "ok": true }));
        // Single use.
        assert_eq!(call(&services, ApiRequest::post("/api/agent-skills/execute", &body)).await, refused);
        let launches = launches.lock().unwrap();
        assert_eq!(launches.len(), 1);
        let prompt_file = launches[0].iter().find(|arg| arg.ends_with("prompt.txt")).unwrap();
        std::fs::remove_dir_all(Path::new(prompt_file).parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn mcp_routes_never_return_credentials() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".habibi")).unwrap();
        std::fs::write(
            dir.path().join(".habibi/mcp-servers.json"),
            json!({ "servers": { "db": { "transport": "stdio", "command": "/nonexistent/server", "env": { "PASSWORD": "hunter2" } } } }).to_string(),
        )
        .unwrap();
        let (services, _, _) = services(dir.path(), Arc::new(FakeTransport::offline()));
        let servers = call(&services, ApiRequest::get("/api/mcp/servers")).await;
        assert_eq!(servers, json!({ "ok": true, "servers": [{ "id": "db", "name": "db", "transport": "stdio" }] }));
        let tools = call(&services, ApiRequest::get("/api/mcp/tools?server=db")).await;
        assert_eq!(tools, json!({ "ok": false, "error": "Could not connect to the MCP server.", "tools": [] }));
        let skills = call(&services, ApiRequest::get("/api/agent-skills")).await;
        assert!(!skills.to_string().contains("hunter2"));
        assert_eq!(services.mcp().servers().len(), 1);
    }
}
