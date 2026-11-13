//! Supervision of the OpenWA runtime (a Node component), ported from the
//! Swift app (`native/HabibiApp.swift`: `prepareWhatsAppComponent`,
//! `ensureOpenwaService`, `startOpenwaService`, `killStaleOpenwaProcess`)
//! and launched through `native/openwa-supervisor.js` as before.
//!
//! The app itself ships no Node. Node, the supervisor and OpenWA (with its
//! Chromium) all come from the component, installed on request under
//! `<state_root>/components/whatsapp/<version>/` (see [`component_parts`]):
//! - macOS: `Habibi WhatsApp Runtime.app`, the signed, notarized download,
//!   with `Contents/MacOS/node`, `Contents/Resources/openwa-supervisor.js`
//!   and `Contents/Resources/openwa`.
//! - Windows/Linux: `whatsapp-runtime/` with `node.exe`/`node`,
//!   `openwa-supervisor.js` and `openwa/`, verified against the SHA-256
//!   pinned into this build.
//!
//! A development tree at `<app_root>/openwa` is used instead when present
//! (development builds only), with `node` from `PATH` and
//! `<app_root>/native/openwa-supervisor.js`.
//!
//! State: `<state_root>/.openwa/` (cwd, API key, sessions, databases, log).

pub mod archive;
pub mod download;
#[cfg(windows)]
pub mod job;
#[cfg(target_os = "macos")]
pub mod macos;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use habibi_core::Paths;
use serde_json::{Value, json};

use crate::http::{HttpFetch, HttpRequest};

pub const OPENWA_PORT: u16 = 2785;
pub const HEALTH_URL: &str = "http://127.0.0.1:2785/api/infra/health";
pub const COMPONENT_IDENTIFIER: &str = "com.clidey.habibi.whatsapp-runtime";
/// The release this build belongs to; component downloads are pinned to it.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Receives intermediate component states (`verifying`, `downloading` with
/// `progress`, `starting`) for `window.__habibiWhatsAppComponent`.
pub type StatusListener = Arc<dyn Fn(Value) + Send + Sync>;

/// The installed component's directory name under its version directory
/// (and the single top-level entry of its release archive).
pub fn component_name() -> &'static str {
    if cfg!(target_os = "macos") { "Habibi WhatsApp Runtime.app" } else { "whatsapp-runtime" }
}

/// What an installed component provides.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentParts {
    pub node: PathBuf,
    pub supervisor: PathBuf,
    /// The OpenWA tree (`dist/main.js`, `node_modules`, `chrome/`).
    pub openwa: PathBuf,
}

impl ComponentParts {
    /// Everything needed to start OpenWA is present.
    pub fn complete(&self) -> bool {
        has_entrypoint(&self.openwa) && is_executable(&self.node) && self.supervisor.is_file()
    }
}

/// The layout `native/build-whatsapp-component.sh` packages. On macOS the
/// Node binary sits in `Contents/MacOS` so it is signed and notarized as part
/// of the component bundle, with the JIT entitlements V8 needs.
pub fn component_parts(component: &Path) -> ComponentParts {
    if cfg!(target_os = "macos") {
        let contents = component.join("Contents");
        let resources = contents.join("Resources");
        ComponentParts {
            node: contents.join("MacOS").join("node"),
            supervisor: resources.join("openwa-supervisor.js"),
            openwa: resources.join("openwa"),
        }
    } else {
        ComponentParts {
            node: component.join(if cfg!(windows) { "node.exe" } else { "node" }),
            supervisor: component.join("openwa-supervisor.js"),
            openwa: component.join("openwa"),
        }
    }
}

/// The OpenWA tree inside an installed component.
pub fn component_root(component: &Path) -> PathBuf {
    component_parts(component).openwa
}

/// `^[0-9]+\.[0-9]+\.[0-9]+$`.
pub fn is_release_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn has_entrypoint(root: &Path) -> bool {
    root.join("dist").join("main.js").is_file()
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn sorted_entries(directory: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .map(|entries| entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect())
        .unwrap_or_default();
    entries.sort();
    entries
}

/// The bundled Chrome for Testing executable under `<root>/chrome`, if any.
///
/// On macOS: find the real `.app` by globbing rather than a fixed name or
/// symlink — a stable-named symlink broke Puppeteer's launch once, since
/// Chromium resolves its Framework via a relative `../Frameworks/...` walk
/// from the executable path it is given, and that walk resolves against the
/// symlink's own directory. Read `Contents/MacOS/`'s own entry rather than
/// derive the executable's name from the bundle's name.
pub fn bundled_chrome(root: &Path) -> Option<PathBuf> {
    let chrome = root.join("chrome");
    let candidate = if cfg!(target_os = "macos") {
        let app = sorted_entries(&chrome).into_iter().find(|entry| entry.extension().is_some_and(|ext| ext == "app"))?;
        sorted_entries(&app.join("Contents").join("MacOS")).into_iter().next()?
    } else {
        let name = if cfg!(windows) { "chrome.exe" } else { "chrome" };
        sorted_entries(&chrome).into_iter().map(|entry| entry.join(name)).find(|path| path.is_file())?
    };
    is_executable(&candidate).then_some(candidate)
}

/// How OpenWA is started.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<PathBuf>,
    pub cwd: PathBuf,
    /// Set on top of the inherited environment.
    pub env: Vec<(String, String)>,
}

impl LaunchPlan {
    pub fn env(&self, key: &str) -> Option<&str> {
        self.env.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }
}

/// The supervisor command for `root` (an OpenWA tree), with OpenWA's state
/// under `<state_root>/.openwa`.
pub fn launch_plan(node: &Path, supervisor: &Path, root: &Path, state_root: &Path, parent_pid: u32) -> LaunchPlan {
    let state = state_root.join(".openwa");
    let path = |relative: &str| state.join(relative).to_string_lossy().into_owned();
    let mut env = vec![
        ("PORT".to_string(), OPENWA_PORT.to_string()),
        // openwa-client reads `<state root>/.openwa/data/.api-key`; the
        // bootstrap key must be written to exactly that path or the two never
        // agree on where the API key lives.
        ("BOOTSTRAP_KEY_FILE".to_string(), state.join("data").join(".api-key").to_string_lossy().into_owned()),
        // Sessions live in the per-user state root, not the (replaceable)
        // component, so QR-linking survives an update.
        ("SESSION_DATA_PATH".to_string(), path("sessions")),
        ("DATABASE_NAME".to_string(), path("openwa.sqlite")),
        ("MAIN_DATABASE_NAME".to_string(), path("main.sqlite")),
        ("STORAGE_LOCAL_PATH".to_string(), path("media")),
        // The supervisor exits (and stops OpenWA's whole process group) when
        // this process disappears, even after a crash or force-quit.
        ("HABIBI_PARENT_PID".to_string(), parent_pid.to_string()),
    ];
    if cfg!(target_os = "macos") {
        env.push(("PATH".to_string(), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_string()));
    }
    // Only point Puppeteer at the bundled Chromium when it actually exists.
    if let Some(chrome) = bundled_chrome(root) {
        env.push(("PUPPETEER_EXECUTABLE_PATH".to_string(), chrome.to_string_lossy().into_owned()));
    }
    LaunchPlan {
        program: node.to_path_buf(),
        // dist/main.js must be an ABSOLUTE path: OpenWA resolves its config
        // and API-key file against cwd, which is the writable state directory,
        // not the read-only tree main.js lives in.
        args: vec![supervisor.to_path_buf(), root.join("dist").join("main.js")],
        // cwd = the state directory, NOT the component: OpenWA writes
        // data/.env.generated (and data/.api-key) relative to cwd, and the
        // component must stay read-only (v0.2.0 shipped writing into the app
        // bundle, and the API key never reached disk).
        cwd: state,
        env,
    }
}

/// Where the runtime's pieces are.
#[derive(Debug, Clone)]
pub struct Layout {
    pub state_root: PathBuf,
    /// A development tree retained strictly for local development and testing.
    pub bundled_root: PathBuf,
    /// `<state_root>/components/whatsapp`; one directory per version.
    pub components_dir: PathBuf,
    /// Node and supervisor for the development tree only; an installed
    /// component always runs its own.
    pub node: Option<PathBuf>,
    pub supervisor: Option<PathBuf>,
    pub version: String,
    /// The Windows/Linux component archive's SHA-256, pinned at build time
    /// ([`archive::pinned_digest`]). Unused on macOS.
    pub component_sha256: Option<String>,
}

/// The first executable `node` on `PATH`, for the development tree only.
fn node_on_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|node| is_executable(node))
}

impl Layout {
    pub fn detect(paths: &Paths) -> Self {
        // Release builds never run a development tree's Node from PATH.
        let development = cfg!(debug_assertions);
        let supervisor = paths.app_root.join("native").join("openwa-supervisor.js");
        Self {
            state_root: paths.state_root.clone(),
            bundled_root: paths.app_root.join("openwa"),
            components_dir: paths.state_root.join("components").join("whatsapp"),
            node: if development { node_on_path() } else { None },
            supervisor: (development && supervisor.is_file()).then_some(supervisor),
            version: APP_VERSION.to_string(),
            component_sha256: archive::pinned_digest(),
        }
    }

    /// `<components>/<version>/<component>`, when this build has a release version.
    pub fn installed_component(&self) -> Option<PathBuf> {
        is_release_version(&self.version).then(|| self.components_dir.join(&self.version).join(component_name()))
    }

    /// What to run: the development tree with its Node and supervisor, else
    /// the installed component's own.
    pub fn service(&self) -> Option<ComponentParts> {
        if has_entrypoint(&self.bundled_root) {
            return Some(ComponentParts {
                node: self.node.clone()?,
                supervisor: self.supervisor.clone()?,
                openwa: self.bundled_root.clone(),
            });
        }
        let parts = component_parts(&self.installed_component()?);
        parts.complete().then_some(parts)
    }
}

fn status(state: &str) -> Value {
    json!({ "state": state })
}

fn failed(message: &str) -> Value {
    json!({ "state": "failed", "ok": false, "error": message })
}

pub struct OpenwaRuntime {
    layout: Layout,
    http: Arc<dyn HttpFetch>,
    child: Mutex<Option<Child>>,
    // `codesign --verify --deep` on the Chromium-containing component is real
    // wall-clock cost, and nothing on disk can change within one running
    // Habibi process, so a path verified once is not verified again this run.
    // A fresh app launch still verifies once.
    verified: Mutex<Option<PathBuf>>,
    preparing: tokio::sync::Mutex<()>,
    listener: Mutex<Option<StatusListener>>,
    poll_interval: Duration,
    ready_attempts: u32,
    /// Frees OpenWA's port before a spawn; tests replace it so they never
    /// touch a real OpenWA on this machine.
    free_port: fn(u16),
    downloader: Arc<dyn download::Downloader>,
    /// Windows: the kill-on-close job every supervisor is spawned into,
    /// created on first start and held for the runtime's lifetime so the
    /// whole OpenWA tree ends with Habibi, even on a crash. `None` when the
    /// job could not be created; a clean quit still uses taskkill.
    #[cfg(windows)]
    job: std::sync::OnceLock<Option<job::KillOnCloseJob>>,
}

impl OpenwaRuntime {
    pub fn new(layout: Layout, http: Arc<dyn HttpFetch>) -> Self {
        Self {
            layout,
            http,
            child: Mutex::new(None),
            verified: Mutex::new(None),
            preparing: tokio::sync::Mutex::new(()),
            listener: Mutex::new(None),
            poll_interval: Duration::from_millis(250),
            ready_attempts: 80,
            free_port: kill_port_listeners,
            downloader: Arc::new(download::ReqwestDownloader::new()),
            #[cfg(windows)]
            job: std::sync::OnceLock::new(),
        }
    }

    #[cfg(test)]
    fn quick(mut self) -> Self {
        self.poll_interval = Duration::from_millis(1);
        self.ready_attempts = 3;
        self.free_port = |_| {};
        self
    }

    #[cfg(test)]
    fn with_downloader(mut self, downloader: Arc<dyn download::Downloader>) -> Self {
        self.downloader = downloader;
        self
    }

    pub fn set_listener(&self, listener: Option<StatusListener>) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = listener;
    }

    fn notify(&self, value: Value) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(value);
        }
    }

    fn verified_is(&self, path: &Path) -> bool {
        self.verified.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(path)
    }

    fn mark_verified(&self, path: PathBuf) {
        *self.verified.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }

    /// The `whatsappComponent` bridge message: make sure the component is
    /// present and verified, start OpenWA if it is not answering, and wait
    /// for it. Returns the final `{ state: "ready", ok: true }` or
    /// `{ state: "failed", ok: false, error }`; intermediate states go to the
    /// listener. Concurrent calls wait for the one in progress.
    pub async fn prepare(&self) -> Value {
        let _preparing = self.preparing.lock().await;
        // A bundled tree is retained strictly for local development and testing.
        if has_entrypoint(&self.layout.bundled_root) {
            return self.start_and_wait().await;
        }
        for _ in 0..3 {
            let Some(installed) = self.layout.installed_component() else { break };
            if !installed.exists() {
                break;
            }
            if self.verified_is(&installed) {
                return self.start_and_wait().await;
            }
            self.notify(status("verifying"));
            match self.verify_installed(&installed).await {
                Ok(()) => {
                    self.mark_verified(installed);
                    return self.start_and_wait().await;
                }
                Err(message) => {
                    // Move the whole version aside and fetch a fresh copy.
                    let Some(version_dir) = installed.parent() else { return failed(&message) };
                    let quarantine = self.layout.components_dir.join(format!(".invalid-{}", uuid::Uuid::new_v4()));
                    if std::fs::rename(version_dir, quarantine).is_err() {
                        return failed(&message);
                    }
                }
            }
        }
        if !is_release_version(&self.layout.version) {
            return failed("This Habibi build has no valid release version.");
        }
        self.install().await
    }

    #[cfg(target_os = "macos")]
    async fn verify_installed(&self, component: &Path) -> Result<(), String> {
        let (component, version) = (component.to_path_buf(), self.layout.version.clone());
        tokio::task::spawn_blocking(move || macos::verify_component(&component, &version, false))
            .await
            .unwrap_or_else(|_| Err("macOS rejected the WhatsApp component signature.".into()))
    }

    /// Windows and Linux have no component signature to check. The component
    /// must have been installed from an archive whose SHA-256 matched the
    /// digest pinned into this build (recorded in its marker) and be complete.
    #[cfg(not(target_os = "macos"))]
    async fn verify_installed(&self, component: &Path) -> Result<(), String> {
        archive::verify_installed(component, self.layout.component_sha256.as_deref())
    }

    async fn install(&self) -> Value {
        #[cfg(target_os = "macos")]
        let installer: download::Installer = macos::install_archive;
        #[cfg(not(target_os = "macos"))]
        let installer: download::Installer = {
            // Without a pinned digest nothing downloaded could be trusted, so
            // do not download at all.
            if self.layout.component_sha256.as_deref().and_then(archive::normalize_digest).is_none() {
                return failed(archive::NOT_AVAILABLE);
            }
            archive::install_archive
        };
        let notify = |value: Value| self.notify(value);
        match download::download_and_install(&*self.downloader, &self.layout, &notify, installer).await {
            Ok(component) => {
                // install already verified this exact component (on macOS
                // including Gatekeeper); caching it avoids a redundant check.
                self.mark_verified(component);
                self.start_and_wait().await
            }
            Err(message) => failed(&message),
        }
    }

    async fn healthy(&self) -> bool {
        let request = HttpRequest::new("GET", HEALTH_URL).timeout(Duration::from_secs(2)).max_bytes(64 * 1024);
        // OpenWA applies a global 'api' route prefix, so the health check is
        // /api/infra/health, not /infra/health.
        matches!(self.http.send(request).await, Ok(response) if response.status == 200)
    }

    async fn start_and_wait(&self) -> Value {
        self.notify(status("starting"));
        if !self.healthy().await && !self.start() {
            return failed("The WhatsApp service did not become ready.");
        }
        for attempt in 0..self.ready_attempts {
            if self.healthy().await {
                return json!({ "state": "ready", "ok": true });
            }
            if attempt + 1 < self.ready_attempts {
                tokio::time::sleep(self.poll_interval).await;
            }
        }
        failed("The WhatsApp service did not become ready.")
    }

    /// Spawn OpenWA through the supervisor; false when it cannot be started.
    fn start(&self) -> bool {
        // Not fatal: WhatsApp is one feature among many.
        let Some(ComponentParts { node, supervisor, openwa: root }) = self.layout.service() else {
            return false;
        };
        // Reaching this point means the health check just failed, so nothing
        // at this port answered as our service — but a stale, orphaned
        // instance can still be bound to it. Free the port before spawning
        // rather than letting a fresh EADDRINUSE happen silently.
        if let Some(mut previous) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            terminate(&mut previous);
            // Reap it off the async workers; the supervisor exits within ~2 s.
            std::thread::spawn(move || {
                let _ = previous.wait();
            });
        }
        (self.free_port)(OPENWA_PORT);
        let plan = launch_plan(&node, &supervisor, &root, &self.layout.state_root, std::process::id());
        let _ = std::fs::create_dir_all(&plan.cwd);
        let mut command = Command::new(&plan.program);
        command.args(&plan.args).current_dir(&plan.cwd).envs(plan.env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null());
        // Keep OpenWA's output: a startup failure is otherwise invisible.
        let log = crate::util::write_private(&plan.cwd.join("openwa.log"), b"")
            .and_then(|()| std::fs::OpenOptions::new().append(true).open(plan.cwd.join("openwa.log")));
        match log.and_then(|file| Ok((file.try_clone()?, file))) {
            Ok((out, err)) => command.stdout(out).stderr(err),
            Err(_) => command.stdout(Stdio::null()).stderr(Stdio::null()),
        };
        #[cfg(windows)]
        let spawned = {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let tree = self.job.get_or_init(|| job::KillOnCloseJob::new().ok()).as_ref();
            job::spawn(tree, &mut command, CREATE_NO_WINDOW)
        };
        #[cfg(not(windows))]
        let spawned = command.spawn();
        match spawned {
            Ok(child) => {
                *self.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
                true
            }
            Err(_) => false,
        }
    }

    /// Stop OpenWA (on quit). The supervisor stops OpenWA's process group on
    /// SIGTERM and force-kills it after 2 s.
    pub async fn shutdown(&self) {
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(mut child) = child else { return };
        terminate(&mut child);
        for _ in 0..30 {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for OpenwaRuntime {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
            terminate(&mut child);
        }
    }
}

/// Ask the supervisor to stop: SIGTERM on Unix; on Windows, where the
/// supervisor cannot signal a process group, end the whole process tree
/// (the runtime's job only ends it when Habibi itself exits).
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill(2) with a PID we spawned and still own (not yet reaped).
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
    #[cfg(windows)]
    {
        if !kill_tree(child.id()) {
            let _ = child.kill();
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|status| status.success())
}

/// PIDs from `lsof -t`, never this process.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_lsof_pids(output: &str, own_pid: u32) -> Vec<u32> {
    output.lines().filter_map(|line| line.trim().parse().ok()).filter(|pid| *pid != own_pid).collect()
}

/// PIDs listening on `port` in `netstat -ano -p TCP` output. Listening
/// sockets are recognized by their unconnected foreign address, so this does
/// not depend on the localized state column.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_netstat_pids(output: &str, port: u16, own_pid: u32) -> Vec<u32> {
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [proto, local, foreign, .., pid] = fields.as_slice() else { continue };
        let listening = matches!(*foreign, "0.0.0.0:0" | "[::]:0" | "*:*");
        if proto.eq_ignore_ascii_case("TCP") && local.ends_with(&suffix) && listening
            && let Ok(pid) = pid.parse::<u32>()
                && pid != own_pid && pid != 0 && !pids.contains(&pid) {
                    pids.push(pid);
                }
    }
    pids
}

/// Socket inodes listening on `port` in `/proc/net/tcp{,6}`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_net_listeners(table: &str, port: u16) -> Vec<u64> {
    const LISTEN: &str = "0A";
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let local = fields.get(1)?;
            let local_port = u16::from_str_radix(local.rsplit(':').next()?, 16).ok()?;
            (local_port == port && *fields.get(3)? == LISTEN).then(|| fields.get(9)?.parse().ok())?
        })
        .collect()
}

/// Kill whatever is listening on OpenWA's port.
///
/// A force-quit (or crash) skips the normal shutdown, so a previous run's
/// OpenWA can be orphaned but still hold port 2785 — the exact scenario that
/// produced a real `EADDRINUSE` after an app update. The orphan is not our
/// child by then, so it is found by its effect (the bound port). Only
/// listening sockets are selected: an unqualified port query also returns
/// Habibi's own health-check connection and once made the app kill itself;
/// this process is excluded defensively too.
pub fn kill_port_listeners(port: u16) {
    let own = std::process::id();
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/sbin/lsof")
            .args(["-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        // lsof missing or unreadable: nothing to clean up, and a held port
        // surfaces as EADDRINUSE in openwa.log.
        if let Ok(output) = output {
            for pid in parse_lsof_pids(&String::from_utf8_lossy(&output.stdout), own) {
                kill_pid(pid);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut inodes = Vec::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(table) {
                inodes.extend(parse_proc_net_listeners(&content, port));
            }
        }
        if inodes.is_empty() {
            return;
        }
        let targets: Vec<String> = inodes.iter().map(|inode| format!("socket:[{inode}]")).collect();
        for process in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
            let Some(pid) = process.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
            if pid == own {
                continue;
            }
            let owns_socket = std::fs::read_dir(process.path().join("fd")).into_iter().flatten().flatten().any(|fd| {
                std::fs::read_link(fd.path())
                    .is_ok_and(|link| targets.iter().any(|target| link.as_os_str() == target.as_str()))
            });
            if owns_socket {
                kill_pid(pid);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            for pid in parse_netstat_pids(&String::from_utf8_lossy(&output.stdout), port, own) {
                kill_tree(pid);
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (port, own);
    }
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    if let Ok(pid) = i32::try_from(pid)
        && pid > 1 {
            // SAFETY: kill(2) has no memory-safety preconditions.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
}

#[cfg(test)]
mod tests;
