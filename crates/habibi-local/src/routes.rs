//! The `/api/*` routes ported from server.js. JSON envelopes are always HTTP
//! 200 with `{ ok, ... }`; `/api/file` and `/api/app-icon` are binary.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use habibi_core::api::text;
use habibi_core::{ApiRequest, ApiResponse, ApprovalService, Method};
use habibi_platform::system::SystemAction;
use regex::Regex;
use serde_json::{Value, json};

use crate::LocalServices;
use crate::desktop::Desktop;
use crate::files::{find_local_files, relative_file_window};
use crate::investigate::{
    Plan, history, latest_user_text, plan_file_investigation, rank_file_candidates,
};
use crate::util::{base_name, base64url, home_file, home_path, js_number, now_ms, utf16_slice};

/// The JSON body as an object-like value, or the Node host's `Invalid
/// request.` envelope (`null` bodies threw there too).
fn body(request: &ApiRequest) -> Result<Value, ApiResponse> {
    match request.json()? {
        Value::Null => Err(ApiResponse::invalid_request()),
        value => Ok(value),
    }
}

macro_rules! body_or_return_some {
    ($request:expr) => {
        match body($request) {
            Ok(value) => value,
            Err(response) => return Some(response),
        }
    };
}

macro_rules! body_or_return {
    ($request:expr) => {
        match body($request) {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

fn ok(value: bool) -> ApiResponse {
    ApiResponse::json(&json!({ "ok": value }))
}

fn platform_error(error: habibi_platform::PlatformError) -> ApiResponse {
    ApiResponse::error(error.to_string())
}

fn mime(target: &Path) -> &'static str {
    let extension = crate::util::extname(&base_name(target)).to_lowercase();
    match extension.as_str() {
        ".pdf" => "application/pdf",
        ".txt" => "text/plain; charset=utf-8",
        ".md" => "text/markdown; charset=utf-8",
        ".csv" => "text/csv; charset=utf-8",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".heic" => "image/heic",
        _ => "application/octet-stream",
    }
}

/// Keep only characters that are safe unquoted in a header value, and fall
/// back to a generic name (CR/LF would otherwise break the header).
fn disposition_name(target: &Path) -> String {
    let safe: String = base_name(target)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(200)
        .collect();
    if safe.is_empty() { "file".into() } else { safe }
}

fn agent_line() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?:^|\s)(codex|claude)(?:\s|$|[-_])").expect("valid pattern")
    })
}

fn plural(count: usize, word: &str, suffix: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { suffix })
}

impl LocalServices {
    async fn blocking<T: Send + 'static>(
        &self,
        run: impl FnOnce(&dyn Desktop) -> T + Send + 'static,
    ) -> Option<T> {
        let desktop = self.desktop.clone();
        tokio::task::spawn_blocking(move || run(desktop.as_ref()))
            .await
            .ok()
    }

    pub(crate) async fn route(&self, request: &ApiRequest) -> Option<ApiResponse> {
        use Method::{Get, Post};
        Some(match (request.method, request.path.as_str()) {
            (Post, "/api/analytics/capture") => self.analytics_capture(request),
            (Post, "/api/approvals") => self.issue_approval(request),
            (Get, "/api/skills") => {
                ApiResponse::json(&json!({ "ok": true, "skills": self.skills }))
            }
            (Get, "/api/apps") => self.list_apps(request).await,
            (Get, "/api/app-icon") => self.app_icon(request).await,
            (Post, "/api/open-app") => self.open_app(request).await,
            (Post, "/api/open-file") => self.open_file(request),
            (Post, "/api/open-folder") => self.open_folder(request).await,
            (Post, "/api/open-url") => self.open_url(request),
            (Post, "/api/browser/open") => self.browser_open(request).await,
            (Post, "/api/system/action") => self.system_action(request).await,
            (Get, "/api/running-apps") => match self.running_apps().await {
                Some(apps) => ApiResponse::json(&json!({ "ok": true, "apps": apps })),
                None => ApiResponse::json(&json!({ "ok": false, "apps": [] })),
            },
            (Post, "/api/running-apps/action") => self.running_app_action(request).await,
            (Post, "/api/preview-file") => self.preview_file(request),
            (Post, "/api/quick-look") => self.quick_look(request).await,
            (Get, "/api/file") => self.file(request).await,
            (Get, "/api/files") => {
                let query = request.query("q").unwrap_or("");
                // Keep natural timing words in the request. `find_local_files`
                // removes them from the filename predicate but uses them to
                // prefer the files a person just created, downloaded or viewed.
                let window = relative_file_window(query, now_ms());
                ApiResponse::json(
                    &find_local_files(&self.search, &self.paths.home, query, 8, window).await,
                )
            }
            (Get, "/api/search/status") => self.search_status(),
            (Post, "/api/search/refresh") => {
                self.search.refresh().await;
                self.search_status()
            }
            (Post, "/api/agent/files/investigate") => self.investigate(request).await,
            (Get, "/api/agents") => self.agents().await,
            (Post, "/api/agents/open-project") => self.agent_action(request, false).await,
            (Post, "/api/agents/resume") => self.agent_action(request, true).await,
            (Get, "/api/agent-sessions") => {
                let (kind, query) = (
                    request.query("kind").unwrap_or("").to_string(),
                    request.query("q").unwrap_or("").to_string(),
                );
                let sessions = self.sessions.clone();
                tokio::task::spawn_blocking(move || sessions.list(&kind, &query))
                    .await
                    .map(|value| ApiResponse::json(&value))
                    .unwrap_or_else(|_| ApiResponse::json(&json!({ "ok": true, "sessions": [] })))
            }
            (Post, "/api/agent-sessions/detail") => {
                let body = body_or_return_some!(request);
                let (id, kind) = (text(body.get("id")), text(body.get("kind")));
                let sessions = self.sessions.clone();
                tokio::task::spawn_blocking(move || sessions.detail(&id, &kind))
                    .await
                    .map(|value| ApiResponse::json(&value))
                    .unwrap_or_else(|_| {
                        ApiResponse::error("That session is no longer available locally.")
                    })
            }
            _ => return None,
        })
    }

    fn analytics_capture(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        // Intentionally acknowledge immediately; product analytics must never delay the launcher.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let analytics = self.analytics.clone();
            runtime.spawn(async move {
                analytics.capture(&body).await;
            });
        }
        ok(true)
    }

    fn issue_approval(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let action = text(body.get("action"));
        if !ApprovalService::is_approvable(&action) {
            return ApiResponse::error("Unsupported approval action");
        }
        // The token is bound to this exact payload. The consuming route
        // re-derives the payload from its own request body, so a token issued
        // for one message, event or skill call cannot authorize a different one.
        let payload = body.get("payload").cloned().unwrap_or(Value::Null);
        ApiResponse::json(
            &json!({ "ok": true, "approval": self.approvals.issue(&action, payload) }),
        )
    }

    async fn list_apps(&self, request: &ApiRequest) -> ApiResponse {
        let query = request.query("q").unwrap_or("").to_string();
        let apps = self.apps.apps(&self.desktop).await;
        let matches: Vec<Value> = crate::apps::search(&apps, &query)
            .into_iter()
            .map(|app| json!({ "path": app.path, "name": app.name }))
            .collect();
        ApiResponse::json(&json!({ "ok": true, "apps": matches }))
    }

    async fn app_icon(&self, request: &ApiRequest) -> ApiResponse {
        let requested = request.query("path").unwrap_or("").to_string();
        let cache_dir = self.paths.state_root.join("app-icons");
        let result = self
            .blocking(move |desktop| {
                let target = desktop.allowed_app(&requested)?;
                let cache = cache_dir.join(format!(
                    "{}.png",
                    base64url(target.to_string_lossy().as_bytes())
                ));
                if let Ok(bytes) = std::fs::read(&cache) {
                    return Some(bytes);
                }
                let bytes = desktop.app_icon(&target)?;
                if std::fs::create_dir_all(&cache_dir).is_ok() {
                    let _ = std::fs::write(&cache, &bytes);
                }
                Some(bytes)
            })
            .await
            .flatten();
        match result {
            Some(bytes) => ApiResponse::bytes("image/png", bytes)
                .with_header("Cache-Control", "private, max-age=86400"),
            None => ApiResponse::not_found(),
        }
    }

    async fn open_app(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let requested = text(body.get("path"));
        // Wait until the OS has accepted the request. This gives the UI a
        // truthful “Opening…” state instead of immediately claiming success
        // while the launch is still happening in the background.
        let opened = self
            .blocking(move |desktop| {
                desktop
                    .allowed_app(&requested)
                    .is_some_and(|target| desktop.launch_app(&target))
            })
            .await
            .unwrap_or(false);
        ok(opened)
    }

    fn open_file(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let Some(target) = home_path(&self.paths.home, body.get("path")) else {
            return ok(false);
        };
        self.desktop.open_detached(&target.to_string_lossy());
        self.record(&target);
        ok(true)
    }

    fn record(&self, target: &Path) {
        use habibi_core::services::RecentFiles;
        crate::recent::RecentRecorder(self.recent.clone()).record(&target.to_string_lossy());
    }

    async fn open_folder(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let home = self.paths.home.clone();
        if home.as_os_str().is_empty() || !home.is_absolute() {
            return ok(false);
        }
        let name = text(body.get("folder"));
        let Some(target) =
            habibi_platform::folders::named_folder(&home, &name).filter(|target| target.exists())
        else {
            return ok(false);
        };
        let opened_target = target.clone();
        let opened = self
            .blocking(move |desktop| desktop.open_and_wait(&opened_target.to_string_lossy()))
            .await
            .unwrap_or(false);
        if opened {
            self.record(&target);
        }
        ok(opened)
    }

    fn open_url(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let Ok(target) = url::Url::parse(&text(body.get("url"))) else {
            return ok(false);
        };
        let host = target.host_str().unwrap_or("").to_lowercase();
        let suffix = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
        let allowed = target.scheme() == "https"
            && (suffix("google.com") || suffix("airbnb.com") || suffix("airbnb.co.uk"));
        if !allowed {
            return ok(false);
        }
        ok(self.desktop.open_detached(target.as_str()))
    }

    async fn browser_open(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let Some(url) = crate::browser_url::browser_url_value(body.get("url")) else {
            return ApiResponse::error(
                "Use an HTTP or HTTPS website address without embedded credentials.",
            );
        };
        let token = body.get("approvalToken").and_then(Value::as_str);
        if !self
            .approvals
            .consume(token, "browser.open", &json!({ "url": url }))
        {
            return ApiResponse::error(
                "Opening this website needs approval for this exact address.",
            );
        }
        let opened = self
            .blocking(move |desktop| desktop.open_and_wait(&url))
            .await
            .unwrap_or(false);
        if opened {
            ok(true)
        } else {
            ApiResponse::error("The website could not be opened.")
        }
    }

    async fn system_action(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let action = text(body.get("action"));
        let open = match action.as_str() {
            "applications" => Some(self.desktop.open_applications()),
            "settings" => Some(self.desktop.open_settings()),
            _ => None,
        };
        if let Some(result) = open {
            return ok(result.is_ok());
        }
        let Some(system) = SystemAction::parse(&action) else {
            return ApiResponse::error("Unknown system action");
        };
        let token = body.get("approvalToken").and_then(Value::as_str);
        if !self.approvals.consume(
            token,
            &format!("system.{action}"),
            &json!({ "action": action }),
        ) {
            return ApiResponse::error("This system action needs explicit approval.");
        }
        match self
            .blocking(move |desktop| desktop.system_action(system))
            .await
        {
            Some(Ok(())) => ok(true),
            Some(Err(error)) => platform_error(error),
            None => ApiResponse::error("The system action could not be started."),
        }
    }

    async fn running_apps(&self) -> Option<Vec<Value>> {
        let apps = self.apps.apps(&self.desktop).await;
        let running = self
            .blocking(move |desktop| {
                let processes = desktop.processes();
                desktop.running_apps(&apps, &processes)
            })
            .await?;
        Some(
            running
                .into_iter()
                .map(|app| json!({ "name": app.name, "path": app.path, "pids": app.pids, "cpu": app.cpu, "memoryMb": app.memory_mb }))
                .collect(),
        )
    }

    async fn running_app_action(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let mode = match body.get("mode").and_then(Value::as_str) {
            Some("force") => Some("force"),
            Some("quit") => Some("quit"),
            _ => None,
        };
        let own = std::process::id();
        let mut seen = HashSet::new();
        let pids: Vec<u32> = body
            .get("pids")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(js_number)
                    .filter(|pid| pid.fract() == 0.0 && *pid > 1.0 && *pid <= f64::from(u32::MAX))
                    .map(|pid| pid as u32)
                    .filter(|pid| *pid != own && seen.insert(*pid))
                    .take(64)
                    .collect()
            })
            .unwrap_or_default();
        let app = utf16_slice(&text(body.get("app")), 160);
        let (Some(mode), false, false) = (mode, app.is_empty(), pids.is_empty()) else {
            return ApiResponse::error("Choose an open application first.");
        };
        let payload = json!({ "app": app, "mode": mode, "pids": pids });
        let token = body.get("approvalToken").and_then(Value::as_str);
        if !self
            .approvals
            .consume(token, &format!("running-app.{mode}"), &payload)
        {
            return ApiResponse::error("Quitting an app needs explicit approval.");
        }
        let current = self.running_apps().await.unwrap_or_default();
        let still_running = current.iter().any(|item| {
            let listed: Vec<u64> = item["pids"]
                .as_array()
                .map(|p| p.iter().filter_map(Value::as_u64).collect())
                .unwrap_or_default();
            item["name"] == json!(app)
                && listed.len() == pids.len()
                && listed.iter().all(|pid| pids.contains(&(*pid as u32)))
        });
        if !still_running {
            return ApiResponse::error(
                "That app is no longer running. Refresh the list and try again.",
            );
        }
        let force = mode == "force";
        // A process may exit between listing and action; count what was signalled.
        let stopped = self
            .blocking(move |desktop| {
                pids.iter()
                    .filter(|pid| desktop.terminate(**pid, force))
                    .count()
            })
            .await
            .unwrap_or(0);
        ApiResponse::json(&json!({ "ok": stopped > 0, "stopped": stopped }))
    }

    fn preview_file(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let Some(target) = home_path(&self.paths.home, body.get("path")) else {
            return ok(false);
        };
        match self.desktop.preview_file(&target) {
            Ok(()) => ok(true),
            Err(error) => platform_error(error),
        }
    }

    async fn quick_look(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        if self
            .blocking(|desktop| desktop.quick_look_close())
            .await
            .unwrap_or(false)
        {
            return ApiResponse::json(&json!({ "ok": true, "state": "closed" }));
        }
        let Some(target) = home_path(&self.paths.home, body.get("path")) else {
            return ok(false);
        };
        if let Err(error) = self.desktop.quick_look_open(&target) {
            return platform_error(error);
        }
        self.record(&target);
        ApiResponse::json(&json!({ "ok": true, "state": "opened" }))
    }

    async fn file(&self, request: &ApiRequest) -> ApiResponse {
        let requested = request.query("path").unwrap_or("");
        let Some(target) = home_file(&self.paths.home, requested) else {
            return ApiResponse::not_found();
        };
        match tokio::fs::read(&target).await {
            Ok(bytes) => ApiResponse::bytes(mime(&target), bytes).with_header(
                "Content-Disposition",
                &format!("inline; filename=\"{}\"", disposition_name(&target)),
            ),
            Err(_) => ApiResponse::not_found(),
        }
    }

    fn search_status(&self) -> ApiResponse {
        let mut status = self.search.status();
        status["ok"] = json!(true);
        ApiResponse::json(&status)
    }

    async fn investigate(&self, request: &ApiRequest) -> ApiResponse {
        let body = body_or_return!(request);
        let history = history(body.get("history"));
        let plan = plan_file_investigation(self.llm.as_ref(), &history).await;
        let queries = match plan {
            Plan::NotApplicable => {
                return ApiResponse::json(&json!({ "ok": true, "phase": "not_applicable" }));
            }
            Plan::Clarify(question) => {
                return ApiResponse::json(&json!({
                    "ok": true,
                    "phase": "clarify",
                    "question": question,
                    "trace": [{ "tool": "Local file planner", "detail": "Need one detail before searching accurately." }],
                }));
            }
            Plan::Search(queries) => queries,
        };
        let window = relative_file_window(&latest_user_text(&history), now_ms());
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        for query in queries.iter().take(3) {
            for file in find_local_files(&self.search, &self.paths.home, query, 10, window).await {
                if seen.insert(file.path.clone()) {
                    candidates.push(file);
                }
            }
        }
        candidates.truncate(18);
        let ranked = rank_file_candidates(self.llm.as_ref(), &history, &candidates).await;
        let order = |path: &str| ranked.ids.iter().position(|id| id == path).unwrap_or(999);
        candidates.sort_by(|a, b| {
            order(&a.path)
                .cmp(&order(&b.path))
                .then(b.score.cmp(&a.score))
        });
        let files: Vec<Value> = candidates
            .iter()
            .take(8)
            .map(|file| json!({ "path": file.path, "name": file.name, "folder": file.folder, "directory": file.directory, "fileTimestamp": file.file_timestamp }))
            .collect();
        let found = format!(
            "I found {} to review.",
            plural(files.len(), "likely local file", "s")
        );
        let ranked_summary = ranked.summary.clone().filter(|summary| !summary.is_empty());
        let summary = if !files.is_empty() {
            if ranked.ids.is_empty() {
                found
            } else {
                ranked_summary.unwrap_or(found)
            }
        } else {
            ranked_summary.unwrap_or_else(|| "I could not find matching local files. Try a filename or one detail from the document.".into())
        };
        ApiResponse::json(&json!({
            "ok": true,
            "phase": "results",
            "summary": summary,
            "files": files,
            "searched": queries,
            "trace": [
                { "tool": "Local file planner", "detail": format!("Prepared {}.", plural(queries.len(), "focused filename search", "es")) },
                {
                    "tool": "Filename search",
                    "detail": if files.is_empty() { "No close filename candidates yet.".to_string() } else { format!("Found {} locally.", plural(files.len(), "candidate", "s")) },
                },
                {
                    "tool": "Local ranker",
                    "detail": if files.is_empty() { "Suggested the next refinement." } else { "Ranked candidates using names and locations." },
                },
            ],
        }))
    }

    async fn agents(&self) -> ApiResponse {
        let agents = self
            .blocking(|desktop| {
                desktop
                    .processes()
                    .into_iter()
                    .filter(|process| !process.command.trim().is_empty())
                    .filter(|process| {
                        let line = format!(
                            "{} {} {}",
                            process.pid,
                            habibi_platform::processes::format_elapsed(process.run_time),
                            process.command.trim()
                        );
                        agent_line().is_match(&line)
                    })
                    .take(20)
                    .map(|process| {
                        let cwd = desktop
                            .working_directory(process.pid)
                            .map(|cwd| cwd.to_string_lossy().into_owned());
                        json!({
                            "pid": process.pid.to_string(),
                            "elapsed": habibi_platform::processes::format_elapsed(process.run_time),
                            "command": process.command.trim(),
                            "cwd": cwd,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .await;
        match agents {
            Some(agents) => ApiResponse::json(&json!({ "ok": true, "agents": agents })),
            None => ApiResponse::json(&json!({ "ok": false, "agents": [] })),
        }
    }

    async fn agent_action(&self, request: &ApiRequest, resume: bool) -> ApiResponse {
        let body = body_or_return!(request);
        let Some(target) = home_path(&self.paths.home, body.get("cwd")) else {
            return ok(false);
        };
        if !resume {
            return ok(self.desktop.open_detached(&target.to_string_lossy()));
        }
        let (program, args): (&str, Vec<String>) =
            if body.get("kind").and_then(Value::as_str) == Some("claude") {
                ("claude", vec!["--resume".into()])
            } else {
                ("codex", vec!["resume".into()])
            };
        let cwd: PathBuf = target;
        match self
            .blocking(move |desktop| desktop.run_in_terminal(&cwd, program, &args))
            .await
        {
            Some(Ok(())) => ok(true),
            Some(Err(error)) => platform_error(error),
            None => ok(false),
        }
    }
}
