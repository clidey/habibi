use std::ffi::OsString;

use hyper::http::HeaderValue;
use serde_json::Value;

use super::*;

const PORT: u16 = 4173;

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(header::HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_str(value).unwrap());
    }
    map
}

fn local() -> HeaderMap {
    headers(&[("host", "127.0.0.1:4173")])
}

struct Fixture {
    _dir: tempfile::TempDir,
    app_root: PathBuf,
    dev: Arc<DevServer>,
}

/// A real `habibi_server::Server` over scratch state and a fake app root
/// holding allowlisted files next to files that must never be served.
fn fixture() -> Fixture {
    isolate_credentials();
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let app_root = base.join("app");
    std::fs::create_dir_all(app_root.join("assets/vendor")).unwrap();
    std::fs::create_dir_all(app_root.join(".habibi")).unwrap();
    std::fs::write(app_root.join("index.html"), "<script src=\"/assets/app.bundle.js\"></script><script>window.a = 1;</script>").unwrap();
    std::fs::write(app_root.join("app.css"), "body{}").unwrap();
    std::fs::write(app_root.join("assets/vendor/xterm.js"), "xterm").unwrap();
    std::fs::write(app_root.join("package.json"), "{}").unwrap();
    std::fs::write(app_root.join(".habibi/llm-config.json"), "secret").unwrap();
    std::fs::write(base.join("outside.txt"), "outside").unwrap();
    let config = Config { port: PORT, app_root: app_root.clone(), state_root: base.join("state"), home: base.join("home") }
        .prepare()
        .unwrap();
    let server = Server::new(config.paths());
    Fixture { _dir: dir, app_root, dev: DevServer::with_port(server, config.app_root, PORT) }
}

async fn body(response: HttpResponse) -> Vec<u8> {
    response.into_body().collect().await.unwrap().to_bytes().to_vec()
}

fn header_of<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
    response.headers().get(name).and_then(|value| value.to_str().ok())
}

#[test]
fn accepts_only_this_ports_loopback_host_and_origin() {
    for host in ["127.0.0.1:4173", "localhost:4173", "LOCALHOST:4173", "[::1]:4173"] {
        assert!(security::is_trusted_local_request(&headers(&[("host", host)]), PORT), "{host}");
    }
    for origin in ["http://127.0.0.1:4173", "http://localhost:4173"] {
        assert!(
            security::is_trusted_local_request(&headers(&[("host", "127.0.0.1:4173"), ("origin", origin)]), PORT),
            "{origin}"
        );
    }
}

#[test]
fn refuses_dns_rebinding_hosts() {
    assert!(!security::is_trusted_local_request(&HeaderMap::new(), PORT), "Host is required");
    for host in [
        "attacker.example:4173",
        "127.0.0.1",
        "localhost",
        "127.0.0.1:4174",
        "localhost.attacker.example:4173",
        "127.0.0.1:4173.attacker.example",
        "0.0.0.0:4173",
        "",
    ] {
        assert!(!security::is_trusted_local_request(&headers(&[("host", host)]), PORT), "{host}");
    }
    let repeated = headers(&[("host", "127.0.0.1:4173"), ("host", "attacker.example:4173")]);
    assert!(!security::is_trusted_local_request(&repeated, PORT));
}

#[test]
fn refuses_cross_origin_requests() {
    for origin in [
        "http://attacker.example",
        "http://127.0.0.1:4174",
        "https://127.0.0.1:4173",
        "http://[::1]:4173",
        "http://127.0.0.1:4173/",
        "null",
        "",
    ] {
        let request = headers(&[("host", "127.0.0.1:4173"), ("origin", origin)]);
        assert!(!security::is_trusted_local_request(&request, PORT), "{origin}");
    }
    let repeated =
        headers(&[("host", "127.0.0.1:4173"), ("origin", "http://127.0.0.1:4173"), ("origin", "http://attacker.example")]);
    assert!(!security::is_trusted_local_request(&repeated, PORT));
}

#[tokio::test]
async fn untrusted_requests_never_reach_routes_or_files() {
    let f = fixture();
    let rebinding = headers(&[("host", "attacker.example:4173")]);
    let cross = headers(&[("host", "127.0.0.1:4173"), ("origin", "http://attacker.example")]);
    for request in [&rebinding, &cross] {
        for (method, path) in [("GET", "/"), ("GET", "/api/skills"), ("POST", "/api/approvals")] {
            let response = f.dev.respond(method, path, request, b"{}".to_vec()).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
            assert_eq!(header_of(&response, "content-type"), Some("application/json"));
            assert!(header_of(&response, "content-security-policy").is_some(), "headers on refusals too");
            assert_eq!(body(response).await, br#"{"ok":false,"error":"Local requests only"}"#);
        }
    }
}

#[tokio::test]
async fn serves_the_shells_allowlist_only() {
    let f = fixture();
    let page = f.dev.respond("GET", "/", &local(), Vec::new()).await;
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(header_of(&page, "content-type"), Some("text/html"));
    assert_eq!(header_of(&page, "cache-control"), Some("no-store"));
    let csp = header_of(&page, "content-security-policy").unwrap().to_string();
    let expected = static_assets::inline_script_hashes("<script>window.a = 1;</script>");
    assert_eq!(expected.len(), 1);
    assert!(csp.contains(&format!("script-src 'self' {}", expected[0])), "{csp}");
    let vendor = f.dev.respond("GET", "/vendor/xterm.js", &local(), Vec::new()).await;
    assert_eq!(header_of(&vendor, "content-type"), Some("text/javascript"));
    assert_eq!(body(vendor).await, b"xterm");
    let css = f.dev.respond("HEAD", "/app.css?v=1", &local(), Vec::new()).await;
    assert_eq!((css.status(), header_of(&css, "content-type")), (StatusCode::OK, Some("text/css")));
    for denied in [
        "/package.json",
        "/.habibi/llm-config.json",
        "/assets/vendor/xterm.js",
        "/assets/../package.json",
        "/../outside.txt",
        "/%2e%2e/outside.txt",
        "/index.html/",
        "/server.js",
        "/pty",
    ] {
        let response = f.dev.respond("GET", denied, &local(), Vec::new()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{denied}");
        assert_eq!(body(response).await, b"Not found", "{denied}");
    }
    // Allowlisted but not built yet: still a plain 404.
    assert_eq!(f.dev.respond("GET", "/assets/app.bundle.js", &local(), Vec::new()).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(f.dev.respond("POST", "/", &local(), Vec::new()).await.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert!(f.app_root.join("package.json").is_file());
}

#[test]
fn allowlist_matches_the_shell_test_expectations() {
    let root = Path::new("/app");
    assert_eq!(static_assets::resolve_static("/", root), Some(PathBuf::from("/app/index.html")));
    assert_eq!(static_assets::resolve_static("/vendor/xterm-fit.js", root), Some(PathBuf::from("/app/assets/vendor/xterm-fit.js")));
    for path in static_assets::ALLOWED {
        assert_eq!(static_assets::resolve_static(path, root), Some(root.join(path.trim_start_matches('/'))), "{path}");
    }
}

#[tokio::test]
async fn api_requests_reach_the_rust_server_with_security_headers() {
    let f = fixture();
    let origin = headers(&[("host", "localhost:4173"), ("origin", "http://localhost:4173")]);
    let skills = f.dev.respond("GET", "/api/skills", &origin, Vec::new()).await;
    assert_eq!(skills.status(), StatusCode::OK);
    assert_eq!(header_of(&skills, "content-type"), Some("application/json"));
    assert_eq!(header_of(&skills, "x-frame-options"), Some("DENY"));
    assert_eq!(header_of(&skills, "x-content-type-options"), Some("nosniff"));
    assert_eq!(header_of(&skills, "referrer-policy"), Some("no-referrer"));
    let value: Value = serde_json::from_slice(&body(skills).await).unwrap();
    assert_eq!(value["ok"], true);

    let issued = f
        .dev
        .respond("POST", "/api/approvals", &local(), br#"{"action":"system.lock","payload":{"action":"lock"}}"#.to_vec())
        .await;
    let issued: Value = serde_json::from_slice(&body(issued).await).unwrap();
    assert!(issued["approval"]["token"].is_string(), "{issued}");

    let bad = f.dev.respond("POST", "/api/approvals", &local(), b"{".to_vec()).await;
    let bad: Value = serde_json::from_slice(&body(bad).await).unwrap();
    assert_eq!(bad["error"], "Invalid request.");
    assert_eq!(f.dev.respond("GET", "/api/nope?x=1", &local(), Vec::new()).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn analytics_are_acknowledged_without_being_sent() {
    let f = fixture();
    let event = br#"{"event":"app_opened","distinctId":"00000000-0000-4000-8000-000000000000"}"#.to_vec();
    let response = f.dev.respond("POST", "/api/analytics/capture", &local(), event).await;
    assert_eq!(body(response).await, br#"{"ok":true}"#);
}

#[test]
fn csp_keeps_the_node_hosts_policy_without_the_terminal_socket() {
    let csp = security::content_security_policy(&[]);
    assert!(csp.starts_with("default-src 'self'; connect-src 'self' data:;"));
    assert!(csp.contains("script-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"));
    assert!(!csp.contains("unsafe-eval") && !csp.contains("ws://") && !csp.contains("ipc:"));
}

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
    let pairs: Vec<(String, OsString)> = pairs.iter().map(|(key, value)| (key.to_string(), OsString::from(value))).collect();
    move |name| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
}

#[test]
fn refuses_to_start_without_a_scratch_data_root() {
    assert!(Config::from_env(env(&[])).unwrap_err().contains("HABIBI_DATA_ROOT is required"));
    assert!(Config::from_env(env(&[("HABIBI_DATA_ROOT", "")])).is_err());
    let config = Config::from_env(env(&[("HABIBI_DATA_ROOT", "/tmp/habibi-x")])).unwrap();
    assert_eq!(config.port, DEFAULT_PORT);
    assert_eq!(config.home, PathBuf::from("/tmp/habibi-x/home"), "never the real home by default");
    assert!(config.app_root.join("index.html").is_file(), "defaults to the repository root");
    let custom = Config::from_env(env(&[("HABIBI_DATA_ROOT", "/d"), ("HABIBI_PORT", "4199"), ("HABIBI_ROOT", "/r"), ("HABIBI_HOME", "/h")]))
        .unwrap();
    assert_eq!((custom.port, custom.app_root, custom.home), (4199, PathBuf::from("/r"), PathBuf::from("/h")));
    for port in ["0", "65536", "http", "-1"] {
        assert!(Config::from_env(env(&[("HABIBI_DATA_ROOT", "/d"), ("HABIBI_PORT", port)])).is_err(), "{port}");
    }
}

#[test]
fn credentials_stay_in_memory() {
    isolate_credentials();
    let entry = keyring::Entry::new("Habibi Devserver Test", "probe").unwrap();
    entry.set_password("in-memory").unwrap();
    assert_eq!(keyring::Entry::new("Habibi Devserver Test", "probe").unwrap().get_password().unwrap(), "in-memory");
    let store = keyring_core::get_default_store().unwrap();
    assert!(store.vendor().starts_with("Mock store"), "{}", store.vendor());
}
