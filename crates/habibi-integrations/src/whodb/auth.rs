//! WhoDB sign-in: the CLI-compatible OIDC authorization code + PKCE flow
//! (`src/connectors/whodb-auth.js`). Only an active login owns a loopback
//! callback listener, on a random port, and it closes as soon as the login
//! finishes, is cancelled or expires.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use url::Url;

use super::WhoDbError;
use super::store::{TokenStore, Tokens};
use crate::http::{HttpFetch, HttpRequest};
use crate::util::{base64url, now_ms, random_token};

pub const DEFAULT_HOST: &str = "https://app.whodb.com";

fn failure() -> Value {
    json!({ "ok": false, "error": "WhoDB sign-in failed or expired. Try signing in again." })
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// HTTPS for hosted instances; plain HTTP is restricted to loopback development.
pub(crate) fn whodb_url(value: &str) -> Result<Url, ()> {
    let candidate = if value.contains("://") { value.to_string() } else { format!("https://{value}") };
    let url = Url::parse(&candidate).map_err(|_| ())?;
    let host = url.host_str().unwrap_or("");
    let secure = url.scheme() == "https" || (url.scheme() == "http" && is_loopback(host));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
        || url.query().is_some_and(|query| !query.is_empty())
        || !secure
    {
        return Err(());
    }
    Ok(url)
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn href_without_slash(url: &Url) -> String {
    url.as_str().strip_suffix('/').unwrap_or(url.as_str()).to_string()
}

/// Match the CLI's completion page, including its local backend/frontend port mapping.
pub(crate) fn connected_url(host: &str) -> Result<String, ()> {
    let mut url = whodb_url(host)?;
    if url.port() == Some(8080) && is_loopback(url.host_str().unwrap_or("")) {
        url.set_port(Some(3000)).map_err(|_| ())?;
    }
    Ok(format!("{}/mcp-connected", href_without_slash(&url)))
}

/// Bounded auth/API reads never follow redirects carrying credentials to a different host.
pub(crate) async fn whodb_json(http: &dyn HttpFetch, request: HttpRequest) -> Result<Value, ()> {
    let response = http.send(request.timeout(Duration::from_secs(20)).max_bytes(2_000_000)).await.map_err(|_| ())?;
    let data: Value = serde_json::from_slice(&response.body).map_err(|_| ())?;
    if !response.ok() {
        return Err(());
    }
    Ok(data)
}

#[derive(Debug, Clone)]
struct Meta {
    client_id: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Default)]
struct FlowState {
    done: bool,
    url: Option<String>,
    has_result: bool,
    received: bool,
    tasks: Vec<AbortHandle>,
}

struct Flow {
    id: String,
    state: Mutex<FlowState>,
    result: watch::Sender<Option<Value>>,
}

impl Flow {
    fn lock(&self) -> std::sync::MutexGuard<'_, FlowState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn done(&self) -> bool {
        self.lock().done
    }

    /// Settle once: stop the listener and timer and publish the result.
    fn finish(&self, result: Value) {
        let tasks = {
            let mut state = self.lock();
            if state.done {
                return;
            }
            state.done = true;
            std::mem::take(&mut state.tasks)
        };
        // `send_replace` stores the value even when nobody is waiting yet.
        self.result.send_replace(Some(result));
        for task in tasks {
            task.abort();
        }
    }
}

/// Opens the authorization URL in the user's browser; `true` on success.
pub type Opener = Arc<dyn Fn(&str) -> bool + Send + Sync>;
/// Called with the instance origin once its tokens are saved.
pub type OnConnected = Arc<dyn Fn(&str) + Send + Sync>;

/// Supplies a valid access token for an instance.
#[async_trait]
pub trait TokenSource: Send + Sync {
    async fn token(&self, host: &str) -> Result<String, WhoDbError>;
}

pub struct WhoDbAuth {
    store: TokenStore,
    http: Arc<dyn HttpFetch>,
    on_connected: OnConnected,
    opener: Opener,
    login_timeout: Duration,
    pending: Mutex<Option<Arc<Flow>>>,
    cached: Mutex<Option<(String, Tokens)>>,
    refreshing: tokio::sync::Mutex<()>,
}

struct Callback {
    auth: Arc<WhoDbAuth>,
    flow: Arc<Flow>,
    meta: Meta,
    host: String,
    state: String,
    verifier: String,
    redirect: String,
    expected_host: String,
}

impl WhoDbAuth {
    pub fn new(
        store: TokenStore,
        http: Arc<dyn HttpFetch>,
        on_connected: OnConnected,
        opener: Opener,
        login_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            http,
            on_connected,
            opener,
            login_timeout,
            pending: Mutex::new(None),
            cached: Mutex::new(None),
            refreshing: tokio::sync::Mutex::new(()),
        })
    }

    fn pending(&self) -> Option<Arc<Flow>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn pending_with(&self, id: &str) -> Option<Arc<Flow>> {
        self.pending().filter(|flow| flow.id == id)
    }

    async fn metadata(&self, host: &str) -> Result<Meta, ()> {
        let config = whodb_json(&*self.http, HttpRequest::new("GET", format!("{host}/api/auth-config"))).await?;
        let client_id = config.get("clientId").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or(())?;
        if config.get("version") != Some(&json!(2)) || config.pointer("/flows/authorizationCodePkce") != Some(&json!(true)) {
            return Err(());
        }
        let issuer_url = whodb_url(config.get("issuer").and_then(Value::as_str).ok_or(())?)?;
        let issuer = href_without_slash(&issuer_url);
        let discovery = whodb_json(
            &*self.http,
            HttpRequest::new("GET", format!("{issuer}/.well-known/openid-configuration")),
        )
        .await?;
        let declared = discovery.get("issuer").and_then(Value::as_str).ok_or(())?;
        if declared.strip_suffix('/').unwrap_or(declared) != issuer {
            return Err(());
        }
        let endpoint = |key: &str| -> Result<String, ()> {
            let value = discovery.get(key).and_then(Value::as_str).ok_or(())?;
            if origin(&whodb_url(value)?) != origin(&issuer_url) {
                return Err(());
            }
            Ok(value.to_string())
        };
        Ok(Meta {
            client_id: client_id.to_string(),
            authorization_endpoint: endpoint("authorization_endpoint")?,
            token_endpoint: endpoint("token_endpoint")?,
        })
    }

    async fn exchange(&self, meta: &Meta, values: &[(&str, &str)]) -> Result<Tokens, ()> {
        let body = {
            let mut form = form_urlencoded::Serializer::new(String::new());
            form.append_pair("client_id", &meta.client_id);
            for (key, value) in values {
                form.append_pair(key, value);
            }
            form.finish()
        };
        let request = HttpRequest::new("POST", meta.token_endpoint.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body);
        let data = whodb_json(&*self.http, request).await?;
        let access = data.get("access_token").and_then(Value::as_str).filter(|token| !token.is_empty()).ok_or(())?;
        let bearer = data.get("token_type").and_then(Value::as_str).is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"));
        let expires_in = data.get("expires_in").and_then(Value::as_f64).filter(|value| value.is_finite() && *value > 0.0);
        let (true, Some(expires_in)) = (bearer, expires_in) else { return Err(()) };
        let refresh = data.get("refresh_token").and_then(Value::as_str).unwrap_or("");
        Ok(Tokens {
            access_token: access.to_string(),
            refresh_token: refresh.to_string(),
            expires_at: now_ms() + expires_in * 1000.0,
        })
    }

    /// `/api/whodb/login`: prepare a login and its callback listener. The
    /// browser is opened separately with [`Self::open`].
    pub async fn begin(self: &Arc<Self>, raw_host: &str) -> Value {
        let flow = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if pending.as_ref().is_some_and(|flow| !flow.done()) {
                return json!({
                    "ok": false,
                    "error": "WhoDB sign-in is already open. Finish it in your browser or cancel it first.",
                });
            }
            let flow = Arc::new(Flow { id: random_token(24), state: Mutex::default(), result: watch::channel(None).0 });
            *pending = Some(flow.clone());
            flow
        };
        match self.prepare(&flow, raw_host).await {
            Ok(value) => value,
            Err(()) => {
                flow.finish(failure());
                failure()
            }
        }
    }

    async fn prepare(self: &Arc<Self>, flow: &Arc<Flow>, raw_host: &str) -> Result<Value, ()> {
        let host = origin(&whodb_url(if raw_host.is_empty() { DEFAULT_HOST } else { raw_host })?);
        let meta = self.metadata(&host).await?;
        let current = self.pending().is_some_and(|pending| Arc::ptr_eq(&pending, flow));
        if !current || flow.done() {
            return Err(());
        }
        let state = random_token(32);
        let verifier = random_token(32);
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| ())?;
        let port = listener.local_addr().map_err(|_| ())?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
        let mut authorization = Url::parse(&meta.authorization_endpoint).map_err(|_| ())?;
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("response_type", "code")
            .append_pair("scope", "openid profile email offline_access")
            .append_pair("redirect_uri", &redirect)
            .append_pair("client_id", &meta.client_id)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .finish();
        authorization.set_query(Some(&query));
        let callback = Arc::new(Callback {
            auth: self.clone(),
            flow: flow.clone(),
            meta,
            host: host.clone(),
            state,
            verifier,
            redirect,
            expected_host: format!("127.0.0.1:{port}"),
        });
        let accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let callback = callback.clone();
                tokio::spawn(async move { callback.serve(stream).await });
            }
        });
        let timer_flow = flow.clone();
        let timeout = self.login_timeout;
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            timer_flow.finish(failure());
        });
        {
            let mut state = flow.lock();
            if state.done {
                accept.abort();
                timer.abort();
                return Err(());
            }
            state.tasks = vec![accept.abort_handle(), timer.abort_handle()];
            state.url = Some(authorization.to_string());
            state.has_result = true;
        }
        Ok(json!({ "ok": true, "id": flow.id, "url": authorization.as_str(), "host": host }))
    }

    /// `/api/whodb/login/open`: only the server-owned authorization URL of
    /// the pending login can be opened.
    pub async fn open(&self, id: &str) -> Value {
        let Some(flow) = self.pending_with(id) else { return failure() };
        let url = {
            let state = flow.lock();
            if state.done {
                return failure();
            }
            state.url.clone()
        };
        match url {
            Some(url) if (self.opener)(&url) => json!({ "ok": true }),
            _ => failure(),
        }
    }

    /// `/api/whodb/login/wait`: resolves when the login finishes.
    pub async fn wait(&self, id: &str) -> Value {
        let Some(flow) = self.pending_with(id) else { return failure() };
        if !flow.lock().has_result {
            return failure();
        }
        let mut receiver = flow.result.subscribe();
        match receiver.wait_for(Option::is_some).await {
            Ok(result) => result.clone().unwrap_or_else(failure),
            Err(_) => failure(),
        }
    }

    /// `/api/whodb/login/cancel`.
    pub fn cancel(&self, id: &str) -> Value {
        if let Some(flow) = self.pending_with(id) {
            flow.finish(failure());
        }
        json!({ "ok": true })
    }

    async fn access_token(&self, host: &str, force: bool) -> Result<String, WhoDbError> {
        let _refreshing = self.refreshing.lock().await;
        let cached = self.cached.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let saved = match cached.filter(|(cached_host, _)| cached_host == host) {
            Some((_, tokens)) => Some(tokens),
            None => self.store.get(host).await,
        };
        let Some(saved) = saved else { return Err(WhoDbError::SignInRequired) };
        if !force && saved.expires_at > now_ms() + 30_000.0 {
            *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some((host.to_string(), saved.clone()));
            return Ok(saved.access_token);
        }
        if saved.refresh_token.is_empty() {
            return Err(WhoDbError::SignInRequired);
        }
        let meta = self.metadata(host).await.map_err(|_| WhoDbError::Failed)?;
        let mut tokens = self
            .exchange(&meta, &[("grant_type", "refresh_token"), ("refresh_token", &saved.refresh_token)])
            .await
            .map_err(|_| WhoDbError::Failed)?;
        if tokens.refresh_token.is_empty() {
            tokens.refresh_token = saved.refresh_token;
        }
        self.store.set(host, &tokens).await.map_err(|_| WhoDbError::Failed)?;
        let access = tokens.access_token.clone();
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some((host.to_string(), tokens));
        Ok(access)
    }
}

#[async_trait]
impl TokenSource for WhoDbAuth {
    /// A valid access token, refreshed lazily when it is about to expire.
    async fn token(&self, host: &str) -> Result<String, WhoDbError> {
        self.access_token(host, false).await
    }
}

/// The parts of a request head the callback checks.
struct Head {
    method: String,
    target: String,
    host: Option<String>,
}

async fn read_head(stream: &mut TcpStream) -> Option<Head> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > 16 * 1024 {
            return None;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim().to_string());
    Some(Head { method, target, host })
}

async fn respond(stream: &mut TcpStream, status: u16, location: Option<&str>, body: &str) {
    let reason = match status {
        302 => "Found",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(location) = location {
        response.push_str(&format!("Location: {location}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(body);
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

impl Callback {
    async fn serve(&self, mut stream: TcpStream) {
        // Matches the Node listener's 10 s header timeout.
        let Ok(Some(head)) = tokio::time::timeout(Duration::from_secs(10), read_head(&mut stream)).await else {
            return;
        };
        let url = Url::parse(&format!("http://127.0.0.1{}", head.target)).ok().filter(|_| head.target.starts_with('/'));
        let Some(url) = url.filter(|url| {
            head.method == "GET" && head.host.as_deref() == Some(self.expected_host.as_str()) && url.path() == "/"
        }) else {
            return respond(&mut stream, 404, None, "").await;
        };
        let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
        let accepted = {
            let mut state = self.flow.lock();
            let valid = param("state").as_deref() == Some(self.state.as_str()) && !state.received && !state.done;
            if valid {
                state.received = true;
            }
            valid
        };
        if !accepted {
            return respond(&mut stream, 400, None, "Invalid sign-in callback.").await;
        }
        let code = param("code").filter(|code| !code.is_empty());
        let Some(code) = code.filter(|_| param("error").is_none()) else {
            respond(&mut stream, 400, None, "Sign-in cancelled. Return to Habibi.").await;
            return self.flow.finish(failure());
        };
        match self.complete(&code).await {
            Ok(location) => {
                respond(&mut stream, 302, Some(&location), "").await;
                self.flow.finish(json!({ "ok": true }));
            }
            Err(()) => {
                respond(&mut stream, 400, None, "Could not finish sign-in. Return to Habibi and try again.").await;
                self.flow.finish(failure());
            }
        }
    }

    async fn complete(&self, code: &str) -> Result<String, ()> {
        let auth = &self.auth;
        let tokens = auth
            .exchange(
                &self.meta,
                &[
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("redirect_uri", &self.redirect),
                    ("code_verifier", &self.verifier),
                ],
            )
            .await?;
        if self.flow.done() {
            return Err(());
        }
        auth.store.set(&self.host, &tokens).await?;
        if self.flow.done() {
            return Err(());
        }
        (auth.on_connected)(&self.host);
        *auth.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some((self.host.clone(), tokens));
        connected_url(&self.host)
    }
}

#[cfg(test)]
mod tests;
