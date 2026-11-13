//! Everything that differs between macOS, Windows and Linux.
//!
//! Services call these functions instead of shelling out to `open`,
//! `osascript`, `security` and friends. Each module keeps the per-OS code
//! behind `cfg(target_os = ...)` and returns a portable result; when a
//! capability does not exist on a platform the function returns
//! [`PlatformError::Unsupported`] so the UI can hide the feature.

pub mod apps;
pub mod contacts;
pub mod folders;
pub mod fsutil;
pub mod open;
pub mod preview;
pub mod processes;
pub mod secrets;
pub mod system;
pub mod terminal;

mod exec;

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("This is not available on this platform.")]
    Unsupported,
    #[error("{0}")]
    Failed(String),
}

pub type PlatformResult<T> = Result<T, PlatformError>;

/// `macos`, `windows` or `linux`, as reported to the UI.
pub fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// The user's home directory as the OS reports it (`$HOME`, or the profile
/// folder on Windows).
pub fn home() -> Option<std::path::PathBuf> {
    dirs::home_dir()
}
