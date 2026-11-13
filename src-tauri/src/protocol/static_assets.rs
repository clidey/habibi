//! The launcher's static allowlist, shared by the shell's `habibi://` scheme
//! and the development server (`crates/habibi-devserver` includes this file
//! with `#[path]`), so both serve exactly the same files. Keep it free of
//! Tauri types.

use std::path::{Path, PathBuf};

use base64::Engine;
use sha2::{Digest, Sha256};

/// The launcher's static surface is small and fully known. `.habibi/`
/// secrets, `.openwa/` keys, `.env`, `package.json`, `.git` must never be
/// reachable, so this is an allowlist rather than a denylist (ported from
/// `src/core/static-assets.ts`).
pub const ALLOWED: &[&str] = &[
    "/index.html",
    "/app.css",
    "/assets/styles/legacy-workspaces.css",
    "/assets/styles/whodb-themes.css",
    "/assets/styles/whodb-spinner.css",
    "/assets/styles/confirmation-forms.css",
    "/assets/styles/workspace-layouts.css",
    "/assets/styles/teleprompter.css",
    "/assets/styles/teleprompter-overlay.css",
    "/assets/teleprompter-overlay.html",
    "/assets/styles/emoji.css",
    "/assets/app.bundle.js",
    "/assets/teleprompter.bundle.js",
    "/assets/emoji.bundle.js",
    "/assets/notes.bundle.js",
    "/assets/settings.bundle.js",
    "/assets/daily.bundle.js",
    "/assets/assistant-tools.bundle.js",
    "/assets/styles/assistant-tools.css",
    "/assets/mail-composer.bundle.js",
    "/assets/styles/daily.css",
    "/assets/styles/focus-overlay.css",
    "/assets/focus-overlay.html",
    "/assets/styles/notes.css",
    "/assets/styles/ux.css",
    "/assets/styles/ux-layers.css",
    "/assets/ux.bundle.js",
    "/assets/emoji-catalog.json",
    "/assets/app.bundle.js.map",
    "/assets/logo.png",
    "/assets/whodb-logo.svg",
    "/assets/fonts/HankenGrotesk-normal-latin.woff2",
    "/assets/fonts/HankenGrotesk-italic-latin.woff2",
    "/assets/fonts/JetBrainsMono-normal-latin.woff2",
];

/// Served locally rather than from a CDN: allowing a third-party script
/// origin in the CSP would defeat its no-inline-script protection.
pub const VENDOR: &[(&str, &str)] = &[
    ("/vendor/xterm.js", "assets/vendor/xterm.js"),
    ("/vendor/xterm.css", "assets/vendor/xterm.css"),
    ("/vendor/xterm-fit.js", "assets/vendor/xterm-fit.js"),
];

pub fn content_type(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("css") => "text/css",
        Some("html") => "text/html",
        Some("js") => "text/javascript",
        Some("json") | Some("map") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// The file for an allowlisted request path, contained in `root`.
pub fn resolve_static(path: &str, root: &Path) -> Option<PathBuf> {
    let requested = if path == "/" { "/index.html" } else { path };
    let relative = if let Some((_, file)) = VENDOR.iter().find(|(route, _)| *route == requested) {
        (*file).to_string()
    } else if ALLOWED.contains(&requested) {
        requested.trim_start_matches('/').to_string()
    } else {
        return None;
    };
    let file = root.join(relative);
    (file != root && file.starts_with(root)).then_some(file)
}

/// `sha256-…` sources for every inline `<script>` in `html`, so the overlay
/// pages' small bootstrap scripts run while `script-src` stays `'self'`.
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut hashes = Vec::new();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find("<script").map(|offset| cursor + offset) {
        let Some(tag_end) = lower[start..].find('>').map(|offset| start + offset) else { break };
        let Some(close) = lower[tag_end..].find("</script").map(|offset| tag_end + offset) else { break };
        let tag = &lower[start..tag_end];
        if !tag.contains(" src=") && !tag.contains("\tsrc=") && !tag.contains("\nsrc=") {
            let body = &html[tag_end + 1..close];
            let digest = Sha256::digest(body.as_bytes());
            hashes.push(format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(digest)));
        }
        cursor = close;
    }
    hashes
}
