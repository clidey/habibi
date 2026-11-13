use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::testing::{FakeHttp, json_response};
use crate::whodb::store::tests::MemorySecrets;

struct Fixture {
    auth: Arc<WhoDbAuth>,
    http: Arc<FakeHttp>,
    secrets: Arc<MemorySecrets>,
    store: TokenStore,
    connected: Arc<Mutex<Vec<String>>>,
    opened: Arc<Mutex<Vec<String>>>,
}

fn fixture(token_endpoint: &'static str, timeout: Duration) -> Fixture {
    let clock = Arc::new(AtomicU64::new(1));
    let http = FakeHttp::new(move |request| {
        let url = request.url.as_str();
        if url.ends_with("/api/auth-config") {
            json_response(json!({ "version": 2, "issuer": "https://auth.example.test/realm", "clientId": "whodb-cli", "flows": { "authorizationCodePkce": true } }))
        } else if url.ends_with("/.well-known/openid-configuration") {
            json_response(json!({ "issuer": "https://auth.example.test/realm", "authorization_endpoint": "https://auth.example.test/authorize", "token_endpoint": token_endpoint }))
        } else if url.ends_with("/token") {
            let n = clock.fetch_add(1, Ordering::SeqCst);
            json_response(json!({ "access_token": format!("access-{n}"), "refresh_token": "rotated-refresh-secret", "token_type": "Bearer", "expires_in": 3600 }))
        } else {
            Err(crate::http::HttpError::Connect)
        }
    });
    let secrets = Arc::new(MemorySecrets::default());
    let store = TokenStore::new(secrets.clone());
    let connected = Arc::new(Mutex::new(Vec::new()));
    let opened = Arc::new(Mutex::new(Vec::new()));
    let (connected_log, opened_log) = (connected.clone(), opened.clone());
    let auth = WhoDbAuth::new(
        store.clone(),
        http.clone(),
        Arc::new(move |host| connected_log.lock().unwrap().push(host.to_string())),
        Arc::new(move |url| {
            opened_log.lock().unwrap().push(url.to_string());
            true
        }),
        timeout,
    );
    Fixture { auth, http, secrets, store, connected, opened }
}

/// A raw loopback GET, as the browser would send it to the callback.
async fn get(target: &str, port: u16, host_header: Option<&str>) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let host = host_header.map(str::to_string).unwrap_or_else(|| format!("127.0.0.1:{port}"));
    stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).await?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await?;
    let status = response.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    Ok((status, response))
}

fn param(url: &Url, name: &str) -> String {
    url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default()
}

#[tokio::test]
async fn sso_uses_cli_discovery_random_loopback_callback_state_and_s256_pkce() {
    let f = fixture("https://auth.example.test/token", Duration::from_secs(5));
    let login = f.auth.begin("").await;
    assert_eq!(login["ok"], true);
    let id = login["id"].as_str().unwrap();
    let url = Url::parse(login["url"].as_str().unwrap()).unwrap();
    let redirect = Url::parse(&param(&url, "redirect_uri")).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    let port = redirect.port().unwrap();
    assert_ne!(port, 4173);
    assert_eq!(param(&url, "client_id"), "whodb-cli");
    assert_eq!(param(&url, "scope"), "openid profile email offline_access");
    assert_eq!(param(&url, "code_challenge_method"), "S256");
    assert_eq!(f.auth.open("untrusted-id").await["ok"], false);
    assert!(f.opened.lock().unwrap().is_empty());
    assert_eq!(f.auth.open(id).await["ok"], true);
    assert_eq!(*f.opened.lock().unwrap(), vec![url.to_string()], "only the server-owned authorization URL can be opened");
    assert_eq!(f.http.urls()[0], "https://app.whodb.com/api/auth-config");

    assert_eq!(get("/?state=wrong&code=stolen", port, None).await.unwrap().0, 400);
    assert!(f.secrets.values.lock().unwrap().is_empty());
    let state = param(&url, "state");
    assert_eq!(get(&format!("/?state={state}&code=x"), port, Some("evil.test")).await.unwrap().0, 404);
    assert_eq!(f.auth.begin("").await["ok"], false, "a second login cannot start while one is open");

    let auth = f.auth.clone();
    let owned_id = id.to_string();
    let waiting = tokio::spawn(async move { auth.wait(&owned_id).await });
    let (status, response) = get(&format!("/?state={state}&code=one-time-code"), port, None).await.unwrap();
    assert_eq!(status, 302);
    assert!(response.contains("Location: https://app.whodb.com/mcp-connected\r\n"));
    assert!(response.contains("Cache-Control: no-store\r\n"));
    assert_eq!(waiting.await.unwrap(), json!({ "ok": true }));
    assert_eq!(*f.connected.lock().unwrap(), vec!["https://app.whodb.com".to_string()]);

    let exchange = f.http.requests.lock().unwrap().iter().find(|request| request.url.ends_with("/token")).cloned().unwrap();
    let form: Vec<(String, String)> = form_urlencoded::parse(exchange.body.as_deref().unwrap()).into_owned().collect();
    let field = |name: &str| form.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone()).unwrap();
    assert_eq!(field("grant_type"), "authorization_code");
    assert_eq!(field("redirect_uri"), redirect.as_str().trim_end_matches('/'));
    assert_eq!(base64url(&Sha256::digest(field("code_verifier").as_bytes())), param(&url, "code_challenge"));
    assert!(!login.to_string().contains("refresh-secret"));

    let count = f.http.requests.lock().unwrap().len();
    assert!(f.auth.token(login["host"].as_str().unwrap()).await.unwrap().starts_with("access-"));
    assert_eq!(f.http.requests.lock().unwrap().len(), count, "warm credentials do not trigger network work");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(get("/", port, None).await.is_err(), "the callback listener closes after sign-in");
    f.auth.cancel(id);
}

#[test]
fn completion_redirect_matches_the_cli_for_hosted_and_local_instances() {
    for (host, destination) in [
        ("https://app.whodb.com", "https://app.whodb.com/mcp-connected"),
        ("https://whodb.example.test/", "https://whodb.example.test/mcp-connected"),
        ("http://localhost:8080", "http://localhost:3000/mcp-connected"),
        ("http://127.0.0.1:8080", "http://127.0.0.1:3000/mcp-connected"),
        ("http://[::1]:8080", "http://[::1]:3000/mcp-connected"),
        ("http://localhost:4000", "http://localhost:4000/mcp-connected"),
        ("https://whodb.example.test:8080", "https://whodb.example.test:8080/mcp-connected"),
    ] {
        assert_eq!(connected_url(host).unwrap(), destination);
    }
}

#[tokio::test]
async fn foreign_issuer_endpoints_and_insecure_hosts_are_rejected() {
    for value in ["http://example.test", "https://user:password@example.test", "javascript:alert(1)", "https://example.test/?token=secret"] {
        assert!(whodb_url(value).is_err(), "{value}");
    }
    let bad = fixture("https://attacker.example/token", Duration::from_secs(5));
    assert_eq!(bad.auth.begin("").await["ok"], false);
    assert!(!bad.http.urls().iter().any(|url| url.contains("attacker")));
}

#[tokio::test]
async fn cancellation_and_expiry_close_the_callback_listener() {
    for expire in [false, true] {
        let f = fixture("https://auth.example.test/token", Duration::from_millis(if expire { 25 } else { 5_000 }));
        let login = f.auth.begin("").await;
        let id = login["id"].as_str().unwrap().to_string();
        let url = Url::parse(login["url"].as_str().unwrap()).unwrap();
        let port = Url::parse(&param(&url, "redirect_uri")).unwrap().port().unwrap();
        let auth = f.auth.clone();
        let waiting = tokio::spawn({
            let id = id.clone();
            async move { auth.wait(&id).await }
        });
        if !expire {
            f.auth.cancel(&id);
        }
        assert_eq!(waiting.await.unwrap()["ok"], false);
        assert!(f.secrets.values.lock().unwrap().is_empty());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(get("/", port, None).await.is_err());
    }
}

#[tokio::test]
async fn refresh_is_lazy_and_rotated_refresh_tokens_stay_in_credential_storage() {
    let f = fixture("https://auth.example.test/token", Duration::from_secs(5));
    let host = "https://app.whodb.com";
    let expired = Tokens { access_token: "expired".into(), refresh_token: "old-refresh-secret".into(), expires_at: 0.0 };
    f.store.set(host, &expired).await.unwrap();
    let token = f.auth.token(host).await.unwrap();
    assert!(token.starts_with("access-"));
    assert_eq!(f.store.get(host).await.unwrap().refresh_token, "rotated-refresh-secret");
    let exchange = f.http.requests.lock().unwrap().iter().find(|request| request.url.ends_with("/token")).cloned().unwrap();
    let form: Vec<(String, String)> = form_urlencoded::parse(exchange.body.as_deref().unwrap()).into_owned().collect();
    assert!(form.contains(&("grant_type".into(), "refresh_token".into())));
    assert!(form.contains(&("refresh_token".into(), "old-refresh-secret".into())));
    let count = f.http.requests.lock().unwrap().len();
    assert_eq!(f.auth.token(host).await.unwrap(), token);
    assert_eq!(f.http.requests.lock().unwrap().len(), count);
    assert!(matches!(f.auth.token("https://other.test").await, Err(WhoDbError::SignInRequired)));
}
