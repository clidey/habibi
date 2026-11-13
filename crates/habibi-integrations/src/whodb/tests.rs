use async_trait::async_trait;
use habibi_core::services::{McpServerInfo, McpTool, ServiceError, ServiceResult};

use super::*;
use crate::testing::{FakeHttp, FakeLlm};
use crate::whodb::store::tests::MemorySecrets;

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

struct FakeHub {
    calls: Calls,
}

struct FakeSession {
    calls: Calls,
}

#[async_trait]
impl McpSession for FakeSession {
    async fn list_tools(&mut self) -> ServiceResult<Vec<McpTool>> {
        Ok(["orgs", "projects", "apps", "ontology_describe", "ontology_query", "update"]
            .iter()
            .map(|name| McpTool { name: format!("whodb_platform_{name}"), description: String::new(), input_schema: json!({ "type": "object" }), read_only_hint: true })
            .collect())
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> ServiceResult<Value> {
        self.calls.lock().unwrap().push((name.to_string(), arguments));
        let output = match name.trim_start_matches("whodb_platform_") {
            "orgs" => json!({ "orgs": [{ "id": "acme", "name": "Acme" }] }),
            "projects" => json!({ "projects": [{ "id": "retail", "name": "Retail" }] }),
            "apps" => json!({ "data": [{ "id": "desk", "name": "Order Desk" }] }),
            "ontology_describe" => json!({ "data": { "entities": [{ "apiName": "orders" }] } }),
            "ontology_query" => json!({ "data": { "columns": ["region", "total"], "rows": [["North", 42]], "partial": true }, "warnings": ["Scan limited"] }),
            _ => return Err(ServiceError::new("write tools must never be called")),
        };
        Ok(json!({ "structuredContent": output }))
    }
}

#[async_trait]
impl McpHub for FakeHub {
    fn servers(&self) -> Vec<McpServerInfo> {
        vec![McpServerInfo { id: "whodb".into(), name: "WhoDB".into() }]
    }

    async fn open(&self, server_id: &str) -> ServiceResult<Box<dyn McpSession>> {
        if server_id != "whodb" {
            return Err(ServiceError::new("unknown"));
        }
        Ok(Box::new(FakeSession { calls: self.calls.clone() }))
    }
}

struct Fixture {
    service: WhoDb,
    calls: Calls,
    llm: Arc<FakeLlm>,
    _root: tempfile::TempDir,
}

async fn fixture(plans: Vec<Value>) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let calls: Calls = Arc::default();
    let llm = Arc::new(
        FakeLlm::new(Some("openai"), plans.iter().map(Value::to_string).collect())
            .with_fallback(&json!({ "answer": "42 rows were returned." }).to_string()),
    );
    let http = FakeHttp::new(|_| Err(crate::http::HttpError::Connect));
    let service = WhoDb::new(
        root.path().join(".habibi"),
        Arc::new(FakeHub { calls: calls.clone() }),
        llm.clone(),
        http,
        TokenStore::new(Arc::new(MemorySecrets::default())),
        Arc::new(|_| true),
        Duration::from_secs(1),
    );
    assert_eq!(service.connect(&json!({ "serverId": "whodb", "host": "https://example.test" })).await["ok"], true);
    Fixture { service, calls, llm, _root: root }
}

#[tokio::test]
async fn scopes_and_apps_come_from_read_tools_and_credentials_never_enter_status() {
    let f = fixture(vec![]).await;
    let scope = f.service.scope("acme").await;
    assert_eq!(scope["org"]["id"], "acme");
    let apps = f.service.apps(&json!({ "org": "acme", "project": "retail" })).await;
    assert_eq!(apps["apps"][0]["name"], "Order Desk");
    assert_eq!(apps["apps"][0]["projectName"], "Retail");
    assert!(f.calls.lock().unwrap().iter().all(|(name, _)| name.contains("orgs") || name.contains("projects") || name.contains("apps")));
    let status = f.service.status();
    assert_eq!(status["readOnly"], true);
    assert_eq!(status["connected"], true);
    assert!(status.get("token").is_none());
    assert_eq!(f.service.scope("other-org").await["org"], Value::Null);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = f._root.path().join(".habibi/whodb-workspace.json");
        assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn model_tool_calls_cannot_change_workspace_expand_limits_or_execute_writes() {
    let f = fixture(vec![
        json!({ "tool": "whodb_platform_ontology_query", "arguments": { "entity": "orders", "workspace": { "org": "other-org" }, "host": "https://other.test", "limit": 100000 } }),
        json!({ "answer": "WhoDB returned a partial result." }),
    ])
    .await;
    let result = f.service.ask(&json!({ "org": "acme", "project": "retail", "question": "Revenue by region" })).await;
    assert_eq!(result["ok"], true);
    let query = f.calls.lock().unwrap().iter().find(|(name, _)| name == "whodb_platform_ontology_query").cloned().unwrap();
    assert_eq!(query.1["workspace"], json!({ "host": "https://example.test", "org": "acme", "project": "retail" }));
    assert!(query.1.get("host").is_none());
    assert_eq!(query.1["limit"], 100);
    assert_eq!(result["datasets"][0]["partial"], true);
    assert_eq!(result["datasets"][0]["warnings"], json!(["Scan limited"]));
    assert_eq!(result["answer"], "Retail: WhoDB returned a partial result.\n");
    let prompt = f.llm.requests.lock().unwrap()[0].system_prompt.clone().unwrap();
    assert!(prompt.contains("whodb_platform_ontology_query"));
    assert!(!prompt.contains("whodb_platform_update") && !prompt.contains("whodb_platform_orgs"));

    let f = fixture(vec![json!({ "tool": "whodb_platform_update", "arguments": { "id": "42" } })]).await;
    let result = f.service.ask(&json!({ "org": "acme", "project": "retail", "question": "Please change an order" })).await;
    assert_eq!(result["ok"], false);
    assert!(!f.calls.lock().unwrap().iter().any(|(name, _)| name.contains("update")));
    assert_eq!(f.service.ask(&json!({ "question": "Update order 42" })).await["ok"], false);
    assert_eq!(f.service.ask(&json!({ "question": "   " })).await["error"], "Enter a question first.");
}

#[tokio::test]
async fn ontology_mode_reads_metadata_without_a_model_and_bad_connections_fail_closed() {
    let f = fixture(vec![]).await;
    let result = f.service.ask(&json!({ "org": "acme", "project": "retail", "question": "Describe ontology", "mode": "ontology" })).await;
    assert_eq!(result["ok"], true);
    assert_eq!(f.llm.calls(), 0);
    assert!(f.calls.lock().unwrap().iter().any(|(name, _)| name == "whodb_platform_ontology_describe"));
    assert_eq!(f.service.connect(&json!({ "serverId": "missing" })).await["ok"], false);
    assert_eq!(f.service.connect(&json!({ "serverId": "whodb", "host": "javascript:alert(1)" })).await["ok"], false);
    assert_eq!(f.service.connect(&json!({ "serverId": "whodb", "host": "http://example.test" })).await["error"], "Use HTTPS or an HTTP loopback URL.");
}

#[tokio::test]
async fn a_lost_sso_session_asks_the_user_to_sign_in_again() {
    let f = fixture(vec![]).await;
    f.service.config.save(json!({ "host": "https://app.whodb.com", "auth": "sso" }));
    let scope = f.service.scope("").await;
    assert_eq!(scope["code"], "WHODB_SIGN_IN_REQUIRED");
    assert_eq!(f.service.status()["auth"], "sso");
}

#[tokio::test]
async fn routes_dispatch_and_reject_malformed_bodies() {
    let f = fixture(vec![]).await;
    let status = f.service.handle(&ApiRequest::get("/api/whodb/status")).await.unwrap().json_value().unwrap();
    assert_eq!(status["servers"], json!([{ "id": "whodb", "name": "WhoDB" }]));
    let bad = ApiRequest::new(Method::Post, "/api/whodb/ask", b"{".to_vec());
    assert_eq!(f.service.handle(&bad).await.unwrap().json_value().unwrap()["error"], "Invalid request.");
    let wait = f.service.handle(&ApiRequest::post("/api/whodb/login/wait", &json!({ "id": "nope" }))).await.unwrap();
    assert_eq!(wait.json_value().unwrap()["ok"], false);
    assert!(f.service.handle(&ApiRequest::get("/api/whodb/unknown")).await.is_none());
}

#[test]
fn write_verbs_and_code_fences_are_recognized() {
    assert!(starts_with_write_verb("  DELETE everything"));
    assert!(starts_with_write_verb("update"));
    assert!(!starts_with_write_verb("updated totals by region"));
    assert!(!starts_with_write_verb("show deletes"));
    assert_eq!(strip_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    assert_eq!(strip_fences("{\"a\":1}"), "{\"a\":1}");
}
