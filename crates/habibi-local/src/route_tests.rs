//! Route behaviour with a fake desktop: nothing is opened, launched, locked
//! or killed.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method, Paths, Routes};
use habibi_platform::apps::App;
use habibi_platform::processes::{ProcessInfo, RunningApp};
use habibi_platform::system::SystemAction;
use habibi_platform::{PlatformError, PlatformResult};
use serde_json::{Value, json};

use crate::LocalServices;
use crate::analytics::{Analytics, AnalyticsTransport};
use crate::desktop::Desktop;
use crate::investigate::tests::FakeLlm;
use crate::search_index::{IndexOptions, LocalSearchIndex};

#[derive(Default)]
struct FakeDesktop {
    calls: Mutex<Vec<String>>,
    open_succeeds: bool,
    processes: Vec<ProcessInfo>,
    running: Vec<RunningApp>,
}

impl FakeDesktop {
    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

impl Desktop for FakeDesktop {
    fn open_detached(&self, target: &str) -> bool {
        self.log(format!("open {target}"));
        true
    }
    fn open_and_wait(&self, target: &str) -> bool {
        self.log(format!("open-wait {target}"));
        self.open_succeeds
    }
    fn discover_apps(&self) -> Vec<App> {
        vec![App {
            name: "Safari".into(),
            path: "/Applications/Safari.app".into(),
            executable: None,
        }]
    }
    fn allowed_app(&self, path: &str) -> Option<PathBuf> {
        (path == "/Applications/Safari.app").then(|| PathBuf::from(path))
    }
    fn launch_app(&self, app: &Path) -> bool {
        self.log(format!("launch {}", app.display()));
        true
    }
    fn app_icon(&self, _app: &Path) -> Option<Vec<u8>> {
        Some(b"\x89PNG icon".to_vec())
    }
    fn processes(&self) -> Vec<ProcessInfo> {
        self.processes.clone()
    }
    fn running_apps(&self, _apps: &[App], _processes: &[ProcessInfo]) -> Vec<RunningApp> {
        self.running.clone()
    }
    fn working_directory(&self, pid: u32) -> Option<PathBuf> {
        Some(PathBuf::from(format!("/work/{pid}")))
    }
    fn terminate(&self, pid: u32, force: bool) -> bool {
        self.log(format!("terminate {pid} {force}"));
        true
    }
    fn system_action(&self, action: SystemAction) -> PlatformResult<()> {
        self.log(format!("system {}", action.name()));
        if action == SystemAction::EmptyTrash {
            Err(PlatformError::Unsupported)
        } else {
            Ok(())
        }
    }
    fn open_applications(&self) -> PlatformResult<()> {
        self.log("applications".into());
        Ok(())
    }
    fn open_settings(&self) -> PlatformResult<()> {
        self.log("settings".into());
        Ok(())
    }
    fn preview_file(&self, path: &Path) -> PlatformResult<()> {
        self.log(format!("preview {}", path.display()));
        Ok(())
    }
    fn quick_look_close(&self) -> bool {
        false
    }
    fn quick_look_open(&self, path: &Path) -> PlatformResult<()> {
        self.log(format!("quicklook {}", path.display()));
        Ok(())
    }
    fn run_in_terminal(&self, cwd: &Path, program: &str, args: &[String]) -> PlatformResult<()> {
        self.log(format!(
            "terminal {} {program} {}",
            cwd.display(),
            args.join(" ")
        ));
        Ok(())
    }
}

struct NoNetwork;

#[async_trait]
impl AnalyticsTransport for NoNetwork {
    async fn post(&self, _url: &str, _body: Value) -> bool {
        false
    }
}

struct Harness {
    _root: tempfile::TempDir,
    home: PathBuf,
    services: Arc<LocalServices>,
    desktop: Arc<FakeDesktop>,
    approvals: Arc<ApprovalService>,
}

fn harness_with(desktop: FakeDesktop, llm: FakeLlm) -> Harness {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir_all(home.join("Documents")).unwrap();
    let app_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let paths = Paths::new(app_root, root.path().join("state"), &home);
    let approvals = Arc::new(ApprovalService::default());
    let desktop = Arc::new(desktop);
    let options = IndexOptions {
        roots: vec![home.join("Documents")],
        max_entries: 1000,
        max_directories: 100,
        max_depth: 8,
        watch: false,
    };
    let search = LocalSearchIndex::new(&home, options);
    let analytics = Arc::new(Analytics::new(
        "https://analytics.invalid".into(),
        "k".into(),
        Arc::new(NoNetwork),
    ));
    let services = LocalServices::build(
        paths,
        approvals.clone(),
        Arc::new(llm),
        desktop.clone(),
        analytics,
        search,
    );
    Harness {
        _root: root,
        home,
        services,
        desktop,
        approvals,
    }
}

fn harness() -> Harness {
    harness_with(
        FakeDesktop {
            open_succeeds: true,
            ..Default::default()
        },
        FakeLlm::new(None, &[]),
    )
}

impl Harness {
    async fn post(&self, path: &str, body: Value) -> Value {
        self.call(ApiRequest::post(path, &body))
            .await
            .json_value()
            .unwrap()
    }

    async fn get(&self, path: &str) -> ApiResponse {
        self.call(ApiRequest::get(path)).await
    }

    async fn call(&self, request: ApiRequest) -> ApiResponse {
        self.services.handle(&request).await.expect("route handled")
    }

    fn calls(&self) -> Vec<String> {
        self.desktop.calls.lock().unwrap().clone()
    }

    fn token(&self, action: &str, payload: Value) -> String {
        self.approvals.issue(action, payload).token
    }
}

#[tokio::test]
async fn approvals_are_issued_only_for_known_actions_and_bound_to_their_payload() {
    let h = harness();
    let issued = h
        .post(
            "/api/approvals",
            json!({ "action": "browser.open", "payload": { "url": "https://clidey.com/" } }),
        )
        .await;
    assert_eq!(issued["ok"], true);
    assert_eq!(issued["approval"]["action"], "browser.open");
    assert!(issued["approval"]["expiresAt"].as_u64().is_some());
    let token = issued["approval"]["token"].as_str().unwrap();
    assert!(h.approvals.consume(
        Some(token),
        "browser.open",
        &json!({ "url": "https://clidey.com/" })
    ));
    assert_eq!(
        h.post("/api/approvals", json!({ "action": "shell.exec" }))
            .await,
        json!({ "ok": false, "error": "Unsupported approval action" })
    );
    let bad = h
        .call(ApiRequest::new(
            Method::Post,
            "/api/approvals",
            b"{".to_vec(),
        ))
        .await;
    assert_eq!(bad.json_value().unwrap()["error"], "Invalid request.");
}

#[tokio::test]
async fn browser_opening_requires_a_fresh_approval_bound_to_the_exact_normalized_destination() {
    let h = harness();
    let url = "https://clidey.com/";
    assert_eq!(
        h.post("/api/browser/open", json!({ "url": url })).await["ok"],
        false
    );
    let wrong = h.token("browser.open", json!({ "url": "https://other.test/" }));
    assert_eq!(
        h.post(
            "/api/browser/open",
            json!({ "url": url, "approvalToken": wrong })
        )
        .await["ok"],
        false
    );
    assert_eq!(
        h.post(
            "/api/browser/open",
            json!({ "url": "https://other.test/", "approvalToken": wrong })
        )
        .await["ok"],
        false
    );
    let approved = h.token("browser.open", json!({ "url": url }));
    assert_eq!(
        h.post(
            "/api/browser/open",
            json!({ "url": url, "approvalToken": approved })
        )
        .await,
        json!({ "ok": true })
    );
    assert_eq!(
        h.post(
            "/api/browser/open",
            json!({ "url": url, "approvalToken": approved })
        )
        .await["ok"],
        false
    );
    let script = h.token("browser.open", json!({ "url": "javascript:alert(1)" }));
    let refused = h
        .post(
            "/api/browser/open",
            json!({ "url": "javascript:alert(1)", "approvalToken": script }),
        )
        .await;
    assert_eq!(
        refused["error"],
        "Use an HTTP or HTTPS website address without embedded credentials."
    );
    assert_eq!(h.calls(), [format!("open-wait {url}")]);
}

#[tokio::test]
async fn browser_launch_failures_are_truthful_and_hide_raw_process_errors() {
    let h = harness_with(FakeDesktop::default(), FakeLlm::new(None, &[]));
    let url = "https://clidey.com/";
    let token = h.token("browser.open", json!({ "url": url }));
    assert_eq!(
        h.post(
            "/api/browser/open",
            json!({ "url": url, "approvalToken": token })
        )
        .await,
        json!({ "ok": false, "error": "The website could not be opened." })
    );
}

#[tokio::test]
async fn open_url_only_allows_the_fixed_https_destinations() {
    let h = harness();
    assert_eq!(
        h.post(
            "/api/open-url",
            json!({ "url": "https://www.google.com/search?q=x" })
        )
        .await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/open-url", json!({ "url": "https://airbnb.co.uk/s" }))
            .await["ok"],
        true
    );
    for url in [
        "http://google.com/",
        "https://google.com.evil.test/",
        "https://evilgoogle.com/",
        "file:///etc/passwd",
        "nonsense",
    ] {
        assert_eq!(
            h.post("/api/open-url", json!({ "url": url })).await["ok"],
            false,
            "{url}"
        );
    }
    assert_eq!(h.calls().len(), 2);
}

#[tokio::test]
async fn system_actions_need_an_approval_for_that_exact_action() {
    let h = harness();
    assert_eq!(
        h.post("/api/system/action", json!({ "action": "settings" }))
            .await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/system/action", json!({ "action": "format" }))
            .await["error"],
        "Unknown system action"
    );
    assert_eq!(
        h.post("/api/system/action", json!({ "action": "lock" }))
            .await["error"],
        "This system action needs explicit approval."
    );
    let wrong = h.token("system.sleep", json!({ "action": "lock" }));
    assert_eq!(
        h.post(
            "/api/system/action",
            json!({ "action": "lock", "approvalToken": wrong })
        )
        .await["ok"],
        false
    );
    let token = h.token("system.lock", json!({ "action": "lock" }));
    assert_eq!(
        h.post(
            "/api/system/action",
            json!({ "action": "lock", "approvalToken": token })
        )
        .await,
        json!({ "ok": true })
    );
    let token = h.token("system.emptyTrash", json!({ "action": "emptyTrash" }));
    let unsupported = h
        .post(
            "/api/system/action",
            json!({ "action": "emptyTrash", "approvalToken": token }),
        )
        .await;
    assert_eq!(
        unsupported["error"],
        "This is not available on this platform."
    );
    assert_eq!(h.calls(), ["settings", "system lock", "system emptyTrash"]);
}

#[tokio::test]
async fn quitting_apps_needs_approval_and_a_still_running_exact_target() {
    let running = vec![RunningApp {
        name: "Safari".into(),
        path: "/Applications/Safari.app".into(),
        pids: vec![10, 11],
        cpu: 1.5,
        memory_mb: 20,
    }];
    let h = harness_with(
        FakeDesktop {
            running,
            ..Default::default()
        },
        FakeLlm::new(None, &[]),
    );
    let listed = h.get("/api/running-apps").await.json_value().unwrap();
    assert_eq!(
        listed["apps"][0],
        json!({ "name": "Safari", "path": "/Applications/Safari.app", "pids": [10, 11], "cpu": 1.5, "memoryMb": 20 })
    );
    assert_eq!(
        h.post(
            "/api/running-apps/action",
            json!({ "mode": "quit", "app": "Safari", "pids": [1] })
        )
        .await["error"],
        "Choose an open application first."
    );
    let payload = json!({ "app": "Safari", "mode": "quit", "pids": [11, 10] });
    let request = json!({ "mode": "quit", "app": "Safari", "pids": [11, "10", 11, 1] });
    assert_eq!(
        h.post("/api/running-apps/action", request.clone()).await["error"],
        "Quitting an app needs explicit approval."
    );
    let mut approved = request.clone();
    approved["approvalToken"] = json!(h.token("running-app.quit", payload.clone()));
    assert_eq!(
        h.post("/api/running-apps/action", approved).await,
        json!({ "ok": true, "stopped": 2 })
    );
    let stale = json!({ "mode": "force", "app": "Safari", "pids": [10] });
    let mut approved = stale.clone();
    approved["approvalToken"] = json!(h.token(
        "running-app.force",
        json!({ "app": "Safari", "mode": "force", "pids": [10] })
    ));
    assert_eq!(
        h.post("/api/running-apps/action", approved).await["error"],
        "That app is no longer running. Refresh the list and try again."
    );
    assert_eq!(h.calls(), ["terminate 11 false", "terminate 10 false"]);
}

#[tokio::test]
async fn files_folders_and_previews_stay_inside_home() {
    let h = harness();
    let doc = h.home.join("Documents").join("plan.txt");
    std::fs::write(&doc, "hello").unwrap();
    let doc_text = doc.to_string_lossy().into_owned();
    assert_eq!(
        h.post("/api/open-file", json!({ "path": doc_text })).await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/open-file", json!({ "path": "/etc/hosts" }))
            .await["ok"],
        false
    );
    assert_eq!(
        h.post(
            "/api/preview-file",
            json!({ "path": format!("{}/../x", h.home.display()) })
        )
        .await["ok"],
        false
    );
    assert_eq!(
        h.post("/api/quick-look", json!({ "path": doc_text })).await,
        json!({ "ok": true, "state": "opened" })
    );
    assert_eq!(
        h.post("/api/open-folder", json!({ "folder": "Documents" }))
            .await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/open-folder", json!({ "folder": "Movies" }))
            .await["ok"],
        false
    );
    assert_eq!(
        h.post("/api/open-folder", json!({ "folder": "../../etc" }))
            .await["ok"],
        false
    );
    let file = h.get(&format!("/api/file?path={}", form(&doc_text))).await;
    assert_eq!(file.status, 200);
    assert_eq!(file.body, b"hello");
    assert_eq!(
        file.header("Content-Type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(
        file.header("Content-Disposition"),
        Some("inline; filename=\"plan.txt\"")
    );
    assert_eq!(h.get("/api/file?path=/etc/hosts").await.status, 404);
    assert_eq!(
        h.get(&format!(
            "/api/file?path={}",
            form(&h.home.join("Documents").to_string_lossy())
        ))
        .await
        .status,
        404
    );
    let calls = h.calls();
    assert_eq!(calls[0], format!("open {doc_text}"));
    assert_eq!(calls[1], format!("quicklook {doc_text}"));
    assert!(calls[2].starts_with("open-wait "));
}

fn form(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[tokio::test]
async fn apps_are_searched_launched_and_iconed_only_from_the_allowlist() {
    let h = harness();
    let apps = h.get("/api/apps?q=saf").await.json_value().unwrap();
    assert_eq!(
        apps,
        json!({ "ok": true, "apps": [{ "path": "/Applications/Safari.app", "name": "Safari" }] })
    );
    assert_eq!(
        h.post(
            "/api/open-app",
            json!({ "path": "/Applications/Safari.app" })
        )
        .await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/open-app", json!({ "path": "/tmp/Evil.app" }))
            .await["ok"],
        false
    );
    let icon = h.get("/api/app-icon?path=/Applications/Safari.app").await;
    assert_eq!(icon.header("Content-Type"), Some("image/png"));
    assert_eq!(icon.header("Cache-Control"), Some("private, max-age=86400"));
    assert_eq!(h.get("/api/app-icon?path=/tmp/Evil.app").await.status, 404);
    assert_eq!(h.calls(), ["launch /Applications/Safari.app"]);
}

#[tokio::test]
async fn agents_are_listed_from_processes_and_resumed_in_a_terminal() {
    let process = |pid, command: &str| ProcessInfo {
        pid,
        cpu: 0.0,
        memory_bytes: 0,
        command: command.into(),
        exe: None,
        run_time: 65,
    };
    let desktop = FakeDesktop {
        processes: vec![
            process(5, "codex resume"),
            process(6, "/bin/zsh"),
            process(7, "node /x/claude-code/cli.js"),
            process(8, "claudette"),
            process(9, "claude --resume"),
        ],
        ..Default::default()
    };
    let h = harness_with(desktop, FakeLlm::new(None, &[]));
    let agents = h.get("/api/agents").await.json_value().unwrap();
    assert_eq!(
        agents["agents"][0],
        json!({ "pid": "5", "elapsed": "01:05", "command": "codex resume", "cwd": "/work/5" })
    );
    assert_eq!(agents["agents"][1]["pid"], "9");
    assert_eq!(agents["agents"].as_array().unwrap().len(), 2);
    let project = h.home.join("Documents");
    let project_text = project.to_string_lossy().into_owned();
    assert_eq!(
        h.post(
            "/api/agents/resume",
            json!({ "cwd": project_text, "kind": "claude" })
        )
        .await["ok"],
        true
    );
    assert_eq!(
        h.post("/api/agents/resume", json!({ "cwd": "/etc" })).await["ok"],
        false
    );
    assert_eq!(
        h.post("/api/agents/open-project", json!({ "cwd": project_text }))
            .await["ok"],
        true
    );
    assert_eq!(
        h.calls(),
        [
            format!("terminal {project_text} claude --resume"),
            format!("open {project_text}")
        ]
    );
}

#[tokio::test]
async fn skills_list_built_ins_and_the_kubernetes_plugin_sorted_by_name() {
    let h = harness();
    let skills = h.get("/api/skills").await.json_value().unwrap();
    let names: Vec<&str> = skills["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|skill| skill["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Kubernetes"));
    let mut sorted = names.clone();
    sorted.sort_by(|a, b| crate::util::locale_cmp(a, b));
    assert_eq!(names, sorted);
}

#[tokio::test]
async fn files_search_and_investigation_use_the_filename_index() {
    let llm = FakeLlm::new(
        Some("ollama"),
        &[
            r#"{"phase":"search","queries":["invoice"]}"#,
            r#"{"ids":[],"summary":""}"#,
        ],
    );
    let h = harness_with(FakeDesktop::default(), llm);
    std::fs::write(h.home.join("Documents").join("invoice-acme.pdf"), "").unwrap();
    let files = h.get("/api/files?q=invoice").await.json_value().unwrap();
    assert_eq!(files[0]["name"], "invoice-acme.pdf");
    assert_eq!(files[0]["folder"], "Documents");
    assert!(files[0]["score"].as_i64().is_some());
    let status = h.get("/api/search/status").await.json_value().unwrap();
    assert_eq!(status["ok"], true);
    assert_eq!(status["indexed"], 1);
    let result = h
        .post(
            "/api/agent/files/investigate",
            json!({ "history": [{ "role": "user", "text": "find the acme invoice pdf" }] }),
        )
        .await;
    assert_eq!(result["phase"], "results");
    assert_eq!(result["files"][0]["name"], "invoice-acme.pdf");
    assert!(result["files"][0].get("score").is_none());
    assert_eq!(result["summary"], "I found 1 likely local file to review.");
    assert_eq!(
        result["trace"][0]["detail"],
        "Prepared 1 focused filename search."
    );
    let refreshed = h
        .call(ApiRequest::post("/api/search/refresh", &json!({})))
        .await
        .json_value()
        .unwrap();
    assert_eq!(refreshed["indexed"], 1);
    let other = h
        .post(
            "/api/agent/files/investigate",
            json!({ "history": [{ "role": "user", "text": "open my inbox" }] }),
        )
        .await;
    assert_eq!(other, json!({ "ok": true, "phase": "not_applicable" }));
}

#[tokio::test]
async fn analytics_acknowledges_immediately_and_unknown_routes_fall_through() {
    let h = harness();
    assert_eq!(
        h.post("/api/analytics/capture", json!({ "event": "nope" }))
            .await,
        json!({ "ok": true })
    );
    assert!(
        h.services
            .handle(&ApiRequest::get("/api/mail/status"))
            .await
            .is_none()
    );
    assert!(
        h.services
            .handle(&ApiRequest::get("/api/apps/x"))
            .await
            .is_none()
    );
}

#[tokio::test]
async fn the_recent_files_route_records_lists_and_clears() {
    let h = harness();
    let doc = h.home.join("Documents").join("plan.txt");
    std::fs::write(&doc, "x").unwrap();
    let record = ApiRequest::new(
        Method::Post,
        "/api/recent-files",
        serde_json::to_vec(&json!({ "action": "record", "path": doc })).unwrap(),
    );
    assert_eq!(
        h.call(record).await.json_value().unwrap(),
        json!({ "ok": true })
    );
    let list = h.get("/api/recent-files").await.json_value().unwrap();
    assert_eq!(list["items"][0]["name"], "plan.txt");
    assert_eq!(list["items"][0]["available"], true);
    let bad = h
        .call(ApiRequest::new(
            Method::Patch,
            "/api/recent-files",
            b"[]".to_vec(),
        ))
        .await;
    assert_eq!(bad.status, 400);
    let clear = ApiRequest::new(Method::Delete, "/api/recent-files", b"{}".to_vec());
    assert_eq!(h.call(clear).await.json_value().unwrap()["ok"], true);
    assert_eq!(
        h.get("/api/recent-files").await.json_value().unwrap()["items"],
        json!([])
    );
}
