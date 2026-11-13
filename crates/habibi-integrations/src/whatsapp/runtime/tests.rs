use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::http::{HttpError, HttpResponse};
use crate::testing::FakeHttp;

fn layout(root: &Path) -> Layout {
    Layout {
        state_root: root.join("state"),
        bundled_root: root.join("app").join("openwa"),
        components_dir: root.join("state").join("components").join("whatsapp"),
        node: None,
        supervisor: None,
        version: "1.2.3".into(),
        component_sha256: None,
    }
}

fn health(healthy_after: usize) -> (Arc<FakeHttp>, Arc<AtomicUsize>) {
    let checks = Arc::new(AtomicUsize::new(0));
    let counter = checks.clone();
    let http = FakeHttp::new(move |request| {
        assert_eq!(request.url, HEALTH_URL);
        if counter.fetch_add(1, Ordering::SeqCst) >= healthy_after {
            Ok(HttpResponse { status: 200, body: b"{}".to_vec() })
        } else {
            Err(HttpError::Connect)
        }
    });
    (http, checks)
}

fn write_tree(root: &Path) {
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(root.join("dist").join("main.js"), "").unwrap();
}

#[test]
fn the_launcher_env_matches_what_openwa_and_the_client_expect() {
    let root = Path::new("/opt/component/openwa");
    let plan = launch_plan(Path::new("/app/node"), Path::new("/app/openwa-supervisor.js"), root, Path::new("/state"), 4242);
    let state = Path::new("/state").join(".openwa");
    assert_eq!(plan.cwd, state, "cwd is the writable state directory, never the component");
    assert_eq!(plan.args, vec![PathBuf::from("/app/openwa-supervisor.js"), root.join("dist").join("main.js")]);
    let expect = |key: &str, value: PathBuf| assert_eq!(plan.env(key), Some(value.to_string_lossy().as_ref()), "{key}");
    expect("BOOTSTRAP_KEY_FILE", state.join("data").join(".api-key"));
    expect("SESSION_DATA_PATH", state.join("sessions"));
    expect("DATABASE_NAME", state.join("openwa.sqlite"));
    expect("MAIN_DATABASE_NAME", state.join("main.sqlite"));
    expect("STORAGE_LOCAL_PATH", state.join("media"));
    assert_eq!(plan.env("PORT"), Some("2785"));
    assert_eq!(plan.env("HABIBI_PARENT_PID"), Some("4242"));
    assert_eq!(plan.env("PUPPETEER_EXECUTABLE_PATH"), None, "only set when the bundled Chromium exists");
}

#[cfg(unix)]
#[test]
fn puppeteer_points_at_the_real_bundled_chromium_executable() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let executable = if cfg!(target_os = "macos") {
        let macos = root.path().join("chrome/Google Chrome for Testing.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        macos.join("Google Chrome for Testing")
    } else {
        let dir = root.path().join("chrome/chrome-linux64");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("chrome")
    };
    std::fs::write(&executable, "").unwrap();
    assert_eq!(bundled_chrome(root.path()), None, "a non-executable file is not used");
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let plan = launch_plan(Path::new("/n"), Path::new("/s"), root.path(), Path::new("/state"), 2);
    assert_eq!(plan.env("PUPPETEER_EXECUTABLE_PATH"), Some(executable.to_string_lossy().as_ref()));
}

#[test]
fn port_cleanup_selects_only_listeners_and_never_this_process() {
    assert_eq!(parse_lsof_pids("123\n456\n\n", 456), vec![123]);
    let netstat = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:2785         0.0.0.0:0              LISTENING       900
  TCP    127.0.0.1:51000        127.0.0.1:2785         ESTABLISHED     77
  TCP    127.0.0.1:2785         127.0.0.1:51000        ESTABLISHED     900
  TCP    [::]:2785              [::]:0                 ABHÖREN         901
  TCP    0.0.0.0:27850          0.0.0.0:0              LISTENING       902
";
    assert_eq!(parse_netstat_pids(netstat, 2785, 1), vec![900, 901]);
    assert_eq!(parse_netstat_pids(netstat, 2785, 900), vec![901]);
    let proc_table = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0AE1 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 31337 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C350 0100007F:0AE1 01 00000000:00000000 00:00000000 00000000   501        0 31338 1 0000000000000000 100 0 0 10 0
";
    assert_eq!(parse_proc_net_listeners(proc_table, 2785), vec![31337]);
}

#[test]
fn components_are_versioned_per_release() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    let installed = layout.installed_component().unwrap();
    assert_eq!(installed, layout.components_dir.join("1.2.3").join(component_name()));
    assert!(is_release_version("0.1.0"));
    assert!(!is_release_version("0.1"));
    assert!(!is_release_version("1.2.3-beta"));
    let mut dev = layout.clone();
    dev.version = "dev".into();
    assert_eq!(dev.installed_component(), None);
}

#[tokio::test]
async fn an_already_running_service_is_reported_ready_without_spawning() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    write_tree(&layout.bundled_root);
    let (http, checks) = health(0);
    let runtime = OpenwaRuntime::new(layout, http).quick();
    let states = Arc::new(Mutex::new(Vec::new()));
    let log = states.clone();
    runtime.set_listener(Some(Arc::new(move |value| log.lock().unwrap().push(value))));
    assert_eq!(runtime.prepare().await, json!({ "state": "ready", "ok": true }));
    assert_eq!(*states.lock().unwrap(), vec![json!({ "state": "starting" })]);
    assert!(runtime.child.lock().unwrap().is_none());
    assert_eq!(checks.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_service_that_cannot_start_fails_with_the_setup_message() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    write_tree(&layout.bundled_root);
    let (http, _) = health(usize::MAX);
    let runtime = OpenwaRuntime::new(layout, http).quick();
    // No bundled Node or supervisor: nothing can be spawned.
    assert_eq!(
        runtime.prepare().await,
        json!({ "state": "failed", "ok": false, "error": "The WhatsApp service did not become ready." })
    );
}

/// A complete component (Node, supervisor, OpenWA entrypoint) at `component`.
fn write_component(component: &Path) {
    let parts = component_parts(component);
    write_tree(&parts.openwa);
    std::fs::create_dir_all(parts.node.parent().unwrap()).unwrap();
    std::fs::write(&parts.node, "").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&parts.node, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(&parts.supervisor, "").unwrap();
}

#[test]
fn the_component_provides_node_and_the_supervisor() {
    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    let component = layout.installed_component().unwrap();
    assert_eq!(layout.service(), None);
    write_tree(&component_root(&component));
    assert_eq!(layout.service(), None, "OpenWA alone is not enough without the component's Node and supervisor");
    write_component(&component);
    let service = layout.service().unwrap();
    assert!(service.node.starts_with(&component) && service.supervisor.starts_with(&component));
    assert_eq!(service.openwa, component_root(&component));
    if cfg!(target_os = "macos") {
        assert!(service.node.ends_with("Contents/MacOS/node"));
    }
    // The development tree needs its own Node and supervisor.
    write_tree(&layout.bundled_root);
    assert_eq!(layout.service(), None);
    let mut dev = layout.clone();
    dev.node = Some(root.path().join("node"));
    dev.supervisor = Some(root.path().join("openwa-supervisor.js"));
    assert_eq!(dev.service().unwrap().openwa, dev.bundled_root);
}

/// Serves `archive` for any URL, recording what was requested.
#[cfg(not(target_os = "macos"))]
struct Serves(PathBuf, Mutex<Vec<String>>);

#[cfg(not(target_os = "macos"))]
#[async_trait::async_trait]
impl download::Downloader for Serves {
    async fn download(&self, url: &str, dest: &Path, _: u64, progress: &(dyn Fn(u8) + Send + Sync)) -> Result<(), download::DownloadError> {
        self.1.lock().unwrap().push(url.to_string());
        std::fs::copy(&self.0, dest).map_err(|_| download::DownloadError::File)?;
        progress(100);
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn component_archive(root: &Path) -> (PathBuf, String) {
    let source = root.join("source");
    write_component(&source.join(component_name()));
    let archive = root.join("component.tar.gz");
    let status = Command::new(archive::tar_program())
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&source)
        .arg(component_name())
        .status()
        .unwrap();
    assert!(status.success());
    let digest = archive::sha256_file(&archive).unwrap();
    (archive, digest)
}

#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn without_a_pinned_digest_nothing_is_downloaded() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = component_archive(root.path());
    let (http, checks) = health(0);
    let downloader = Arc::new(Serves(archive, Mutex::new(Vec::new())));
    let runtime = OpenwaRuntime::new(layout(root.path()), http).quick().with_downloader(downloader.clone());
    assert_eq!(runtime.prepare().await["error"], archive::NOT_AVAILABLE);
    assert!(downloader.1.lock().unwrap().is_empty(), "nothing is downloaded without a digest to check it against");
    assert_eq!(checks.load(Ordering::SeqCst), 0);
}

#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn the_component_is_downloaded_verified_installed_and_started() {
    let root = tempfile::tempdir().unwrap();
    let (archive, digest) = component_archive(root.path());
    let mut layout = layout(root.path());
    layout.component_sha256 = Some(digest.clone());
    let (http, _) = health(0);
    let downloader = Arc::new(Serves(archive, Mutex::new(Vec::new())));
    let runtime = OpenwaRuntime::new(layout.clone(), http).quick().with_downloader(downloader.clone());
    let states = Arc::new(Mutex::new(Vec::new()));
    let log = states.clone();
    runtime.set_listener(Some(Arc::new(move |value| log.lock().unwrap().push(value))));
    assert_eq!(runtime.prepare().await, json!({ "state": "ready", "ok": true }));
    assert_eq!(*downloader.1.lock().unwrap(), vec![download::asset_url("1.2.3")]);
    let installed = layout.installed_component().unwrap();
    assert!(runtime.verified_is(&installed));
    assert_eq!(std::fs::read_to_string(installed.join(archive::MARKER)).unwrap(), digest);
    assert_eq!(
        *states.lock().unwrap(),
        vec![
            json!({ "state": "downloading" }),
            json!({ "state": "downloading", "progress": 100 }),
            json!({ "state": "verifying" }),
            json!({ "state": "starting" }),
        ]
    );
    // A fresh process re-verifies the installed copy without downloading.
    let (http, _) = health(0);
    let again = OpenwaRuntime::new(layout.clone(), http).quick().with_downloader(downloader.clone());
    assert_eq!(again.prepare().await["state"], "ready");
    assert_eq!(downloader.1.lock().unwrap().len(), 1);
}

#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn an_installed_component_from_another_build_is_replaced_not_run() {
    let root = tempfile::tempdir().unwrap();
    let (archive, digest) = component_archive(root.path());
    let mut layout = layout(root.path());
    layout.component_sha256 = Some(digest.clone());
    // Hand-placed: complete, but never verified against this build's digest.
    let installed = layout.installed_component().unwrap();
    write_component(&installed);
    let (http, _) = health(0);
    let downloader = Arc::new(Serves(archive, Mutex::new(Vec::new())));
    let runtime = OpenwaRuntime::new(layout.clone(), http).quick().with_downloader(downloader.clone());
    assert_eq!(runtime.prepare().await["state"], "ready");
    assert_eq!(downloader.1.lock().unwrap().len(), 1, "the unverified copy was replaced by a verified download");
    assert_eq!(std::fs::read_to_string(installed.join(archive::MARKER)).unwrap(), digest);
}

#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn a_download_that_does_not_match_the_pinned_digest_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = component_archive(root.path());
    let mut layout = layout(root.path());
    layout.component_sha256 = Some("0".repeat(64));
    let (http, checks) = health(0);
    let runtime = OpenwaRuntime::new(layout.clone(), http).quick().with_downloader(Arc::new(Serves(archive, Mutex::new(Vec::new()))));
    assert_eq!(runtime.prepare().await["error"], "The WhatsApp download could not be verified. Try again.");
    assert!(!layout.installed_component().unwrap().exists());
    assert_eq!(checks.load(Ordering::SeqCst), 0, "it is never started");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_component_is_downloaded_only_when_requested_and_failures_are_reported() {
    use async_trait::async_trait;

    struct NotFound(AtomicUsize);

    #[async_trait]
    impl download::Downloader for NotFound {
        async fn download(&self, _: &str, _: &Path, _: u64, _: &(dyn Fn(u8) + Send + Sync)) -> Result<(), download::DownloadError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(download::DownloadError::Status(404))
        }
    }

    let root = tempfile::tempdir().unwrap();
    let (http, _) = health(0);
    let downloader = Arc::new(NotFound(AtomicUsize::new(0)));
    let runtime = OpenwaRuntime::new(layout(root.path()), http).quick().with_downloader(downloader.clone());
    assert_eq!(downloader.0.load(Ordering::SeqCst), 0, "nothing is downloaded at launch");
    let result = runtime.prepare().await;
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"], "WhatsApp support is not available for this Habibi version. Update Habibi and try again.");
    assert_eq!(downloader.0.load(Ordering::SeqCst), 1);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn an_unverifiable_installed_component_is_quarantined_not_run() {
    use async_trait::async_trait;

    struct NotFound;

    #[async_trait]
    impl download::Downloader for NotFound {
        async fn download(&self, _: &str, _: &Path, _: u64, _: &(dyn Fn(u8) + Send + Sync)) -> Result<(), download::DownloadError> {
            Err(download::DownloadError::Status(404))
        }
    }

    let root = tempfile::tempdir().unwrap();
    let layout = layout(root.path());
    let component = layout.installed_component().unwrap();
    write_component(&component);
    let (http, checks) = health(0);
    let runtime = OpenwaRuntime::new(layout.clone(), http).quick().with_downloader(Arc::new(NotFound));
    let result = runtime.prepare().await;
    assert_eq!(result["ok"], false);
    assert!(!component.exists(), "an unsigned component is moved aside");
    assert!(std::fs::read_dir(&layout.components_dir).unwrap().any(|entry| {
        entry.unwrap().file_name().to_string_lossy().starts_with(".invalid-")
    }));
    assert_eq!(checks.load(Ordering::SeqCst), 0, "it is never started");
}

#[cfg(unix)]
#[tokio::test]
async fn the_supervised_process_is_started_with_the_plan_and_stopped_on_shutdown() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let mut layout = layout(root.path());
    write_tree(&layout.bundled_root);
    // A stand-in "node" that records its arguments, environment and cwd,
    // then waits to be stopped.
    let node = root.path().join("node");
    std::fs::write(
        &node,
        "#!/bin/sh\necho \"$@\" > \"$STORAGE_LOCAL_PATH.args\"\npwd >> \"$STORAGE_LOCAL_PATH.args\"\necho \"$HABIBI_PARENT_PID\" >> \"$STORAGE_LOCAL_PATH.args\"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.05; done\n",
    )
    .unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let supervisor = root.path().join("openwa-supervisor.js");
    std::fs::write(&supervisor, "").unwrap();
    layout.node = Some(node);
    layout.supervisor = Some(supervisor.clone());
    let (http, _) = health(1);
    let runtime = OpenwaRuntime::new(layout.clone(), http).quick();
    assert_eq!(runtime.prepare().await["state"], "ready");
    let record = layout.state_root.join(".openwa").join("media.args");
    for _ in 0..100 {
        if std::fs::read_to_string(&record).is_ok_and(|text| text.lines().count() >= 3) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let recorded = std::fs::read_to_string(&record).unwrap();
    let lines: Vec<&str> = recorded.lines().collect();
    let main = layout.bundled_root.join("dist").join("main.js");
    assert_eq!(lines[0], format!("{} {}", supervisor.display(), main.display()));
    assert!(lines[1].ends_with(".openwa"));
    assert_eq!(lines[2], std::process::id().to_string());
    assert!(layout.state_root.join(".openwa").join("openwa.log").exists());
    let pid = runtime.child.lock().unwrap().as_ref().unwrap().id();
    runtime.shutdown().await;
    assert!(runtime.child.lock().unwrap().is_none());
    // SAFETY: signal 0 only checks whether the (reaped) PID still exists.
    let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
    assert!(!alive, "the supervisor must be stopped on shutdown");
}
