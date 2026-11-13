//! Dragging a file out of the launcher into Finder, Explorer or another app
//! as a real file (not a URL):
//!
//! - macOS: an `NSDraggingSession` begun from the webview during the actual
//!   `leftMouseDragged` event, as the Swift app did from `mouseDragged`.
//!   AppKit needs that event, and by the time the page's `dragstart` reaches
//!   the shell WebKit has already chosen its own URL drag, so a local event
//!   monitor watches for the first drag after a prepared press.
//! - Windows: the shell item's data object (`CF_HDROP` plus the shell ID
//!   list) handed to `SHDoDragDrop`, the shell's OLE `DoDragDrop` wrapper,
//!   started from the page's `dragstart` while the button is still down.
//! - Linux: not available (see [`supported`]).

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragEvent {
    Started,
    Ended,
    Failed,
}

/// True where the shell can start an OS file drag. On Linux, WebKitGTK owns
/// the webview's GTK drag-source signals and a drag on Wayland needs the
/// serial of the original button press, which the shell never sees; an
/// untestable half-working drag would be worse than the page's own fallback.
pub const fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// The file or folder the page asked to drag, if it may be dragged: an
/// absolute path that exists and, with symlinks resolved, sits strictly
/// inside the user's home folder. (The Swift app only checked that the path
/// existed; the page can name any path, so confine it like `/api/file`.)
pub fn draggable_path(home: &Path, requested: &str) -> Option<PathBuf> {
    if requested.is_empty() || requested.len() > 4096 || requested.contains('\0') {
        return None;
    }
    let path = Path::new(requested);
    if !path.is_absolute() {
        return None;
    }
    let target = std::fs::canonicalize(path).ok()?;
    let home = std::fs::canonicalize(home).ok()?;
    (target != home && target.starts_with(&home)).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_paths_inside_home_are_draggable() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(home.join("Documents")).unwrap();
        let file = home.join("Documents/report.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let outside = root.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();

        let real_file = std::fs::canonicalize(&file).unwrap();
        assert_eq!(draggable_path(&home, file.to_str().unwrap()), Some(real_file));
        assert!(draggable_path(&home, home.join("Documents").to_str().unwrap()).is_some(), "folders drag too");
        assert_eq!(draggable_path(&home, home.to_str().unwrap()), None, "not the home folder itself");
        assert_eq!(draggable_path(&home, outside.to_str().unwrap()), None);
        assert_eq!(draggable_path(&home, home.join("missing.txt").to_str().unwrap()), None);
        assert_eq!(draggable_path(&home, "Documents/report.pdf"), None, "relative paths");
        let escape = home.join("Documents/../../secret.txt");
        assert_eq!(draggable_path(&home, escape.to_str().unwrap()), None);
        assert_eq!(draggable_path(&home, ""), None);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_home_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"x").unwrap();
        let link = home.join("link.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(draggable_path(&home, link.to_str().unwrap()), None);
    }
}
