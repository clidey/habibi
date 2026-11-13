//! Ports of `test/file-tools.test.js` (and the file-tools parts of
//! `test/daily-utilities.test.js`), run through the routes as the UI calls them.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;
use habibi_core::services::{CompletionRequest, CompletionResult, LlmState};
use serde_json::{Value, json};

use super::*;

type Answer = Box<dyn Fn(&Value) -> Value + Send + Sync>;

struct FakeLlm {
    answer: Answer,
    calls: Mutex<Vec<CompletionRequest>>,
}

#[async_trait]
impl Llm for FakeLlm {
    async fn state(&self) -> LlmState {
        LlmState { configured: true, provider: Some("fake".into()) }
    }

    async fn complete(&self, request: CompletionRequest) -> CompletionResult {
        let evidence = serde_json::from_str(&request.messages[0].text).unwrap_or(Value::Null);
        self.calls.lock().unwrap().push(request);
        CompletionResult { ok: true, text: Some((self.answer)(&evidence).to_string()), ..Default::default() }
    }
}

struct FakeNative {
    root: PathBuf,
    calls: Mutex<Vec<String>>,
}

impl NativeFileTools for FakeNative {
    fn run(&self, request: &Value) -> FileResult<Value> {
        let action = request["action"].as_str().unwrap_or("").to_string();
        self.calls.lock().unwrap().push(action.clone());
        if action == "trash" {
            let from = PathBuf::from(request["path"].as_str().unwrap());
            let target = self.root.join("Trash").join(from.file_name().unwrap());
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::rename(&from, &target).unwrap();
            let target = util::canonical(&target).unwrap();
            return Ok(json!({ "ok": true, "path": target }));
        }
        std::fs::write(request["destination"].as_str().unwrap(), "converted").unwrap();
        Ok(json!({ "ok": true }))
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    folder: PathBuf,
    tools: Arc<FileTools>,
    approvals: Arc<ApprovalService>,
    llm: Arc<FakeLlm>,
    native: Arc<FakeNative>,
    grant: Value,
}

impl Fixture {
    async fn new(answer: impl Fn(&Value) -> Value + Send + Sync + 'static) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = util::canonical(temp.path()).unwrap();
        let folder = root.join("Documents");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("scan.txt"), "Vendor: Demo Cafe\nDate: 2026-11-06\nTotal: GBP 12.50").unwrap();
        let llm = Arc::new(FakeLlm { answer: Box::new(answer), calls: Mutex::new(Vec::new()) });
        let native = Arc::new(FakeNative { root: root.clone(), calls: Mutex::new(Vec::new()) });
        let approvals = Arc::new(ApprovalService::default());
        let tools = FileTools::with_native(
            Paths::new(&root, &root, &root),
            approvals.clone(),
            llm.clone(),
            native.clone(),
        );
        let mut fixture = Fixture { _temp: temp, root, folder, tools, approvals, llm, native, grant: Value::Null };
        let grant = fixture.post("grant", json!({ "path": fixture.folder })).await;
        assert_eq!(grant["ok"], true, "{grant}");
        fixture.grant = grant["grant"].clone();
        fixture
    }

    fn grant_id(&self) -> String {
        self.grant["id"].as_str().unwrap().to_string()
    }

    async fn post(&self, action: &str, body: Value) -> Value {
        let request = ApiRequest::post(&format!("/api/file-tools/{action}"), &body);
        self.tools.handle(&request).await.unwrap().json_value().unwrap()
    }

    async fn prepare(&self, body: Value) -> Value {
        let mut body = body;
        body["grants"] = json!([self.grant_id()]);
        self.post("prepare", body).await
    }

    /// Issue a token for exactly `payload` and send it with the payload.
    async fn approved(&self, action: &str, payload: Value) -> Value {
        let token = self.approvals.issue(&format!("file-tools.{action}"), payload.clone()).token;
        let mut body = payload;
        body["approvalToken"] = json!(token);
        self.post(action, body).await
    }

    async fn apply(&self, plan: &Value, selected: Value, cleanup: bool) -> Value {
        let payload = json!({ "planId": plan["plan"]["id"], "selected": selected, "cleanupAcknowledged": cleanup });
        self.approved("apply", payload).await
    }

    async fn undo(&self, plan: &Value) -> Value {
        self.approved("undo", json!({ "planId": plan["plan"]["id"] })).await
    }

    fn model_input(&self, call: usize) -> Value {
        serde_json::from_str(&self.llm.calls.lock().unwrap()[call].messages[0].text).unwrap()
    }
}

fn error(value: &Value) -> String {
    assert_eq!(value["ok"], false, "{value}");
    value["error"].as_str().unwrap_or("").to_string()
}

fn rename(evidence: &Value) -> Value {
    json!({
        "summary": "Rename receipt using supplied evidence.",
        "changes": [{
            "kind": "move",
            "sources": [evidence["files"][0]["id"]],
            "destination": "2026-11-06-demo-cafe.txt",
            "reason": "Vendor/date from receipt",
        }],
        "findings": [],
    })
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[tokio::test]
async fn ai_file_plans_are_previews_until_applied_share_contents_only_explicitly_and_undo_safely() {
    let f = Fixture::new(rename).await;
    let result = f.prepare(json!({ "task": "rename", "request": "Rename this receipt", "allowModel": true })).await;
    assert_eq!(result["ok"], true, "{result}");
    assert!(exists(&f.folder.join("scan.txt")));
    assert!(f.model_input(0)["files"][0].get("excerpt").is_none());
    let output = f.apply(&result, json!([0]), false).await;
    assert_eq!(output["ok"], true, "{output}");
    let first = PathBuf::from(output["outputs"][0].as_str().unwrap());
    assert_eq!(first.file_name().unwrap(), "2026-11-06-demo-cafe.txt");
    assert!(!exists(&f.folder.join("scan.txt")));
    assert_eq!(f.undo(&result).await["ok"], true);
    assert!(exists(&f.folder.join("scan.txt")));

    let content = f
        .prepare(json!({ "task": "rename", "request": "Rename using contents", "allowModel": true, "shareContents": true }))
        .await;
    assert!(f.model_input(1)["files"][0]["excerpt"].as_str().unwrap().contains("Demo Cafe"));
    assert_eq!(f.apply(&content, json!([0]), false).await["ok"], true);
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(f.folder.join("2026-11-06-demo-cafe.txt")).unwrap();
    file.write_all(b"An edit").unwrap();
    drop(file);
    assert!(error(&f.undo(&content).await).contains("changed"));
    // The journal records applied plans with private permissions.
    let journal = f.root.join(".habibi/file-tools/journal.json");
    assert!(exists(&journal));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&journal).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn file_tools_reject_private_paths_symlinks_fabricated_ids_traversal_overwrites_and_cleanup_without_opt_in() {
    let f = Fixture::new(|evidence| {
        json!({
            "summary": "Unsafe",
            "changes": [{ "kind": "move", "sources": [evidence["files"][0]["id"]], "destination": "../escape.txt" }],
            "findings": [],
        })
    })
    .await;
    assert!(error(&f.post("grant", json!({ "path": f.root.join(".ssh/id_rsa") })).await).contains("private"));
    let alias = f.root.join("alias");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&f.folder, &alias).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&f.folder, &alias).unwrap();
    assert!(error(&f.post("grant", json!({ "path": alias })).await).contains("symbolic"));
    assert!(error(&f.prepare(json!({ "task": "rename", "request": "Rename", "allowModel": true })).await).contains("relative"));

    let inspected = f.post("inspect", json!({ "grants": [f.grant_id()] })).await;
    let entry: contract::FileEntry = {
        let raw = &inspected["entries"][0];
        contract::FileEntry {
            id: raw["id"].as_str().unwrap().into(),
            grant_id: raw["grantId"].as_str().unwrap().into(),
            relative: raw["relative"].as_str().unwrap().into(),
            path: raw["path"].as_str().unwrap().into(),
            size: raw["size"].as_u64().unwrap(),
            modified: raw["modified"].as_f64().unwrap(),
            device: raw["device"].as_u64().unwrap(),
            inode: raw["inode"].as_u64().unwrap(),
            excerpt: None,
            pages: None,
        }
    };
    assert_eq!(entry.relative, "scan.txt");
    let check = |change: Value, task: &str| -> String {
        let proposal = json!({ "summary": "", "changes": [change], "findings": [] });
        match planner::validate_file_proposal(&proposal, std::slice::from_ref(&entry), task, false) {
            Ok(_) => String::new(),
            Err(error) => error.message().to_string(),
        }
    };
    assert!(check(json!({ "kind": "move", "sources": ["fabricated"], "destination": "new.txt" }), "rename").contains("outside"));
    assert!(check(json!({ "kind": "trash", "sources": [entry.id] }), "storage").contains("Removal is off"));
    assert!(check(json!({ "kind": "move", "sources": [entry.id], "destination": "new.exe" }), "rename").contains("extension"));
    assert!(check(json!({ "kind": "shell", "sources": [entry.id] }), "rename").contains("unsupported"));
    assert!(check(json!({ "kind": "image", "sources": [entry.id], "destination": "a.jpg" }), "rename").contains("match"));
    assert!(
        check(json!({ "kind": "image", "sources": [entry.id], "destination": "a.jpg", "width": 99 }), "compress")
            .contains("width")
    );
    assert!(
        check(
            json!({ "kind": "pdf", "sources": [entry.id], "destination": "a.pdf", "pages": [{ "source": entry.id, "page": 1, "rotate": 45 }] }),
            "pdf"
        )
        .contains("page selection")
    );
}

#[tokio::test]
async fn file_previews_cannot_execute_stale_files_or_write_through_substituted_folders() {
    let f = Fixture::new(rename).await;
    let first = f.prepare(json!({ "task": "rename", "request": "Rename", "allowModel": true })).await;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(f.folder.join("scan.txt")).unwrap();
    file.write_all(b"Changed").unwrap();
    drop(file);
    assert!(error(&f.apply(&first, json!([0]), false).await).contains("changed"));
    let second = f.prepare(json!({ "task": "rename", "request": "Rename", "allowModel": true })).await;
    std::fs::write(f.folder.join("2026-11-06-demo-cafe.txt"), "Existing").unwrap();
    assert!(error(&f.apply(&second, json!([0]), false).await).contains("exists"));
    assert_eq!(std::fs::read_to_string(f.folder.join("2026-11-06-demo-cafe.txt")).unwrap(), "Existing");
    // A destination that already exists is refused while planning too.
    assert!(error(&f.prepare(json!({ "task": "rename", "request": "Rename", "allowModel": true })).await).contains("already exists"));
}

#[tokio::test]
async fn duplicate_scan_proves_identical_bytes_and_cleanup_preserves_one_original_copy() {
    let f = Fixture::new(|evidence| {
        let changes: Vec<Value> = evidence["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| json!({ "kind": "trash", "sources": [file["id"]], "reason": "duplicate" }))
            .collect();
        json!({ "summary": "Two identical copies", "changes": changes, "findings": [] })
    })
    .await;
    std::fs::copy(f.folder.join("scan.txt"), f.folder.join("copy.txt")).unwrap();
    let local = f.prepare(json!({ "task": "duplicates", "request": "Find duplicates" })).await;
    assert_eq!(local["duplicates"]["groups"].as_array().unwrap().len(), 1, "{local}");
    assert_eq!(local["provider"], "local");
    assert!(f.llm.calls.lock().unwrap().is_empty());
    let message = error(
        &f.prepare(json!({ "task": "duplicates", "request": "Remove duplicates", "allowModel": true, "allowCleanup": true }))
            .await,
    );
    assert!(message.contains("retain"), "{message}");
}

#[tokio::test]
async fn cleanup_moves_one_copy_to_trash_only_with_acknowledgement_and_undo_restores_it() {
    let f = Fixture::new(|evidence| {
        json!({
            "summary": "Remove the copy",
            "changes": [{ "kind": "trash", "sources": [evidence["files"][0]["id"]], "reason": "duplicate" }],
            "findings": [],
        })
    })
    .await;
    std::fs::copy(f.folder.join("scan.txt"), f.folder.join("copy.txt")).unwrap();
    let plan = f
        .prepare(json!({ "task": "duplicates", "request": "Remove duplicates", "allowModel": true, "allowCleanup": true }))
        .await;
    assert_eq!(plan["ok"], true, "{plan}");
    assert!(error(&f.apply(&plan, json!([0]), false).await).contains("Confirm the selected Trash"));
    let applied = f.apply(&plan, json!([0]), true).await;
    assert_eq!(applied["ok"], true, "{applied}");
    assert!(!exists(&f.folder.join("copy.txt")));
    assert!(exists(&f.root.join("Trash/copy.txt")));
    assert_eq!(f.undo(&plan).await["ok"], true);
    assert!(exists(&f.folder.join("copy.txt")));
}

#[tokio::test]
async fn bounded_conversions_create_new_outputs_preserve_originals_and_undo_retains_generated_copies() {
    let f = Fixture::new(|evidence| {
        json!({
            "summary": "Extract receipt",
            "changes": [{
                "kind": "csv",
                "sources": [evidence["files"][0]["id"]],
                "destination": "expenses.csv",
                "csv": "Vendor,Total\nDemo Cafe,12.50\n=HYPERLINK(\"https://example.test\"),1",
                "reason": "Receipt values",
            }],
            "findings": [],
        })
    })
    .await;
    let result = f
        .prepare(json!({ "task": "extract", "request": "Extract expenses", "allowModel": true, "shareContents": true }))
        .await;
    assert_eq!(result["previews"], json!([]), "Planning must not generate converted outputs");
    let plan_id = result["plan"]["id"].clone();
    let confirmed = f.approved("preview", json!({ "planId": plan_id, "selected": [0] })).await;
    assert_eq!(confirmed["previews"].as_array().unwrap().len(), 1, "{confirmed}");
    assert!(result["plan"]["changes"][0]["csv"].as_str().unwrap().contains("'=HYPERLINK"));
    assert!(!exists(&f.folder.join("expenses.csv")));

    // The approved preview can be fetched as the UI's `href` does.
    let request = ApiRequest::get(&format!("/api/file-tools/preview?plan={}&index=0", plan_id.as_str().unwrap()));
    let preview = f.tools.handle(&request).await.unwrap();
    assert_eq!(preview.header("Content-Type"), Some("text/plain; charset=utf-8"));
    assert!(String::from_utf8(preview.body).unwrap().contains("Demo Cafe"));

    assert_eq!(f.apply(&result, json!([0]), false).await["ok"], true);
    assert!(exists(&f.folder.join("scan.txt")));
    assert_eq!(f.undo(&result).await["ok"], true);
    assert!(!exists(&f.folder.join("expenses.csv")));
    assert_eq!(std::fs::read_dir(f.root.join(".habibi/file-tools/undo")).unwrap().count(), 1);
}

#[tokio::test]
async fn file_tool_http_writes_consume_approvals_bound_to_the_exact_selection_and_cleanup_flag() {
    let f = Fixture::new(rename).await;
    let prepared = f.prepare(json!({ "task": "rename", "request": "Rename", "allowModel": true })).await;
    let payload = json!({ "planId": prepared["plan"]["id"], "selected": [0], "cleanupAcknowledged": false });
    assert_eq!(f.post("apply", payload.clone()).await["ok"], false);
    let token = f.approvals.issue("file-tools.apply", payload.clone()).token;
    let mut mismatched = payload.clone();
    mismatched["cleanupAcknowledged"] = json!(true);
    mismatched["approvalToken"] = json!(token);
    assert_eq!(f.post("apply", mismatched).await["ok"], false);
    let mut spent = payload.clone();
    spent["approvalToken"] = json!(token);
    assert_eq!(f.post("apply", spent).await["ok"], false, "Mismatch spends the token");
    let valid = f.approvals.issue("file-tools.apply", payload.clone()).token;
    let mut body = payload.clone();
    body["approvalToken"] = json!(valid);
    assert_eq!(f.post("apply", body.clone()).await["ok"], true);
    assert_eq!(f.post("apply", body).await["ok"], false);
}

#[tokio::test]
async fn compression_is_not_processed_by_a_model_plan_and_previews_and_writes_each_require_exact_fresh_approval() {
    let f = Fixture::new(|evidence| {
        json!({
            "summary": "Compress a copy",
            "approved": true,
            "execute": true,
            "approvalToken": "model-cannot-approve",
            "changes": [
                { "kind": "image", "sources": [evidence["files"][0]["id"]], "destination": "compressed.jpg", "width": 900, "quality": 65, "reason": "Smaller copy" },
                { "kind": "image", "sources": [evidence["files"][0]["id"]], "destination": "other.jpg", "reason": "Unselected copy" },
            ],
            "findings": [],
        })
    })
    .await;
    let result = f.prepare(json!({ "task": "compress", "request": "Compress for review", "allowModel": true })).await;
    assert!(f.native.calls.lock().unwrap().is_empty());
    assert_eq!(result["previews"], json!([]));
    assert!(!exists(&f.root.join(".habibi/file-tools/previews")));
    let payload = json!({ "planId": result["plan"]["id"], "selected": [0] });
    assert_eq!(f.post("preview", payload.clone()).await["ok"], false);
    let mut forged = payload.clone();
    forged["approvalToken"] = json!("model-cannot-approve");
    forged["approved"] = json!(true);
    assert_eq!(f.post("preview", forged).await["ok"], false);
    let wrong = f.approvals.issue("file-tools.preview", payload.clone()).token;
    let mut wrong_selection = payload.clone();
    wrong_selection["selected"] = json!([1]);
    wrong_selection["approvalToken"] = json!(wrong);
    assert_eq!(f.post("preview", wrong_selection).await["ok"], false);
    let mut spent = payload.clone();
    spent["approvalToken"] = json!(wrong);
    assert_eq!(f.post("preview", spent).await["ok"], false);
    assert!(f.native.calls.lock().unwrap().is_empty());
    let preview_token = f.approvals.issue("file-tools.preview", payload.clone()).token;
    let mut body = payload.clone();
    body["approvalToken"] = json!(preview_token);
    let preview = f.post("preview", body.clone()).await;
    assert_eq!(preview["ok"], true, "{preview}");
    assert_eq!(preview["previews"].as_array().unwrap().len(), 1);
    assert_eq!(*f.native.calls.lock().unwrap(), vec!["image".to_string()]);
    assert!(!exists(&f.folder.join("compressed.jpg")));
    assert_eq!(f.post("preview", body).await["ok"], false);

    let mut apply_payload = payload.clone();
    apply_payload["cleanupAcknowledged"] = json!(false);
    assert_eq!(f.post("apply", apply_payload.clone()).await["ok"], false);
    let mut reused = apply_payload.clone();
    reused["approvalToken"] = json!(preview_token);
    assert_eq!(f.post("apply", reused).await["ok"], false);
    assert!(!exists(&f.folder.join("compressed.jpg")));
    let apply_token = f.approvals.issue("file-tools.apply", apply_payload.clone()).token;
    let mut apply = apply_payload.clone();
    apply["approvalToken"] = json!(apply_token);
    assert_eq!(f.post("apply", apply.clone()).await["ok"], true);
    assert_eq!(std::fs::read_to_string(f.folder.join("compressed.jpg")).unwrap(), "converted");
    assert!(!exists(&f.folder.join("other.jpg")));
    assert_eq!(*f.native.calls.lock().unwrap(), vec!["image".to_string()], "Unselected conversions must not run");
    assert_eq!(f.post("apply", apply).await["ok"], false);
    let undo = json!({ "planId": result["plan"]["id"] });
    assert_eq!(f.post("undo", undo.clone()).await["ok"], false);
    assert_eq!(f.approved("undo", undo).await["ok"], true);
}

#[tokio::test]
async fn daily_plans_go_through_the_model_and_are_normalized() {
    let f = Fixture::new(|_| json!({ "kind": "timer", "action": "start", "seconds": 1500, "label": "Write" })).await;
    let plan = f.post("daily", json!({ "request": "start a 25 minute focus timer" })).await;
    assert_eq!(plan, json!({ "ok": true, "plan": { "kind": "timer", "action": "start", "seconds": 1500, "label": "Write" } }));
    assert!(f.llm.calls.lock().unwrap()[0].system_prompt.as_deref().unwrap().contains("daily utility planner"));
    assert!(error(&f.post("daily", json!({ "request": "  " })).await).contains("Describe"));
}

#[tokio::test]
async fn routes_keep_the_node_envelopes_and_limits() {
    let f = Fixture::new(rename).await;
    assert!(f.tools.handle(&ApiRequest::get("/api/files")).await.is_none());
    let missing = f.tools.handle(&ApiRequest::post("/api/file-tools/nope", &json!({}))).await.unwrap();
    assert_eq!(missing.status, 404);
    assert_eq!(error(&missing.json_value().unwrap()), "File action unavailable.");
    let get = f.tools.handle(&ApiRequest::get("/api/file-tools/prepare")).await.unwrap();
    assert_eq!(get.status, 400);
    assert_eq!(error(&get.json_value().unwrap()), "Use a JSON request.");
    let large = ApiRequest::new(Method::Post, "/api/file-tools/grant", vec![b' '; MAX_REQUEST_BYTES + 1]);
    assert_eq!(error(&f.tools.handle(&large).await.unwrap().json_value().unwrap()), "The request is too large.");
    let bad = ApiRequest::new(Method::Post, "/api/file-tools/grant", b"{".to_vec());
    assert_eq!(error(&f.tools.handle(&bad).await.unwrap().json_value().unwrap()), error::ACCESS_ERROR);
    let array = ApiRequest::post("/api/file-tools/grant", &json!([1]));
    assert_eq!(error(&f.tools.handle(&array).await.unwrap().json_value().unwrap()), "Invalid file request.");
    assert!(error(&f.post("inspect", json!({ "grants": ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })).await).contains("eight"));
    assert!(error(&f.post("prepare", json!({ "task": "shell", "request": "x", "grants": [f.grant_id()] })).await).contains("supported"));
    assert!(error(&f.prepare(json!({ "task": "rename", "request": "Rename" })).await).contains("Prepare with AI"));
    let missing_preview = ApiRequest::get("/api/file-tools/preview?plan=nope&index=0");
    assert!(error(&f.tools.handle(&missing_preview).await.unwrap().json_value().unwrap()).contains("no longer available"));
}

#[tokio::test]
async fn path_suggestions_skip_hidden_private_and_linked_entries() {
    let f = Fixture::new(rename).await;
    std::fs::create_dir(f.root.join(".ssh")).unwrap();
    std::fs::create_dir(f.root.join("Downloads")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&f.folder, f.root.join("DocLink")).unwrap();
    let query = format!("{}/Do", f.root.display());
    let request = ApiRequest::new(
        Method::Get,
        &format!("/api/file-tools/paths?q={}", form_urlencoded_query(&query)),
        Vec::new(),
    );
    let response = f.tools.handle(&request).await.unwrap().json_value().unwrap();
    let names: Vec<&str> = response["items"].as_array().unwrap().iter().map(|item| item["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Documents", "Downloads"]);
    // Home-relative (`~/`) queries resolve against the configured home.
    let home = ApiRequest::get("/api/file-tools/paths?q=~/Doc");
    let response = f.tools.handle(&home).await.unwrap().json_value().unwrap();
    assert_eq!(response["items"][0]["name"], "Documents");
}

fn form_urlencoded_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'/' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}
