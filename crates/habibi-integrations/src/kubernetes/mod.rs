//! The Kubernetes plugin: bounded, audited, read-only kubectl calls behind
//! `/api/kubernetes/*`, plus local-model planning and diagnosis.
//!
//! Ported from `src/plugins/kubernetes/index.js` and
//! `src/server/services/kubernetes-read-service.js`.

mod format;
pub mod runner;

use std::path::PathBuf;
use std::sync::Arc;

use habibi_core::services::{ChatMessage, CompletionRequest, Llm};
use habibi_core::{ApiRequest, ApiResponse, Method, api::text, body};
use serde_json::{Map, Value, json};

use crate::util::{self, array, js_string, truthy};
use format::{format_detail, overview_items};
pub use runner::{KubectlRunner, RunOutcome, SystemKubectl};

/// Resources the read-only explorer and query parser accept.
const KINDS: &[&str] = &[
    "pods",
    "deployments",
    "services",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "configmaps",
    "secrets",
    "ingresses",
    "namespaces",
    "nodes",
    "events",
];

/// Only these providers keep cluster details on the machine, so only they may
/// interpret or summarize Kubernetes requests.
const LOCAL_PROVIDERS: &[&str] = &["ollama", "lmstudio"];

const DEFAULT_OUTPUT_BYTES: usize = 500_000;

const PLAN_PROMPT: &str = "You are the Kubernetes Habibi plugin. Turn the user's request into exactly one safe kubectl-style command. Return JSON only: {\"query\":\"...\",\"summary\":\"...\"}. The query must begin with one of: get, describe, logs, events. You may use only these resources: pods, deployments, services, statefulsets, daemonsets, replicasets, jobs, cronjobs, configmaps, secrets, ingresses, namespaces, nodes, events. You may use only -n <namespace>, -A, --context <context>, and -c <container>. Do not include pipes, shell syntax, labels, jsonpath, watch, edit, delete, apply, exec, port-forward, proxy, or any write operation. Preserve namespace and resource names from the user exactly; never invent them. If a request is ambiguous, choose a broad list such as get pods -A and say what was broadened in summary.";

const DIAGNOSE_PROMPT: &str = "You are the Kubernetes plugin diagnosis summarizer. Use only the supplied evidence. State what is healthy, what looks wrong, and the next safe inspection step. Do not claim certainty beyond the evidence. Do not suggest write commands. Keep it under 180 words.";

/// The plugin's manifest (`src/plugins/kubernetes/manifest.json`).
pub fn manifest() -> Value {
    json!({
        "id": "kubernetes",
        "name": "Kubernetes",
        "version": "0.1.0",
        "kind": "extension",
        "permissions": ["kubernetes.read", "audit.local"],
        "commands": ["Open Kubernetes", "Diagnose a Kubernetes workload", "Inspect a Kubernetes resource"],
        "tools": [
            { "name": "list_resources", "description": "List cluster resources in a context and optional namespace", "readOnly": true },
            { "name": "inspect_resource", "description": "Read structured workload, pod, service, or event details", "readOnly": true },
            { "name": "read_logs", "description": "Read a bounded tail of pod logs", "readOnly": true },
            { "name": "diagnose", "description": "Investigate a workload by sequencing safe cluster reads and summarizing evidence", "readOnly": true },
        ],
    })
}

/// A query the parser accepted.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedQuery {
    pub action: &'static str,
    pub args: Vec<String>,
    pub namespace: String,
    pub context: String,
}

/// Parse a kubectl-style read (`get pods -n prod`, `logs api -c web`, …).
/// Any flag outside the small allowlist is rejected before kubectl runs.
pub fn parse_query(input: &str, preferred_context: &str) -> Result<ParsedQuery, String> {
    let mut query = input.trim();
    for prefix in ["k8s", "kubernetes"] {
        query = strip_word(query, prefix);
    }
    query = strip_word(query, "kubectl");
    let mut parts = query.split_whitespace();
    let verb = parts.next().unwrap_or("").to_lowercase();
    let parts: Vec<&str> = parts.collect();
    let mut values: Vec<String> = Vec::new();
    let mut namespace = String::new();
    let mut context = preferred_context.to_string();
    let mut container = String::new();
    let mut all_namespaces = false;
    let mut index = 0;
    while index < parts.len() {
        let part = parts[index];
        let next = |index: &mut usize| {
            *index += 1;
            parts.get(*index).map(|value| value.to_string()).unwrap_or_default()
        };
        match part {
            "-n" | "--namespace" => namespace = next(&mut index),
            "--context" => context = next(&mut index),
            "-c" | "--container" => container = next(&mut index),
            "-A" | "--all-namespaces" => all_namespaces = true,
            _ if part.starts_with('-') => {
                return Err(format!("Flag {part} is not available in Habibi's read-only Kubernetes plugin."));
            }
            _ => values.push(part.to_string()),
        }
        index += 1;
    }
    let first = values.first().map(|value| value.to_lowercase()).unwrap_or_default();
    let resource = match first.as_str() {
        "po" | "pod" => "pods".to_string(),
        "deploy" | "deployment" => "deployments".to_string(),
        "svc" | "service" => "services".to_string(),
        "ns" => "namespaces".to_string(),
        "no" => "nodes".to_string(),
        _ => first,
    };
    let with_scope = |mut args: Vec<String>| {
        if all_namespaces {
            args.push("--all-namespaces".into());
        } else if !namespace.is_empty() {
            args.extend(["--namespace".into(), namespace.clone()]);
        }
        if !context.is_empty() {
            args.extend(["--context".into(), context.clone()]);
        }
        args
    };
    let parsed = |action, args| ParsedQuery { action, args, namespace: namespace.clone(), context: context.clone() };
    if verb == "events" || (verb == "get" && resource == "events") {
        return Ok(parsed("events", with_scope(vec!["get".into(), "events".into()])));
    }
    if verb == "logs" {
        let Some(pod) = values.first() else {
            return Err("Say “logs <pod> -n <namespace>”, for example: logs api-7c9d -n production.".into());
        };
        let mut args = with_scope(vec!["logs".into(), pod.clone()]);
        if !container.is_empty() {
            args.extend(["--container".into(), container.clone()]);
        }
        args.extend(["--tail".into(), "200".into()]);
        return Ok(parsed("logs", args));
    }
    if !KINDS.contains(&resource.as_str()) {
        return Err("Use a read-only query such as “get pods”, “describe deployment api”, “logs api-pod -n production”, or “events -n production”.".into());
    }
    if verb == "get" {
        let mut args = vec!["get".to_string(), resource.clone()];
        if let Some(name) = values.get(1) {
            args.push(name.clone());
        }
        args.extend(["--output".into(), "wide".into()]);
        return Ok(parsed("get", with_scope(args)));
    }
    if verb == "describe" {
        let Some(name) = values.get(1) else {
            return Err("Describe needs a resource and name, for example: describe deployment api -n production.".into());
        };
        return Ok(parsed("describe", with_scope(vec!["describe".into(), resource.clone(), name.clone()])));
    }
    Err("Habibi only runs read-only Kubernetes commands: get, describe, logs, and events.".into())
}

/// `query.replace(/^word\s+/i, '')`.
fn strip_word<'a>(query: &'a str, word: &str) -> &'a str {
    let Some(head) = query.get(..word.len()) else { return query };
    let rest = &query[word.len()..];
    if head.eq_ignore_ascii_case(word) && rest.starts_with(char::is_whitespace) {
        rest.trim_start()
    } else {
        query
    }
}

/// Normalize a kind alias; empty when it is not readable here.
pub fn normalized_kind(value: &str) -> &'static str {
    let lower = value.to_lowercase();
    let kind = match lower.as_str() {
        "pod" => "pods",
        "deploy" | "deployment" => "deployments",
        "svc" | "service" => "services",
        "ds" => "daemonsets",
        "sts" => "statefulsets",
        "rs" => "replicasets",
        "job" => "jobs",
        "cronjob" => "cronjobs",
        "ns" => "namespaces",
        "node" => "nodes",
        other => other,
    };
    KINDS.iter().copied().find(|known| *known == kind).unwrap_or("")
}

/// `/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/` and at most `max` characters.
pub fn valid_name(value: &str, max: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 253
        && bytes.len() <= max
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
}

fn scope(kind: &str, namespace: &str, context: &str, all_namespaces: bool) -> Vec<String> {
    let mut args = Vec::new();
    let cluster_scoped = kind == "nodes" || kind == "namespaces";
    if all_namespaces && !cluster_scoped {
        args.push("--all-namespaces".into());
    } else if !namespace.is_empty() && !cluster_scoped {
        args.extend(["--namespace".into(), namespace.to_string()]);
    }
    if !context.is_empty() {
        args.extend(["--context".into(), context.to_string()]);
    }
    args
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn failure(error: impl Into<String>) -> Value {
    json!({ "ok": false, "error": error.into() })
}

struct Audit<'a> {
    action: &'a str,
    namespace: &'a str,
    context: &'a str,
}

pub struct Kubernetes {
    /// `<state root>/kubernetes`, where the Node service kept `audit.jsonl`.
    audit_dir: PathBuf,
    runner: Arc<dyn KubectlRunner>,
    llm: Arc<dyn Llm>,
}

impl Kubernetes {
    pub fn new(state_root: PathBuf, runner: Arc<dyn KubectlRunner>, llm: Arc<dyn Llm>) -> Self {
        Self { audit_dir: state_root.join("kubernetes"), runner, llm }
    }

    pub async fn handle(&self, request: &ApiRequest) -> Option<ApiResponse> {
        let value = match (request.method, request.path.as_str()) {
            (Method::Get, "/api/kubernetes/overview") => {
                self.overview(request.query("context").unwrap_or(""), request.query("namespace").unwrap_or("")).await
            }
            (Method::Post, path @ ("/api/kubernetes/query" | "/api/kubernetes/plan" | "/api/kubernetes/diagnose")) => {
                let body = body!(request.json());
                let (query, context, namespace) =
                    (text(body.get("query")), text(body.get("context")), text(body.get("namespace")));
                match path {
                    "/api/kubernetes/query" => self.query(&query, &context, &namespace).await,
                    "/api/kubernetes/plan" => self.plan(&query, &context, &namespace).await,
                    _ => self.diagnose(&query, &context, &namespace).await,
                }
            }
            (Method::Post, "/api/kubernetes/resources") => self.resources(&body!(request.json())).await,
            (Method::Post, "/api/kubernetes/detail") => self.detail(&body!(request.json())).await,
            (Method::Post, "/api/kubernetes/logs") => self.logs(&body!(request.json())).await,
            _ => return None,
        };
        Some(ApiResponse::json(&value))
    }

    fn audit(&self, audit: &Audit<'_>, exit: i32) {
        // Auditing must never make a read-only inspection unavailable.
        if util::create_private_dir(&self.audit_dir).is_err() {
            return;
        }
        let none_if_empty = |value: &str| if value.is_empty() { Value::Null } else { Value::from(value) };
        let line = json!({
            "at": util::iso_now(),
            "action": audit.action,
            "namespace": none_if_empty(audit.namespace),
            "context": none_if_empty(audit.context),
            "exit": exit,
        });
        let _ = util::append_private(&self.audit_dir.join("audit.jsonl"), format!("{line}\n").as_bytes());
    }

    /// One bounded kubectl read; `Ok(stdout)` or a short message.
    async fn read(&self, args: Vec<String>, audit: Audit<'_>, max_output_bytes: usize) -> Result<String, String> {
        let (result, exit) = match self.runner.run(&args, max_output_bytes).await {
            RunOutcome::Exited { code: 0, stdout, .. } => (Ok(stdout), 0),
            RunOutcome::Exited { code, stderr, .. } => {
                let message = if stderr.is_empty() { "kubectl failed.".to_string() } else { stderr };
                (Err(util::take(message.trim(), 4_000)), code)
            }
            RunOutcome::TooLarge => (
                Err("This Kubernetes response is too large to display safely. Narrow the namespace or resource.".into()),
                1,
            ),
            RunOutcome::TimedOut => (Err("kubectl timed out after 10 seconds.".into()), 124),
            RunOutcome::NotFound => (Err("kubectl is not installed or not on Habibi’s PATH.".into()), 127),
            RunOutcome::StartFailed => (Err("Could not start kubectl.".into()), 127),
        };
        self.audit(&audit, exit);
        result
    }

    /// `/api/kubernetes/query`: run a parsed read-only query.
    pub async fn query(&self, input: &str, preferred_context: &str, preferred_namespace: &str) -> Value {
        let mut parsed = match parse_query(input, preferred_context) {
            Ok(parsed) => parsed,
            Err(error) => return failure(error),
        };
        // A command that already names a scope always wins. Otherwise the explorer's
        // namespace selector provides the safe default scope for a read.
        if !preferred_namespace.is_empty()
            && parsed.namespace.is_empty()
            && !parsed.args.iter().any(|arg| arg == "--all-namespaces")
        {
            let insertion = parsed.args.iter().position(|arg| arg == "--context").unwrap_or(parsed.args.len());
            parsed.args.splice(insertion..insertion, ["--namespace".to_string(), preferred_namespace.to_string()]);
            parsed.namespace = preferred_namespace.to_string();
        }
        let audit = Audit { action: parsed.action, namespace: &parsed.namespace, context: &parsed.context };
        match self.read(parsed.args.clone(), audit, DEFAULT_OUTPUT_BYTES).await {
            Ok(output) => json!({ "ok": true, "output": output, "action": parsed.action }),
            Err(error) => json!({ "ok": false, "error": error, "action": parsed.action }),
        }
    }

    /// `/api/kubernetes/overview`: contexts, namespaces and the first rows of
    /// pods, deployments and services.
    pub async fn overview(&self, requested_context: &str, requested_namespace: &str) -> Value {
        let no_scope = |action| Audit { action, namespace: "", context: "" };
        let contexts = match self
            .read(strings(&["config", "get-contexts", "-o", "name"]), no_scope("contexts"), DEFAULT_OUTPUT_BYTES)
            .await
        {
            Ok(output) => output
                .split('\n')
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .take(100)
                .map(str::to_string)
                .collect::<Vec<_>>(),
            Err(error) => return json!({ "ok": false, "error": error, "contexts": [], "resources": [] }),
        };
        let current = self
            .read(strings(&["config", "current-context"]), no_scope("current-context"), DEFAULT_OUTPUT_BYTES)
            .await
            .map(|output| output.trim().to_string())
            .unwrap_or_default();
        let context = if contexts.iter().any(|item| item == requested_context) {
            requested_context.to_string()
        } else if contexts.contains(&current) {
            current
        } else {
            contexts.first().cloned().unwrap_or_default()
        };
        if !requested_namespace.is_empty() && !valid_name(requested_namespace, 62) {
            return json!({ "ok": false, "error": "That namespace is not valid.", "contexts": contexts, "resources": [] });
        }
        let scoped = |args: &[&str]| {
            let mut args = strings(args);
            if !context.is_empty() {
                args.extend(["--context".into(), context.clone()]);
            }
            args
        };
        let namespaces_output = self
            .read(
                scoped(&["get", "namespaces", "--output", "json"]),
                Audit { action: "namespaces", namespace: "", context: &context },
                1_000_000,
            )
            .await;
        let mut namespaces: Vec<String> = namespaces_output
            .ok()
            .and_then(|output| serde_json::from_str::<Value>(&output).ok())
            .map(|value| {
                array(value.get("items"))
                    .iter()
                    .filter_map(|item| item.pointer("/metadata/name"))
                    .filter(|name| truthy(Some(name)))
                    .map(js_string)
                    .collect()
            })
            .unwrap_or_default();
        namespaces.sort();
        let namespace =
            if namespaces.iter().any(|item| item == requested_namespace) { requested_namespace } else { "" };
        let scope_args: Vec<&str> =
            if namespace.is_empty() { vec!["--all-namespaces"] } else { vec!["--namespace", namespace] };
        let list = |kind: &'static str| {
            let mut args = vec!["get", kind];
            args.extend(&scope_args);
            args.extend(["--output", "json"]);
            let args = scoped(&args);
            let action = format!("overview-{kind}");
            let context = context.clone();
            async move {
                // The overview needs enough of a list response to parse and compact it,
                // then exposes only the first 80 rows. Arbitrary user queries retain the
                // much smaller default output limit above.
                let result = self.read(args, Audit { action: &action, namespace, context: &context }, 4_000_000).await;
                match result {
                    Err(error) => json!({ "kind": kind, "ok": false, "error": error, "items": [] }),
                    Ok(output) => match serde_json::from_str::<Value>(&output) {
                        Ok(value) => json!({ "kind": kind, "ok": true, "items": overview_items(kind, array(value.get("items"))) }),
                        Err(_) => json!({
                            "kind": kind,
                            "ok": false,
                            "error": format!("Could not read {kind} returned by kubectl."),
                            "items": [],
                        }),
                    },
                }
            }
        };
        let (pods, deployments, services) = tokio::join!(list("pods"), list("deployments"), list("services"));
        json!({
            "ok": true,
            "contexts": contexts,
            "context": context,
            "namespaces": namespaces,
            "namespace": namespace,
            "resources": [pods, deployments, services],
        })
    }

    /// `/api/kubernetes/resources`: one kind for the explorer.
    pub async fn resources(&self, payload: &Value) -> Value {
        let kind = normalized_kind(&text(payload.get("kind")));
        let context = text(payload.get("context")).trim().to_string();
        let namespace = text(payload.get("namespace")).trim().to_string();
        if kind.is_empty() {
            return failure("That Kubernetes resource is not available in the read-only explorer.");
        }
        if !namespace.is_empty() && !valid_name(&namespace, 62) {
            return failure("That namespace is not valid.");
        }
        let mut args = strings(&["get", kind]);
        args.extend(scope(kind, &namespace, &context, namespace.is_empty()));
        args.extend(strings(&["--output", "json"]));
        let action = format!("browse-{kind}");
        let audit = Audit { action: &action, namespace: &namespace, context: &context };
        match self.read(args, audit, 4_000_000).await {
            Err(error) => failure(error),
            Ok(output) => match serde_json::from_str::<Value>(&output) {
                Ok(value) => {
                    let mut items = overview_items(kind, array(value.get("items")));
                    items.truncate(150);
                    json!({ "ok": true, "kind": kind, "items": items })
                }
                Err(_) => failure(format!("Could not read {kind} returned by kubectl.")),
            },
        }
    }

    /// `/api/kubernetes/detail`: one resource, plus its pods for workloads.
    pub async fn detail(&self, payload: &Value) -> Value {
        let kind = normalized_kind(&text(payload.get("kind")));
        let name = text(payload.get("name")).trim().to_string();
        let namespace = text(payload.get("namespace")).trim().to_string();
        let context = text(payload.get("context")).trim().to_string();
        if kind.is_empty() || !valid_name(&name, 252) {
            return failure("That resource is not available for inspection.");
        }
        if !namespace.is_empty() && !valid_name(&namespace, 62) {
            return failure("That namespace is not valid.");
        }
        let mut args = strings(&["get", kind, &name]);
        args.extend(scope(kind, &namespace, &context, false));
        args.extend(strings(&["--output", "json"]));
        let action = format!("detail-{kind}");
        let output = match self
            .read(args, Audit { action: &action, namespace: &namespace, context: &context }, DEFAULT_OUTPUT_BYTES)
            .await
        {
            Ok(output) => output,
            Err(error) => return failure(error),
        };
        let unreadable = || failure("kubectl returned a resource Habibi could not read.");
        let Ok(value) = serde_json::from_str::<Value>(&output) else { return unreadable() };
        let mut detail = format_detail(kind, &value);
        let selector = match value.pointer("/spec/selector/matchLabels") {
            Some(Value::Object(labels)) => labels
                .iter()
                .map(|(key, label)| format!("{key}={}", js_string(label)))
                .collect::<Vec<_>>()
                .join(","),
            _ => String::new(),
        };
        let workload = ["deployments", "jobs", "statefulsets", "daemonsets", "replicasets"].contains(&kind);
        if !selector.is_empty() && workload && !namespace.is_empty() {
            let mut args = strings(&["get", "pods", "--namespace", &namespace, "--selector", &selector, "--output", "json"]);
            if !context.is_empty() {
                args.extend(["--context".into(), context.clone()]);
            }
            let action = format!("related-pods-{kind}");
            let pods = self.read(args, Audit { action: &action, namespace: &namespace, context: &context }, 1_500_000).await;
            if let Ok(output) = pods {
                let Ok(value) = serde_json::from_str::<Value>(&output) else { return unreadable() };
                let mut related = overview_items("pods", array(value.get("items")));
                related.truncate(50);
                detail.insert("relatedPods".into(), Value::Array(related));
            }
        }
        json!({ "ok": true, "detail": detail })
    }

    /// `/api/kubernetes/logs`: the last 200 lines of one pod.
    pub async fn logs(&self, payload: &Value) -> Value {
        let pod = text(payload.get("pod")).trim().to_string();
        let namespace = text(payload.get("namespace")).trim().to_string();
        let context = text(payload.get("context")).trim().to_string();
        let container = text(payload.get("container")).trim().to_string();
        if !valid_name(&pod, 252) || !valid_name(&namespace, 62) || (!container.is_empty() && !valid_name(&container, 252)) {
            return failure("Choose a valid pod and namespace to read logs.");
        }
        let mut args = strings(&["logs", &pod, "--namespace", &namespace]);
        if !container.is_empty() {
            args.extend(["--container".into(), container.clone()]);
        }
        args.extend(strings(&["--tail", "200"]));
        if !context.is_empty() {
            args.extend(["--context".into(), context.clone()]);
        }
        match self.read(args, Audit { action: "logs", namespace: &namespace, context: &context }, 1_000_000).await {
            Ok(output) => json!({ "ok": true, "output": output, "pod": pod, "namespace": namespace, "container": container }),
            Err(error) => failure(error),
        }
    }

    async fn local_model(&self) -> bool {
        let state = self.llm.state().await;
        state.configured && state.provider.as_deref().is_some_and(|provider| LOCAL_PROVIDERS.contains(&provider))
    }

    /// The plugin's `plan`: ask the local model for one constrained query.
    async fn plan_query(&self, request: &str) -> Result<(String, String), Value> {
        if !self.local_model().await {
            return Err(failure(
                "Configure a local model to interpret Kubernetes requests, or use a kubectl-style command.",
            ));
        }
        let answer = self
            .llm
            .complete(CompletionRequest {
                system_prompt: Some(PLAN_PROMPT.into()),
                messages: vec![ChatMessage { role: "user".into(), text: request.into() }],
                temperature: Some(0.0),
                max_tokens: Some(180),
            })
            .await;
        if !answer.ok {
            return Err(serde_json::to_value(&answer).unwrap_or_else(|_| json!({ "ok": false })));
        }
        let reply = answer.text.unwrap_or_else(|| "undefined".into());
        let candidate = match (reply.find('{'), reply.rfind('}')) {
            (Some(start), Some(end)) if end > start => &reply[start..=end],
            _ => "{}",
        };
        match serde_json::from_str::<Value>(candidate) {
            Ok(value) => match value.get("query") {
                Some(Value::String(query)) => {
                    let summary = value.get("summary").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    Ok((query.trim().to_string(), summary))
                }
                _ => Err(failure("The local model did not return a Kubernetes query.")),
            },
            Err(_) => Err(failure("The local model returned an unreadable Kubernetes plan.")),
        }
    }

    /// `/api/kubernetes/plan`: translate a request, then run it read-only.
    pub async fn plan(&self, query: &str, preferred_context: &str, preferred_namespace: &str) -> Value {
        let (planned, summary) = match self.plan_query(query).await {
            Ok(plan) => plan,
            Err(error) => return error,
        };
        let mut result = self.query(&planned, preferred_context, preferred_namespace).await;
        let ok = result.get("ok") == Some(&Value::Bool(true));
        if let Value::Object(map) = &mut result {
            map.insert("plannedQuery".into(), Value::from(planned));
            map.insert("summary".into(), Value::from(summary));
            map.insert(
                "trace".into(),
                json!([
                    { "tool": "Local intent planner", "detail": "Translated your request into a constrained read-only query." },
                    {
                        "tool": "kubectl read",
                        "detail": if ok { "Read completed using your selected context." } else { "The read was rejected or could not complete." },
                    },
                ]),
            );
        }
        result
    }

    /// `/api/kubernetes/diagnose`: find the workload the request names, read
    /// its detail and logs, and summarize with the local model when present.
    pub async fn diagnose(&self, request: &str, preferred_context: &str, preferred_namespace: &str) -> Value {
        let mut trace = Vec::new();
        let overview = self.overview(preferred_context, preferred_namespace).await;
        if overview.get("ok") != Some(&Value::Bool(true)) {
            return overview;
        }
        let scope = util::string_or_empty(overview.get("namespace"));
        trace.push(json!({
            "tool": "list_resources",
            "detail": format!(
                "Inspected pods, deployments, and services in {}.",
                if scope.is_empty() { "all namespaces" } else { &scope }
            ),
        }));
        let request_words = words(request);
        let mut candidates: Vec<(usize, Map<String, Value>)> = array(overview.get("resources"))
            .iter()
            .flat_map(|resource| {
                let kind = resource.get("kind").cloned().unwrap_or(Value::Null);
                array(resource.get("items")).iter().map(move |item| {
                    let mut item = util::record(Some(item));
                    item.insert("kind".into(), kind.clone());
                    item
                })
            })
            .map(|item| {
                let haystack = format!(
                    "{} {}",
                    item.get("name").map(js_string).unwrap_or_else(|| "undefined".into()),
                    item.get("namespace").map(js_string).unwrap_or_else(|| "undefined".into())
                )
                .to_lowercase();
                (request_words.iter().filter(|word| haystack.contains(word.as_str())).count(), item)
            })
            .collect();
        candidates.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        let Some((_, target)) = candidates.iter().find(|(score, _)| *score > 0) else {
            let mut namespaces: Vec<String> = Vec::new();
            for (_, item) in &candidates {
                let namespace = util::string_or_empty(item.get("namespace"));
                if !namespace.is_empty() && !namespaces.contains(&namespace) {
                    namespaces.push(namespace);
                }
            }
            namespaces.truncate(8);
            let summary = if namespaces.is_empty() {
                "I found no pods, deployments, or services in this scope. Which context or namespace should I inspect?".to_string()
            } else {
                format!(
                    "I could not identify a matching workload yet. I found resources in {}. Which namespace, workload, or pod should I inspect?",
                    namespaces.join(", ")
                )
            };
            return json!({ "ok": true, "clarification": true, "summary": summary, "trace": trace, "candidates": [], "evidence": [] });
        };
        let overview_context = overview.get("context").cloned().unwrap_or(Value::Null);
        let mut detail_result = self
            .detail(&json!({
                "kind": target.get("kind"),
                "name": target.get("name"),
                "namespace": target.get("namespace"),
                "context": overview_context,
            }))
            .await;
        if detail_result.get("ok") != Some(&Value::Bool(true)) {
            if let Value::Object(map) = &mut detail_result {
                map.insert("trace".into(), Value::Array(trace));
            }
            return detail_result;
        }
        let detail = detail_result.get("detail").cloned().unwrap_or(Value::Null);
        let field = |key: &str| util::string_or_empty(detail.get(key));
        let (kind, name, namespace) = (field("kind"), field("name"), field("namespace"));
        trace.push(json!({
            "tool": "inspect_resource",
            "detail": format!(
                "Inspected {kind}/{name} in {}.",
                if namespace.is_empty() { "the cluster" } else { &namespace }
            ),
        }));
        let log_pod = if kind == "pods" { Some(&detail) } else { array(detail.get("relatedPods")).first() };
        let mut logs = String::new();
        if let Some(pod) = log_pod.filter(|pod| truthy(pod.get("name")) && truthy(pod.get("namespace"))) {
            let pod_name = js_string(&pod["name"]);
            let result = self
                .logs(&json!({ "pod": pod["name"], "namespace": pod["namespace"], "context": overview_context }))
                .await;
            if result.get("ok") == Some(&Value::Bool(true)) {
                logs = util::take_last(&util::string_or_empty(result.get("output")), 12_000);
                trace.push(json!({
                    "tool": "read_logs",
                    "detail": format!("Read the latest bounded log tail from {pod_name}."),
                }));
            }
        }
        let mut evidence = vec![format!(
            "Target: {kind}/{name} namespace={}",
            if namespace.is_empty() { "cluster" } else { &namespace }
        )];
        for fact in array(detail.get("facts")) {
            let pair = array(Some(fact));
            let part = |index: usize| pair.get(index).map(js_string).unwrap_or_else(|| "undefined".into());
            evidence.push(format!("{}: {}", part(0), part(1)));
        }
        for item in array(detail.get("conditions")) {
            let get = |key: &str| item.get(key).map(js_string).unwrap_or_default();
            let reason = util::string_or_empty(item.get("reason"));
            let message = util::string_or_empty(item.get("message"));
            evidence.push(format!(
                "Condition {}: {}{}{}",
                get("type"),
                get("status"),
                if reason.is_empty() { String::new() } else { format!(" ({reason})") },
                if message.is_empty() { String::new() } else { format!(" — {message}") },
            ));
        }
        for item in array(detail.get("containers")) {
            let get = |key: &str| item.get(key).map(js_string).unwrap_or_default();
            evidence.push(format!(
                "Container {}: {}, ready={}, restarts={}",
                get("name"),
                get("state"),
                get("ready"),
                get("restarts")
            ));
        }
        if !logs.is_empty() {
            evidence.push(format!("Recent logs:\n{logs}"));
        }
        let mut summary = format!("Inspected {kind}/{name}.");
        if self.local_model().await {
            let answer = self
                .llm
                .complete(CompletionRequest {
                    system_prompt: Some(DIAGNOSE_PROMPT.into()),
                    messages: vec![ChatMessage {
                        role: "user".into(),
                        text: format!("Request: {request}\n\nEvidence:\n{}", evidence.join("\n")),
                    }],
                    temperature: Some(0.0),
                    max_tokens: Some(320),
                })
                .await;
            if let (true, Some(text)) = (answer.ok, answer.text.filter(|text| !text.is_empty())) {
                summary = text.trim().to_string();
            }
        }
        json!({
            "ok": true,
            "target": { "kind": detail.get("kind"), "name": detail.get("name"), "namespace": detail.get("namespace") },
            "summary": summary,
            "trace": trace,
            "evidence": evidence,
            "logs": logs,
        })
    }
}

/// `text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)` as a set.
fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut found: Vec<String> = Vec::new();
    for run in lower.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')) {
        let word = run.trim_start_matches('-');
        if word.len() >= 3 && !found.iter().any(|known| known == word) {
            found.push(word.to_string());
        }
    }
    found
}

#[cfg(test)]
mod tests;
