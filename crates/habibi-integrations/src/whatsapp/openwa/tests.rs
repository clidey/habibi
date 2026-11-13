//! An in-memory OpenWA exercises the request sequence session_state(),
//! ensure_session() and force_reset() drive, including the force-kill +
//! delete + recreate sequence.

use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::http::HttpResponse;
use crate::testing::FakeHttp;

struct FakeOpenwa {
    sessions: Arc<Mutex<Vec<Value>>>,
    calls: Arc<Mutex<Vec<String>>>,
    client: OpenwaClient,
    _workspace: tempfile::TempDir,
}

impl FakeOpenwa {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn sessions(&self) -> Vec<Value> {
        self.sessions.lock().unwrap().clone()
    }

    fn called(&self, call: &str) -> bool {
        self.calls().iter().any(|item| item == call)
    }
}

fn workspace_with_key() -> tempfile::TempDir {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(workspace.path().join(".openwa/data")).unwrap();
    std::fs::write(workspace.path().join(".openwa/data/.api-key"), "test-key\n").unwrap();
    workspace
}

fn fake(initial: Vec<Value>, stale_after: Duration) -> FakeOpenwa {
    let sessions = Arc::new(Mutex::new(initial));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let next_id = Arc::new(AtomicU64::new(100));
    let (state, log) = (sessions.clone(), calls.clone());
    let http = FakeHttp::new(move |request| {
        assert_eq!(request.header_value("X-API-Key"), Some("test-key"));
        let path = request.url.trim_start_matches("http://openwa.test").to_string();
        log.lock().unwrap().push(format!("{} {path}", request.method));
        let send = |status: u16, value: Option<Value>| {
            Ok(HttpResponse { status, body: value.map(|value| value.to_string().into_bytes()).unwrap_or_default() })
        };
        let mut sessions = state.lock().unwrap();
        let parts: Vec<&str> = path.trim_start_matches("/api/sessions").split('/').collect();
        match (request.method, parts.as_slice()) {
            ("GET", [""]) => send(200, Some(Value::Array(sessions.clone()))),
            ("POST", [""]) => {
                let body: Value = serde_json::from_slice(request.body.as_deref().unwrap_or(b"{}")).unwrap();
                let created = json!({ "id": next_id.fetch_add(1, Ordering::SeqCst).to_string(), "name": body["name"], "status": "created", "engineLoaded": false });
                sessions.push(created.clone());
                send(201, Some(created))
            }
            ("POST", ["", id, "start"]) => {
                let session = sessions.iter_mut().find(|item| item["id"] == *id);
                let value = session.map(|session| {
                    session["engineLoaded"] = json!(true);
                    session.clone()
                });
                send(200, Some(value.unwrap_or_else(|| json!({}))))
            }
            ("POST", ["", _, "force-kill"]) => send(200, Some(json!({}))),
            ("DELETE", ["", id]) => {
                sessions.retain(|item| item["id"] != *id);
                send(204, None)
            }
            _ => send(404, Some(json!({ "error": "not found" }))),
        }
    });
    let workspace = workspace_with_key();
    let client = OpenwaClient::with_options(workspace.path().to_path_buf(), http, "http://openwa.test", stale_after);
    FakeOpenwa { sessions, calls, client, _workspace: workspace }
}

fn session(id: &str, status: &str, engine_loaded: bool) -> Value {
    json!({ "id": id, "name": "habibi", "status": status, "engineLoaded": engine_loaded })
}

async fn pause() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}

#[tokio::test]
async fn a_missing_api_key_is_reported_plainly_without_the_key_path() {
    let workspace = tempfile::tempdir().unwrap();
    let http = FakeHttp::new(|_| panic!("no request may be sent without a key"));
    let client = OpenwaClient::with_options(workspace.path().to_path_buf(), http, "http://openwa.test", Duration::from_secs(45));
    let error = client.get("/api/sessions").await.unwrap_err();
    assert_eq!(error, "WhatsApp gateway is not set up. See the README for how to run OpenWA.");
    assert!(!error.contains(&workspace.path().display().to_string()));
}

#[tokio::test]
async fn a_key_with_an_unreachable_gateway_is_reported_as_not_running() {
    let workspace = workspace_with_key();
    let http = FakeHttp::new(|_| Err(HttpError::Connect));
    let client = OpenwaClient::with_options(workspace.path().to_path_buf(), http, "http://openwa.test", Duration::from_secs(45));
    assert_eq!(
        client.get("/api/sessions").await.unwrap_err(),
        "WhatsApp gateway is not running. See the README for how to start OpenWA."
    );
}

#[tokio::test]
async fn a_session_stuck_in_created_past_the_threshold_is_force_killed_deleted_and_replaced() {
    let openwa = fake(vec![session("1", "created", false)], Duration::from_millis(10));
    let first = openwa.client.session_state().await.unwrap();
    assert_eq!(first["session"]["id"], "1", "an unstale session must be returned as-is, not healed on first sight");
    assert!(!openwa.calls().iter().any(|call| call.contains("force-kill")));
    pause().await;
    let second = openwa.client.session_state().await.unwrap();
    assert_ne!(second["session"]["id"], "1", "the stuck session must be replaced, not returned again");
    assert_eq!(second["session"]["status"], "created");
    assert!(openwa.called("POST /api/sessions/1/force-kill"));
    assert!(openwa.called("DELETE /api/sessions/1"));
    assert!(!openwa.sessions().iter().any(|item| item["id"] == "1"));
}

#[tokio::test]
async fn a_disconnected_session_is_never_auto_healed_even_past_the_threshold() {
    let openwa = fake(vec![session("1", "disconnected", true)], Duration::from_millis(10));
    openwa.client.session_state().await.unwrap();
    pause().await;
    let second = openwa.client.session_state().await.unwrap();
    assert_eq!(second["session"]["id"], "1");
    assert!(!openwa.calls().iter().any(|call| call.contains("force-kill")));
}

#[tokio::test]
async fn a_session_making_progress_resets_the_staleness_timer() {
    let openwa = fake(vec![session("1", "created", false)], Duration::from_millis(10));
    openwa.client.session_state().await.unwrap();
    openwa.sessions.lock().unwrap()[0]["status"] = json!("qr_ready");
    pause().await;
    assert_eq!(openwa.client.session_state().await.unwrap()["session"]["id"], "1");
    // Regressing to a healable status restarts the timer rather than counting
    // from the original observation.
    openwa.sessions.lock().unwrap()[0]["status"] = json!("created");
    assert_eq!(openwa.client.session_state().await.unwrap()["session"]["id"], "1");
    assert!(!openwa.calls().iter().any(|call| call.contains("force-kill")));
}

#[tokio::test]
async fn ensure_session_heals_a_stuck_session_the_same_way() {
    let openwa = fake(vec![session("1", "failed", true)], Duration::from_millis(10));
    openwa.client.ensure_session().await.unwrap();
    pause().await;
    openwa.client.ensure_session().await.unwrap();
    assert!(openwa.called("POST /api/sessions/1/force-kill"));
    assert!(!openwa.sessions().iter().any(|item| item["id"] == "1"));
    assert!(openwa.sessions().iter().any(|item| item["name"] == "habibi"));
}

#[tokio::test]
async fn a_linked_disconnected_session_gets_its_engine_restarted_never_destroyed() {
    let linked = json!({ "id": "1", "name": "habibi", "status": "disconnected", "phone": "447426315115", "pushName": "Anguel H", "engineLoaded": false });
    let openwa = fake(vec![linked], Duration::from_millis(10));
    let state = openwa.client.session_state().await.unwrap();
    assert_eq!(state["session"]["id"], "1");
    assert_eq!(state["session"]["phone"], "447426315115");
    assert!(!openwa.calls().iter().any(|call| call.contains("force-kill")));
    assert!(openwa.called("POST /api/sessions/1/start"));
    assert_eq!(openwa.sessions()[0]["engineLoaded"], true);
}

#[tokio::test]
async fn restarting_a_disconnected_engine_is_throttled() {
    let openwa = fake(vec![session("1", "disconnected", false)], Duration::from_millis(10));
    openwa.client.session_state().await.unwrap();
    openwa.sessions.lock().unwrap()[0]["engineLoaded"] = json!(false);
    openwa.client.session_state().await.unwrap();
    assert_eq!(openwa.calls().iter().filter(|call| *call == "POST /api/sessions/1/start").count(), 1);
}

#[tokio::test]
async fn force_reset_replaces_a_session_immediately() {
    let openwa = fake(vec![session("1", "disconnected", false)], Duration::from_secs(60));
    openwa.client.force_reset().await.unwrap();
    assert!(openwa.called("POST /api/sessions/1/force-kill"));
    assert!(openwa.called("DELETE /api/sessions/1"));
    assert!(!openwa.sessions().iter().any(|item| item["id"] == "1"));
    assert!(openwa.sessions().iter().any(|item| item["name"] == "habibi"));
}

#[tokio::test]
async fn force_reset_clears_staleness_so_the_fresh_session_is_not_re_healed() {
    let openwa = fake(vec![session("1", "created", false)], Duration::from_millis(10));
    openwa.client.session_state().await.unwrap();
    pause().await;
    openwa.client.force_reset().await.unwrap();
    assert_eq!(openwa.calls().iter().filter(|call| *call == "POST /api/sessions/1/force-kill").count(), 1);
    let state = openwa.client.session_state().await.unwrap();
    assert_ne!(state["session"]["id"], "1");
    assert_eq!(openwa.calls().iter().filter(|call| call.contains("force-kill")).count(), 1);
}
