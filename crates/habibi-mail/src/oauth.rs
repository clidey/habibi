//! Gmail and Zoho OAuth (authorization code + PKCE, refresh token kept in
//! the credential store).
//!
//! Users registered `http://127.0.0.1:4173/api/mail/oauth/callback` (or the
//! redirect URI they configured) in their Google/Zoho OAuth clients, and the
//! app no longer listens on a port. So only while an authorization is
//! pending, a one-shot listener is bound on that loopback address: it answers
//! only the redirect path with the expected `Host`, accepts each `state`
//! once, gives up when the request expires, and closes after the callback.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::config::{self, ConfigFile};
use crate::js;
use crate::secrets::{self, SecretStore};

/// How long a connection request stays valid (as in the Node service).
pub const REQUEST_TTL: Duration = Duration::from_secs(10 * 60);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REQUEST_BYTES: usize = 16 * 1024;

struct Pending {
    provider: String,
    redirect_uri: String,
    verifier: String,
    expires_at: Instant,
}

struct Active {
    address: SocketAddr,
    authority: String,
    path: String,
    task: JoinHandle<()>,
}

/// A loopback redirect URI split into what the listener needs.
#[derive(Debug, PartialEq)]
pub struct Redirect {
    /// `host:port` exactly as the browser will send it in `Host`.
    pub authority: String,
    pub port: u16,
    pub path: String,
}

/// Only `http://127.0.0.1:<port>/...` and `http://localhost:<port>/...` can
/// be served by a local listener.
pub fn loopback_redirect(uri: &str) -> Option<Redirect> {
    let rest = uri.strip_prefix("http://")?;
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let path = path.split(['?', '#']).next().filter(|path| !path.is_empty()).unwrap_or("/");
    let (host, port) = authority.rsplit_once(':')?;
    if !host.eq_ignore_ascii_case("127.0.0.1") && !host.eq_ignore_ascii_case("localhost") {
        return None;
    }
    let port: u16 = port.parse().ok().filter(|port| *port != 0)?;
    Some(Redirect { authority: authority.to_ascii_lowercase(), port, path: path.into() })
}

pub struct OAuth {
    config: Arc<ConfigFile>,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, Pending>>,
    active: Mutex<Option<Active>>,
    /// Tests point the token exchange at a local mock server.
    token_url: Option<String>,
}

pub enum Authorized {
    Url(String),
    Error(String),
}

impl OAuth {
    pub fn new(config: Arc<ConfigFile>, secrets: Arc<dyn SecretStore>, token_url: Option<String>) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Arc::new(Self {
            config,
            secrets,
            http,
            pending: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            token_url,
        })
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn has_pending(&self) -> bool {
        let now = Instant::now();
        let mut pending = self.pending();
        pending.retain(|_, request| request.expires_at >= now);
        !pending.is_empty()
    }

    /// Start an authorization: register the state, make sure the redirect
    /// listener runs, and return the consent URL.
    pub fn authorize(self: &Arc<Self>, provider: &str) -> Authorized {
        let config = self.config.read();
        let settings = config.get(provider);
        let (Some(definition), true, true) = (
            config::provider(provider),
            js::truthy(settings.and_then(|s| s.get("clientId"))),
            js::truthy(settings.and_then(|s| s.get("clientSecret"))),
        ) else {
            return Authorized::Error("Configure this mail provider first.".into());
        };
        let settings = settings.cloned().unwrap_or(Value::Null);
        let redirect_uri = js::string_or_empty(settings.get("redirectUri"));
        let redirect_uri =
            if redirect_uri.is_empty() { config::DEFAULT_REDIRECT_URI.to_string() } else { redirect_uri };
        let Some(redirect) = loopback_redirect(&redirect_uri) else {
            return Authorized::Error(format!(
                "Use a loopback redirect URI such as {} for this mail provider.",
                config::DEFAULT_REDIRECT_URI
            ));
        };
        let state = uuid::Uuid::new_v4().to_string();
        let (challenge, verifier) = oauth2::PkceCodeChallenge::new_random_sha256();
        self.pending().insert(
            state.clone(),
            Pending {
                provider: provider.into(),
                redirect_uri: redirect_uri.clone(),
                verifier: verifier.secret().clone(),
                expires_at: Instant::now() + REQUEST_TTL,
            },
        );
        // Registered first: the listener stops as soon as nothing is pending.
        if let Err(message) = self.ensure_listener(&redirect) {
            self.pending().remove(&state);
            return Authorized::Error(message);
        }
        let separator = if provider == "zoho" { "," } else { " " };
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &js::string_or_empty(settings.get("clientId")))
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent")
            .append_pair("state", &state)
            .append_pair("scope", &definition.scopes.join(separator))
            .append_pair("code_challenge", challenge.as_str())
            .append_pair("code_challenge_method", "S256")
            .finish();
        Authorized::Url(format!("{}?{query}", definition.auth))
    }

    fn ensure_listener(self: &Arc<Self>, redirect: &Redirect) -> Result<(), String> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, redirect.port));
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(current) = active.as_ref()
            && !current.task.is_finished()
        {
            if current.address == address && current.authority == redirect.authority && current.path == redirect.path {
                return Ok(());
            }
            current.task.abort();
        }
        let busy = || {
            format!(
                "Port {} is in use, so Habibi cannot receive the sign-in. Close the app using it and try again.",
                redirect.port
            )
        };
        let listener = std::net::TcpListener::bind(address).map_err(|_| busy())?;
        listener.set_nonblocking(true).map_err(|_| busy())?;
        let listener = TcpListener::from_std(listener).map_err(|_| busy())?;
        let task = tokio::spawn(Arc::clone(self).serve(listener, redirect.authority.clone(), redirect.path.clone()));
        *active = Some(Active { address, authority: redirect.authority.clone(), path: redirect.path.clone(), task });
        Ok(())
    }

    async fn serve(self: Arc<Self>, listener: TcpListener, authority: String, path: String) {
        // Recheck regularly so a request completed through the IPC route, or
        // one that expired, also closes the listener.
        while self.has_pending() {
            let accepted = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await;
            let Ok(Ok((stream, _))) = accepted else { continue };
            self.answer(stream, &authority, &path).await;
        }
    }

    async fn answer(&self, mut stream: TcpStream, authority: &str, path: &str) {
        let Ok(Some(head)) = tokio::time::timeout(READ_TIMEOUT, read_head(&mut stream)).await else { return };
        let (status, body) = match check_request(&head, authority, path) {
            Err(status) => (status, String::new()),
            Ok(query) => {
                // `URLSearchParams.get`: the first value wins.
                let mut pairs: HashMap<String, String> = HashMap::new();
                for (key, value) in form_urlencoded::parse(query.as_bytes()) {
                    pairs.entry(key.into_owned()).or_insert_with(|| value.into_owned());
                }
                let result = self
                    .callback(
                        pairs.get("code").map(String::as_str).unwrap_or(""),
                        pairs.get("state").map(String::as_str).unwrap_or(""),
                    )
                    .await;
                (if result.is_ok() { 200 } else { 400 }, callback_page(&result))
            }
        };
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            403 => "Forbidden",
            405 => "Method Not Allowed",
            _ => "Not Found",
        };
        let content_type = if body.is_empty() { "text/plain" } else { "text/html; charset=utf-8" };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = tokio::time::timeout(READ_TIMEOUT, stream.write_all(response.as_bytes())).await;
        let _ = stream.shutdown().await;
    }

    /// Exchange the code for a refresh token. Each state works once.
    pub async fn callback(&self, code: &str, state: &str) -> Result<String, String> {
        let request = self.pending().remove(state);
        let Some(request) = request.filter(|request| request.expires_at >= Instant::now()) else {
            return Err("This connection request expired.".into());
        };
        let config = self.config.read();
        let settings = config.get(&request.provider).cloned().unwrap_or(Value::Null);
        let Some(definition) = config::provider(&request.provider) else {
            return Err("Configure this mail provider first.".into());
        };
        let failed = || "The provider did not return a refresh token.".to_string();
        if code.is_empty() {
            return Err(failed());
        }
        let form = form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("client_id", &js::string_or_empty(settings.get("clientId")))
            .append_pair("client_secret", &js::string_or_empty(settings.get("clientSecret")))
            .append_pair("redirect_uri", &request.redirect_uri)
            .append_pair("code_verifier", &request.verifier)
            .finish();
        let url = self.token_url.as_deref().unwrap_or(definition.token);
        let response = self
            .http
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|_| failed())?;
        let ok = response.status().is_success();
        let token: Value = response.json().await.map_err(|_| failed())?;
        // The provider's error text is not shown: it is not a fixed, safe string.
        let refresh = token.get("refresh_token").and_then(Value::as_str).filter(|token| !token.is_empty());
        let (true, Some(refresh)) = (ok, refresh) else { return Err(failed()) };
        if secrets::set(&self.secrets, format!("refresh:{}", request.provider), refresh.to_string()).await {
            Ok(request.provider)
        } else {
            Err(format!("Could not save the token in {}.", secrets::store_name()))
        }
    }
}

/// The page the browser shows after the redirect.
pub fn callback_page(result: &Result<String, String>) -> String {
    let message = match result {
        Ok(_) => "Mail connected. You can close this tab and return to Habibi.".to_string(),
        Err(error) => format!("Mail connection failed: {}", error.replace('<', "&lt;")),
    };
    format!(
        "<title>Habibi Mail</title><body style=\"font-family:-apple-system,sans-serif;padding:40px\">{message}</body>"
    )
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            return String::from_utf8(buffer[..end].to_vec()).ok();
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            return None;
        }
    }
}

/// The query string of a valid callback request, or the status to refuse it.
fn check_request(head: &str, authority: &str, path: &str) -> Result<String, u16> {
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split(' ');
    let (method, target) = (request_line.next().unwrap_or(""), request_line.next().unwrap_or(""));
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim().to_ascii_lowercase());
    // Only the browser following the provider's redirect to this exact
    // address is answered; anything else (DNS rebinding, other hosts) is not.
    if host.as_deref() != Some(authority) {
        return Err(403);
    }
    let (target_path, query) = target.split_once('?').unwrap_or((target, ""));
    if target_path != path {
        return Err(404);
    }
    if method != "GET" {
        return Err(405);
    }
    Ok(query.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_redirects_are_served() {
        assert_eq!(
            loopback_redirect(config::DEFAULT_REDIRECT_URI),
            Some(Redirect { authority: "127.0.0.1:4173".into(), port: 4173, path: "/api/mail/oauth/callback".into() })
        );
        assert_eq!(loopback_redirect("http://localhost:8080").map(|r| r.path), Some("/".into()));
        assert_eq!(loopback_redirect("https://127.0.0.1:4173/x"), None);
        assert_eq!(loopback_redirect("http://example.com:4173/x"), None);
        assert_eq!(loopback_redirect("http://127.0.0.1/x"), None);
        assert_eq!(loopback_redirect("http://127.0.0.1.evil.com:80/x"), None);
    }

    #[test]
    fn requests_need_the_exact_host_path_and_method() {
        let ok = "GET /cb?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1:4173";
        assert_eq!(check_request(ok, "127.0.0.1:4173", "/cb"), Ok("code=1&state=2".into()));
        let wrong_host = "GET /cb?code=1 HTTP/1.1\r\nHost: evil.test:4173";
        assert_eq!(check_request(wrong_host, "127.0.0.1:4173", "/cb"), Err(403));
        assert_eq!(check_request("GET /cb HTTP/1.1", "127.0.0.1:4173", "/cb"), Err(403));
        let other_path = "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:4173";
        assert_eq!(check_request(other_path, "127.0.0.1:4173", "/cb"), Err(404));
        let post = "POST /cb HTTP/1.1\r\nhost: 127.0.0.1:4173";
        assert_eq!(check_request(post, "127.0.0.1:4173", "/cb"), Err(405));
    }

    #[test]
    fn the_callback_page_escapes_errors() {
        assert!(callback_page(&Err("<script>".into())).contains("&lt;script>"));
        assert!(callback_page(&Ok("gmail".into())).contains("Mail connected."));
    }
}
