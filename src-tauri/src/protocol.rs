//! The `habibi://` scheme: the page, its allowlisted static assets, and GET
//! `/api/*` for resources the UI loads with `src=` (app icons, `/api/file`,
//! clipboard previews). Everything else under the app root is unreachable.

use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
use base64::Engine;
use habibi_core::{ApiRequest, ApiResponse, Method};
#[cfg(test)]
use sha2::{Digest, Sha256};
use tauri::http::{Request, Response, header};

use crate::shell::Shell;

// The allowlist lives in its own Tauri-free file so the development server
// (`crates/habibi-devserver`) serves exactly the same files.
mod static_assets;
pub use static_assets::{content_type, inline_script_hashes, resolve_static};

pub const SCHEME: &str = "habibi";

/// Equivalent of `applySecurityHeaders` in `src/core/http-security.ts`. The
/// loopback WebSocket source is gone (the PTY uses IPC); Tauri's own IPC
/// endpoints are allowed instead, and `data:` for the pasted-image fetch.
pub fn content_security_policy(script_hashes: &[String]) -> String {
    let mut script = String::from("'self'");
    for hash in script_hashes {
        script.push(' ');
        script.push_str(hash);
    }
    format!(
        "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost data:; img-src 'self' data: https:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src {script}; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
    )
}

fn with_security_headers(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY")
        .header("Referrer-Policy", "no-referrer")
        .header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
}

fn plain(status: u16, text: &str) -> Response<Vec<u8>> {
    with_security_headers(Response::builder())
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(text.as_bytes().to_vec())
        .unwrap_or_default()
}

pub fn from_api(response: ApiResponse) -> Response<Vec<u8>> {
    let mut builder = with_security_headers(Response::builder()).status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder.body(response.body).unwrap_or_else(|_| plain(500, "Internal error"))
}

fn serve_static(path: &str, root: &Path) -> Response<Vec<u8>> {
    let Some(file) = resolve_static(path, root) else { return plain(404, "Not found") };
    let Ok(data) = std::fs::read(&file) else { return plain(404, "Not found") };
    let kind = if path.starts_with("/vendor/") {
        if path.ends_with(".css") { "text/css" } else { "text/javascript" }
    } else {
        content_type(&file.to_string_lossy())
    };
    let mut builder = with_security_headers(Response::builder())
        .status(200)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, "no-store");
    if kind == "text/html" {
        let hashes = inline_script_hashes(&String::from_utf8_lossy(&data));
        builder = builder.header("Content-Security-Policy", content_security_policy(&hashes));
    }
    builder.body(data).unwrap_or_else(|_| plain(500, "Internal error"))
}

/// Answer one request to the `habibi://` scheme.
pub async fn serve(shell: Arc<Shell>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    if path.starts_with("/api/") {
        // Writes go through the `api` command, which carries the body; the
        // scheme only answers the reads a `src=` attribute can make.
        let method = Method::parse(request.method().as_str());
        if method != Method::Get {
            return plain(405, "Method not allowed");
        }
        let target = match request.uri().query() {
            Some(query) => format!("{path}?{query}"),
            None => path,
        };
        return from_api(shell.server.handle(&ApiRequest::get(&target)).await);
    }
    serve_static(&path, &shell.paths.app_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_allowlisted_files_inside_the_root() {
        let root = Path::new("/app");
        assert_eq!(resolve_static("/", root), Some(PathBuf::from("/app/index.html")));
        assert_eq!(resolve_static("/assets/app.bundle.js", root), Some(PathBuf::from("/app/assets/app.bundle.js")));
        assert_eq!(resolve_static("/vendor/xterm.js", root), Some(PathBuf::from("/app/assets/vendor/xterm.js")));
        for denied in ["/.habibi/mail.json", "/package.json", "/.git/config", "/assets/../.env", "/server.js", "/assets/vendor/xterm.js"] {
            assert_eq!(resolve_static(denied, root), None, "{denied}");
        }
    }

    #[test]
    fn content_types_match_the_node_host() {
        assert_eq!(content_type("a.css"), "text/css");
        assert_eq!(content_type("a.JS"), "text/javascript");
        assert_eq!(content_type("a.map"), "application/json");
        assert_eq!(content_type("a.woff2"), "font/woff2");
        assert_eq!(content_type("a.bin"), "application/octet-stream");
    }

    #[test]
    fn hashes_inline_scripts_only() {
        let html = "<script src=\"ux.bundle.js\"></script><script>\nwindow.a = 1;\n</script>";
        let hashes = inline_script_hashes(html);
        assert_eq!(hashes.len(), 1);
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"\nwindow.a = 1;\n"));
        assert_eq!(hashes[0], format!("'sha256-{expected}'"));
        let csp = content_security_policy(&hashes);
        assert!(csp.contains("script-src 'self' 'sha256-"));
        assert!(!csp.contains("unsafe-eval"));
        assert!(csp.contains("frame-src 'none'"));
    }
}
