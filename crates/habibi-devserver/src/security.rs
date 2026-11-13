//! Loopback request checks and browser policy, ported from the Node host's
//! `src/core/http-security.ts`.

use hyper::http::{HeaderMap, header};

pub const HOST: &str = "127.0.0.1";

fn single(headers: &HeaderMap, name: header::HeaderName) -> Result<Option<&str>, ()> {
    let mut values = headers.get_all(name).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(());
    }
    match first {
        None => Ok(None),
        Some(value) => value.to_str().map(Some).map_err(|_| ()),
    }
}

/// Reject DNS-rebinding and cross-origin requests before they reach a local
/// connector. This is intentionally not authentication: the service is a
/// single-user loopback process, not a network daemon.
///
/// The Host must name this port on a loopback name, so a page on
/// `attacker.example` that re-resolves its own name to 127.0.0.1 is refused.
/// A missing Origin is accepted so non-browser local callers (scripts, curl)
/// still work; a present one must be this service's own. Repeated Host or
/// Origin headers are refused rather than guessing which one counts.
pub fn is_trusted_local_request(headers: &HeaderMap, port: u16) -> bool {
    let Ok(Some(host)) = single(headers, header::HOST) else { return false };
    let host = host.to_ascii_lowercase();
    let local_hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")];
    if !local_hosts.contains(&host) {
        return false;
    }
    match single(headers, header::ORIGIN) {
        Ok(None) => true,
        Ok(Some(origin)) => [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")]
            .iter()
            .any(|allowed| allowed == origin),
        Err(()) => false,
    }
}

/// The Node host's CSP. `script-src 'self'` only (plus hashes of a page's own
/// inline bootstrap scripts, as the shell allows for the overlay pages): a
/// third-party script origin such as a CDN serves arbitrary package files, so
/// an injected `<script src>` would execute despite inline script being
/// blocked. Every dependency is served from `/vendor`. The terminal WebSocket
/// source is gone (the PTY only exists over the shell's IPC); `data:` stays
/// allowed for the pasted-image fetch, as in the shell.
pub fn content_security_policy(script_hashes: &[String]) -> String {
    let mut script = String::from("'self'");
    for hash in script_hashes {
        script.push(' ');
        script.push_str(hash);
    }
    format!(
        "default-src 'self'; connect-src 'self' data:; img-src 'self' data: https:; media-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src {script}; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
    )
}

/// A conservative browser policy that does not block bundled local assets,
/// applied to every response (`applySecurityHeaders`).
pub fn headers(script_hashes: &[String]) -> Vec<(&'static str, String)> {
    vec![
        ("X-Content-Type-Options", "nosniff".into()),
        ("X-Frame-Options", "DENY".into()),
        ("Referrer-Policy", "no-referrer".into()),
        ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()".into()),
        ("Content-Security-Policy", content_security_policy(script_hashes)),
    ]
}
