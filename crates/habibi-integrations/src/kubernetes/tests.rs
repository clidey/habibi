use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::json;

use super::*;
use crate::testing::FakeLlm;

/// Records every kubectl call and answers by matching the arguments.
type Answer = Box<dyn Fn(&[String]) -> RunOutcome + Send + Sync>;

struct FakeKubectl {
    calls: Mutex<Vec<Vec<String>>>,
    answer: Answer,
}

impl FakeKubectl {
    fn new(answer: impl Fn(&[String]) -> RunOutcome + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { calls: Mutex::new(Vec::new()), answer: Box::new(answer) })
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl KubectlRunner for FakeKubectl {
    async fn run(&self, args: &[String], _max: usize) -> RunOutcome {
        self.calls.lock().unwrap().push(args.to_vec());
        (self.answer)(args)
    }
}

fn exited(stdout: &str) -> RunOutcome {
    RunOutcome::Exited { code: 0, stdout: stdout.into(), stderr: String::new() }
}

fn service(runner: Arc<FakeKubectl>, llm: FakeLlm) -> (Kubernetes, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    (Kubernetes::new(root.path().to_path_buf(), runner, Arc::new(llm)), root)
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[tokio::test]
async fn reads_reject_unsafe_flags_and_audit_bounded_kubectl_calls() {
    let runner = FakeKubectl::new(|_| exited("pod/api Ready"));
    let (kubernetes, root) = service(runner.clone(), FakeLlm::new(None, vec![]));
    let rejected = kubernetes.query("get pods --delete", "", "").await;
    assert_eq!(rejected["ok"], false);
    assert!(runner.calls().is_empty());
    let result = kubernetes.query("get pods -A", "production", "").await;
    assert_eq!(result, json!({ "ok": true, "output": "pod/api Ready", "action": "get" }));
    assert_eq!(
        runner.calls(),
        vec![args(&["get", "pods", "--output", "wide", "--all-namespaces", "--context", "production"])]
    );
    let audit = std::fs::read_to_string(root.path().join("kubernetes/audit.jsonl")).unwrap();
    let audit: Value = serde_json::from_str(audit.trim()).unwrap();
    assert_eq!((&audit["action"], &audit["context"], &audit["exit"]), (&json!("get"), &json!("production"), &json!(0)));
    assert_eq!(audit["namespace"], Value::Null);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(root.path().join("kubernetes/audit.jsonl")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn the_parser_allows_only_read_verbs_resources_and_scope_flags() {
    let logs = parse_query("kubectl logs api-1 -n prod -c web", "dev").unwrap();
    assert_eq!(
        logs.args,
        args(&["logs", "api-1", "--namespace", "prod", "--context", "dev", "--container", "web", "--tail", "200"])
    );
    assert_eq!(parse_query("k8s describe deploy api -n prod", "").unwrap().args, args(&["describe", "deployments", "api", "--namespace", "prod"]));
    assert_eq!(parse_query("events", "").unwrap().action, "events");
    assert_eq!(parse_query("get events -A", "").unwrap().args, args(&["get", "events", "--all-namespaces"]));
    for unsafe_query in ["delete pod api", "exec api -- sh", "get pods -o jsonpath", "get crds", "describe pods", "logs"] {
        assert!(parse_query(unsafe_query, "").is_err(), "{unsafe_query} must be rejected");
    }
    assert_eq!(
        parse_query("get pods --watch", "").unwrap_err(),
        "Flag --watch is not available in Habibi's read-only Kubernetes plugin."
    );
}

#[tokio::test]
async fn the_explorer_namespace_is_a_default_and_never_overrides_an_explicit_scope() {
    let runner = FakeKubectl::new(|_| exited(""));
    let (kubernetes, _root) = service(runner.clone(), FakeLlm::new(None, vec![]));
    kubernetes.query("get pods", "dev", "staging").await;
    kubernetes.query("get pods -n prod", "dev", "staging").await;
    kubernetes.query("get pods -A", "", "staging").await;
    assert_eq!(
        runner.calls(),
        vec![
            args(&["get", "pods", "--output", "wide", "--namespace", "staging", "--context", "dev"]),
            args(&["get", "pods", "--output", "wide", "--namespace", "prod", "--context", "dev"]),
            args(&["get", "pods", "--output", "wide", "--all-namespaces"]),
        ]
    );
}

#[tokio::test]
async fn failures_are_bounded_messages_and_invalid_names_never_reach_kubectl() {
    let runner = FakeKubectl::new(|args| match args[0].as_str() {
        "logs" => RunOutcome::TooLarge,
        "describe" => RunOutcome::NotFound,
        _ => RunOutcome::Exited { code: 1, stdout: String::new(), stderr: format!("  {}  ", "e".repeat(5_000)) },
    });
    let (kubernetes, _root) = service(runner.clone(), FakeLlm::new(None, vec![]));
    let failed = kubernetes.query("get pods", "", "").await;
    assert_eq!(failed["error"].as_str().unwrap().len(), 4_000);
    assert_eq!(kubernetes.query("describe pod api", "", "").await["error"], "kubectl is not installed or not on Habibi’s PATH.");
    let logs = kubernetes.logs(&json!({ "pod": "api", "namespace": "prod" })).await;
    assert_eq!(logs["error"], "This Kubernetes response is too large to display safely. Narrow the namespace or resource.");
    let before = runner.calls().len();
    assert_eq!(kubernetes.logs(&json!({ "pod": "api;rm", "namespace": "prod" })).await["ok"], false);
    assert_eq!(kubernetes.detail(&json!({ "kind": "crd", "name": "x" })).await["ok"], false);
    assert_eq!(kubernetes.resources(&json!({ "kind": "pods", "namespace": "-A" })).await["error"], "That namespace is not valid.");
    assert_eq!(runner.calls().len(), before);
}

#[tokio::test]
async fn resources_for_cluster_kinds_drop_namespace_scope() {
    let runner = FakeKubectl::new(|_| exited(r#"{"items":[{"metadata":{"name":"n1"}}]}"#));
    let (kubernetes, _root) = service(runner.clone(), FakeLlm::new(None, vec![]));
    let result = kubernetes.resources(&json!({ "kind": "node", "context": "dev" })).await;
    assert_eq!(result["kind"], "nodes");
    assert_eq!(result["items"][0]["name"], "n1");
    assert_eq!(runner.calls()[0], args(&["get", "nodes", "--context", "dev", "--output", "json"]));
}

fn cluster(args: &[String]) -> RunOutcome {
    let joined = args.join(" ");
    let output = if joined.starts_with("config get-contexts") {
        "dev\nproduction\n".to_string()
    } else if joined.starts_with("config current-context") {
        "dev".into()
    } else if joined.starts_with("get namespaces") {
        r#"{"items":[{"metadata":{"name":"shop"}},{"metadata":{"name":"default"}}]}"#.into()
    } else if joined.starts_with("get pods --all-namespaces") || joined.starts_with("get pods --namespace shop --output") {
        r#"{"items":[{"metadata":{"name":"web-1","namespace":"shop"},"status":{"phase":"Running"}}]}"#.into()
    } else if joined.starts_with("get deployments") {
        r#"{"items":[{"metadata":{"name":"checkout","namespace":"shop"},"spec":{"replicas":1},"status":{}}]}"#.into()
    } else if joined.starts_with("get services") {
        r#"{"items":[]}"#.into()
    } else if joined.starts_with("get pods --namespace shop --selector") {
        r#"{"items":[{"metadata":{"name":"checkout-7c9d","namespace":"shop"},"status":{"phase":"Running"}}]}"#.into()
    } else if joined.starts_with("get pods --output wide") {
        "web-1 Running".into()
    } else if joined.starts_with("logs checkout-7c9d") {
        "boom".into()
    } else {
        return RunOutcome::Exited { code: 1, stdout: String::new(), stderr: "unexpected".into() };
    };
    exited(&output)
}

#[tokio::test]
async fn overview_falls_back_to_the_current_context_and_lists_namespaces_sorted() {
    let runner = FakeKubectl::new(cluster);
    let (kubernetes, _root) = service(runner.clone(), FakeLlm::new(None, vec![]));
    let overview = kubernetes.overview("missing", "").await;
    assert_eq!(overview["context"], "dev");
    assert_eq!(overview["contexts"], json!(["dev", "production"]));
    assert_eq!(overview["namespaces"], json!(["default", "shop"]));
    assert_eq!(overview["namespace"], "");
    assert_eq!(overview["resources"][0]["kind"], "pods");
    assert_eq!(overview["resources"][0]["items"][0]["name"], "web-1");
    assert!(runner.calls().iter().any(|call| *call == args(&["get", "pods", "--all-namespaces", "--output", "json", "--context", "dev"])));
    assert_eq!(kubernetes.overview("dev", "bad/ns").await["error"], "That namespace is not valid.");
}

#[tokio::test]
async fn planning_and_diagnosis_use_only_a_local_model() {
    let runner = FakeKubectl::new(cluster);
    let (remote, _root) = service(runner.clone(), FakeLlm::new(Some("openai"), vec![]));
    let refused = remote.plan("show my pods", "dev", "").await;
    assert_eq!(refused["error"], "Configure a local model to interpret Kubernetes requests, or use a kubectl-style command.");
    assert!(runner.calls().is_empty());

    let llm = FakeLlm::new(Some("ollama"), vec!["Sure: {\"query\":\"get pods -n shop\",\"summary\":\"Pods in shop\"}".into()]);
    let (local, _root) = service(runner.clone(), llm);
    let planned = local.plan("show shop pods", "dev", "").await;
    assert_eq!(planned["plannedQuery"], "get pods -n shop");
    assert_eq!(planned["summary"], "Pods in shop");
    assert_eq!(planned["trace"][1]["detail"], "Read completed using your selected context.");

    let unsafe_plan = FakeLlm::new(Some("lmstudio"), vec![r#"{"query":"delete pod checkout"}"#.into()]);
    let (local, _root) = service(runner.clone(), unsafe_plan);
    let rejected = local.plan("remove checkout", "dev", "").await;
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["trace"][1]["detail"], "The read was rejected or could not complete.");
}

#[tokio::test]
async fn diagnosis_sequences_overview_detail_and_logs_then_summarizes() {
    let runner = FakeKubectl::new(|args| {
        if args.starts_with(&args_of(&["get", "deployments", "checkout"])) {
            return exited(
                r#"{"metadata":{"name":"checkout","namespace":"shop"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"checkout"}}},"status":{"readyReplicas":0}}"#,
            );
        }
        cluster(args)
    });
    let llm = Arc::new(FakeLlm::new(Some("ollama"), vec!["  The checkout pod is crashing.  ".into()]));
    let root = tempfile::tempdir().unwrap();
    let kubernetes = Kubernetes::new(root.path().to_path_buf(), runner.clone(), llm.clone());
    let result = kubernetes.diagnose("why is checkout failing", "dev", "").await;
    assert_eq!(result["ok"], true);
    assert_eq!(result["target"], json!({ "kind": "deployments", "name": "checkout", "namespace": "shop" }));
    assert_eq!(result["summary"], "The checkout pod is crashing.");
    assert_eq!(result["logs"], "boom");
    let tools: Vec<&str> = result["trace"].as_array().unwrap().iter().map(|step| step["tool"].as_str().unwrap()).collect();
    assert_eq!(tools, ["list_resources", "inspect_resource", "read_logs"]);
    assert!(result["evidence"].as_array().unwrap().iter().any(|line| line == "Ready: 0/1"));
    let prompt = llm.requests.lock().unwrap()[0].messages[0].text.clone();
    assert!(prompt.contains("Recent logs:\nboom"));

    let unclear = kubernetes.diagnose("zz", "dev", "").await;
    assert_eq!(unclear["clarification"], true);
    assert!(unclear["summary"].as_str().unwrap().contains("I found resources in shop."));
}

fn args_of(values: &[&str]) -> Vec<String> {
    args(values)
}

#[tokio::test]
async fn routes_parse_bodies_and_reject_bad_json() {
    let runner = FakeKubectl::new(|_| exited("ok"));
    let (kubernetes, _root) = service(runner, FakeLlm::new(None, vec![]));
    let response = kubernetes
        .handle(&ApiRequest::post("/api/kubernetes/query", &json!({ "query": "get pods", "context": "dev" })))
        .await
        .unwrap();
    assert_eq!(response.json_value().unwrap()["output"], "ok");
    let bad = ApiRequest::new(Method::Post, "/api/kubernetes/logs", b"{".to_vec());
    assert_eq!(kubernetes.handle(&bad).await.unwrap().json_value().unwrap()["error"], "Invalid request.");
    assert!(kubernetes.handle(&ApiRequest::get("/api/kubernetes/query")).await.is_none());
    assert_eq!(manifest()["tools"].as_array().unwrap().len(), 4);
}
