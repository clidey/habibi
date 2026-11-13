//! Loopback HTTP host for development and documentation tooling only.
//!
//! The app itself has no HTTP server: the Tauri shell serves the page from
//! bundled resources and routes `/api/*` over IPC. Playwright scripts
//! (`pnpm run check:ui`, `pnpm generate:demo-screenshots`) need a plain
//! browser origin instead, so this binary serves the shell's exact static
//! allowlist and forwards `/api/*` to [`habibi_server::Server`], with the
//! Node host's loopback Host/Origin checks and security headers.
//!
//! The native bridge (`window.webkit.messageHandlers.habibiNative`) does not
//! exist here; scripts that need it stub it in the page.

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use habibi_core::{ApiRequest, ApiResponse, Method, Paths};
use habibi_server::Server;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::http::{HeaderMap, Request, Response, StatusCode, header};

pub mod security;

/// The shell's allowlist, compiled from the same file so the two can never
/// drift.
#[path = "../../../src-tauri/src/protocol/static_assets.rs"]
pub mod static_assets;

pub const DEFAULT_PORT: u16 = 4173;

/// Request bodies above this are refused before buffering. It is above every
/// route's own limit (the largest is the 10 MiB WhatsApp send); routes still
/// enforce theirs.
pub const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub app_root: PathBuf,
    pub state_root: PathBuf,
    pub home: PathBuf,
}

impl Config {
    /// `HABIBI_DATA_ROOT` (required), `HABIBI_PORT` (default 4173),
    /// `HABIBI_ROOT` (default: the repository root) and `HABIBI_HOME`
    /// (default: `<data root>/home`, so file search, `@` mentions and file
    /// tools never see the real home folder unless asked to).
    pub fn from_env(var: impl Fn(&str) -> Option<OsString>) -> Result<Self, String> {
        let non_empty = |name: &str| var(name).filter(|value| !value.is_empty());
        let state_root = non_empty("HABIBI_DATA_ROOT").map(PathBuf::from).ok_or(
            "HABIBI_DATA_ROOT is required: point it at a scratch directory so the dev server never touches real Habibi data.",
        )?;
        let port = match non_empty("HABIBI_PORT") {
            None => DEFAULT_PORT,
            Some(value) => value
                .to_str()
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port > 0)
                .ok_or("HABIBI_PORT must be a port number between 1 and 65535.")?,
        };
        let app_root = non_empty("HABIBI_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
        let home = non_empty("HABIBI_HOME").map(PathBuf::from).unwrap_or_else(|| state_root.join("home"));
        Ok(Self { port, app_root, state_root, home })
    }

    /// Create the state and home folders and resolve every path, so the
    /// static containment check compares canonical paths.
    pub fn prepare(mut self) -> Result<Self, String> {
        for (name, dir) in [("HABIBI_DATA_ROOT", &mut self.state_root), ("HABIBI_HOME", &mut self.home)] {
            std::fs::create_dir_all(&*dir).map_err(|_| format!("Could not create {name} ({}).", dir.display()))?;
            *dir = dir.canonicalize().map_err(|_| format!("Could not resolve {name}."))?;
        }
        self.app_root = self.app_root.canonicalize().map_err(|_| "HABIBI_ROOT does not exist.".to_string())?;
        if !self.app_root.join("index.html").is_file() {
            return Err(format!("HABIBI_ROOT ({}) has no index.html.", self.app_root.display()));
        }
        Ok(self)
    }

    pub fn paths(&self) -> Paths {
        Paths::new(&self.app_root, &self.state_root, &self.home)
    }
}

/// Replace the OS credential store with keyring-core's in-memory mock for
/// this process, so model/mail/WhoDB keys saved through the UI never reach,
/// and are never read from, the real Keychain / Credential Manager / Secret
/// Service. Call before anything creates a credential entry.
pub fn isolate_credentials() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // `keyring` installs the native store lazily on first use; force
        // that now so it cannot later overwrite the mock.
        let _ = keyring::Entry::store_status();
        if let Ok(store) = keyring_core::mock::Store::new() {
            keyring_core::set_default_store(store);
        }
    });
}

pub struct DevServer {
    server: Arc<Server>,
    app_root: PathBuf,
    port: u16,
}

pub type HttpResponse = Response<Full<Bytes>>;

impl DevServer {
    /// Must run inside the Tokio runtime (services attach background work).
    pub fn new(config: &Config) -> Arc<Self> {
        Arc::new(Self { server: Server::new(config.paths()), app_root: config.app_root.clone(), port: config.port })
    }

    /// The port Host/Origin are checked against (tests bind port 0 first).
    pub fn with_port(server: Arc<Server>, app_root: PathBuf, port: u16) -> Arc<Self> {
        Arc::new(Self { server, app_root, port })
    }

    /// Stop child processes (the OpenWA runtime) before exiting.
    pub async fn shutdown(&self) {
        self.server.shutdown().await;
    }

    /// Answer one request whose body has already been read.
    pub async fn respond(&self, method: &str, path_and_query: &str, headers: &HeaderMap, body: Vec<u8>) -> HttpResponse {
        if !security::is_trusted_local_request(headers, self.port) {
            return finish(
                StatusCode::FORBIDDEN,
                vec![("Content-Type".into(), "application/json".into())],
                br#"{"ok":false,"error":"Local requests only"}"#.to_vec(),
                &[],
            );
        }
        let path = path_and_query.split_once('?').map_or(path_and_query, |(path, _)| path);
        if path.starts_with("/api/") {
            let method = Method::parse(method);
            // Product analytics stay off for development and documentation
            // runs; acknowledge exactly as the route does, without sending.
            if method == Method::Post && path == "/api/analytics/capture" {
                return from_api(ApiResponse::json(&serde_json::json!({ "ok": true })));
            }
            return from_api(self.server.handle(&ApiRequest::new(method, path_and_query, body)).await);
        }
        if !matches!(method, "GET" | "HEAD") {
            return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        }
        self.serve_static(path)
    }

    fn serve_static(&self, path: &str) -> HttpResponse {
        let Some(file) = static_assets::resolve_static(path, &self.app_root) else {
            return plain(StatusCode::NOT_FOUND, "Not found");
        };
        let Ok(data) = std::fs::read(&file) else { return plain(StatusCode::NOT_FOUND, "Not found") };
        let kind = static_assets::content_type(&file.to_string_lossy());
        let hashes =
            if kind == "text/html" { static_assets::inline_script_hashes(&String::from_utf8_lossy(&data)) } else { Vec::new() };
        finish(
            StatusCode::OK,
            vec![("Content-Type".into(), kind.into()), ("Cache-Control".into(), "no-store".into())],
            data,
            &hashes,
        )
    }

    /// Read a hyper request (bounded) and answer it.
    pub async fn handle(&self, request: Request<Incoming>) -> HttpResponse {
        let (parts, body) = request.into_parts();
        let declared = parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        if declared.is_some_and(|length| length > MAX_REQUEST_BYTES) {
            return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request too large");
        }
        let body = match Limited::new(body, MAX_REQUEST_BYTES).collect().await {
            Ok(collected) => collected.to_bytes().to_vec(),
            Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request too large"),
        };
        let target = parts.uri.path_and_query().map_or_else(|| parts.uri.path().to_string(), |value| value.as_str().to_string());
        self.respond(parts.method.as_str(), &target, &parts.headers, body).await
    }
}

fn finish(status: StatusCode, headers: Vec<(String, String)>, body: Vec<u8>, script_hashes: &[String]) -> HttpResponse {
    let mut builder = Response::builder().status(status);
    for (name, value) in security::headers(script_hashes) {
        builder = builder.header(name, value);
    }
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder.body(Full::new(Bytes::from(body))).unwrap_or_else(|_| {
        let mut response = Response::new(Full::new(Bytes::from_static(b"Internal error")));
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        response
    })
}

fn plain(status: StatusCode, text: &str) -> HttpResponse {
    finish(status, vec![("Content-Type".into(), "text/plain".into())], text.as_bytes().to_vec(), &[])
}

fn from_api(response: ApiResponse) -> HttpResponse {
    let status = StatusCode::from_u16(response.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    finish(status, response.headers, response.body, &[])
}

/// Accept connections until the listener fails. Each connection is HTTP/1.1.
pub async fn serve(listener: tokio::net::TcpListener, server: Arc<DevServer>) -> std::io::Result<()> {
    loop {
        let (stream, _peer): (_, SocketAddr) = listener.accept().await?;
        let server = server.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let server = server.clone();
                async move { Ok::<_, std::convert::Infallible>(server.handle(request).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

#[cfg(test)]
mod tests;
