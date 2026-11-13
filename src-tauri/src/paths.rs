//! Where the shell reads bundled resources and keeps state.

use std::path::{Path, PathBuf};

use habibi_core::Paths;
use tauri::Manager;

pub struct Resolved {
    pub paths: Paths,
    /// `HABIBI_DATA_ROOT` was set (tests, smoke runs): never touch the
    /// user's real settings.
    pub overridden: bool,
}

/// The per-user state root.
///
/// macOS keeps the exact directory the Swift app passed to the Node service
/// as `HABIBI_DATA_ROOT` — `~/Library/Application Support/Habibi` — so
/// existing installs keep their data. Windows and Linux use the platform data
/// directory (`%APPDATA%\Habibi`, `~/.local/share/Habibi`).
pub fn default_state_root() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join("Habibi"))
}

fn app_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("HABIBI_APP_ROOT").map(PathBuf::from).filter(|root| root.join("index.html").is_file()) {
        return Some(root);
    }
    // Development builds read the working tree so a rebuilt client bundle is
    // picked up without re-copying resources.
    if cfg!(debug_assertions) {
        let tree = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        if tree.join("index.html").is_file() {
            return tree.canonicalize().ok();
        }
    }
    app.path().resource_dir().ok()
}

pub fn resolve(app: &tauri::AppHandle) -> Result<Resolved, String> {
    let overridden_root = std::env::var_os("HABIBI_DATA_ROOT").map(PathBuf::from).filter(|root| !root.as_os_str().is_empty());
    let overridden = overridden_root.is_some();
    let state_root = overridden_root.or_else(default_state_root).ok_or("No data directory is available.")?;
    std::fs::create_dir_all(&state_root).map_err(|_| "Could not create Habibi's data directory.")?;
    let home = dirs::home_dir().ok_or("No home directory is available.")?;
    let app_root = app_root(app).ok_or("Habibi's resources are missing.")?;
    Ok(Resolved { paths: Paths::new(app_root, state_root, home), overridden })
}

/// GUI apps on macOS start with a minimal `PATH`. The Swift app gave its
/// service Homebrew's directories; do the same for the tools services spawn
/// (MCP servers, kubectl, agents).
pub fn extend_tool_path() {
    #[cfg(target_os = "macos")]
    {
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<&str> = current.split(':').filter(|part| !part.is_empty()).collect();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            if !parts.contains(&extra) {
                parts.push(extra);
            }
        }
        // SAFETY: called first thing in `run`, before any other thread exists.
        unsafe { std::env::set_var("PATH", parts.join(":")) };
    }
}
