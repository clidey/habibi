//! The fixed set of user folders a request may name. A model or the UI never
//! supplies an arbitrary filesystem path here.

use std::path::{Path, PathBuf};

/// Names accepted by `/api/open-folder`, with their usual home-relative path.
pub const NAMED_FOLDERS: &[(&str, &str)] = &[
    ("Home", ""),
    ("Desktop", "Desktop"),
    ("Documents", "Documents"),
    ("Downloads", "Downloads"),
    ("Pictures", "Pictures"),
    ("Music", "Music"),
    ("Movies", "Movies"),
    ("Projects", "Projects"),
    ("Developer", "Developer"),
    ("Code", "Code"),
];

/// Where the named folder lives for `home`. On macOS this is always
/// `home/<name>`. On Windows and Linux the standard folders follow the OS
/// (Known Folders, XDG user dirs: e.g. `Movies` is `Videos`) when `home` is the
/// real home directory, and fall back to `home/<name>` otherwise.
pub fn named_folder(home: &Path, name: &str) -> Option<PathBuf> {
    let (_, relative) = NAMED_FOLDERS.iter().find(|(known, _)| *known == name)?;
    if relative.is_empty() {
        return Some(home.to_path_buf());
    }
    #[cfg(not(target_os = "macos"))]
    if dirs::home_dir().as_deref() == Some(home) {
        let known = match name {
            "Desktop" => dirs::desktop_dir(),
            "Documents" => dirs::document_dir(),
            "Downloads" => dirs::download_dir(),
            "Pictures" => dirs::picture_dir(),
            "Music" => dirs::audio_dir(),
            "Movies" => dirs::video_dir(),
            _ => None,
        };
        if let Some(known) = known {
            return Some(known);
        }
    }
    Some(home.join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_names_resolve() {
        let home = Path::new("/nonexistent-home");
        assert_eq!(named_folder(home, "Home"), Some(home.to_path_buf()));
        assert_eq!(named_folder(home, "Code"), Some(home.join("Code")));
        assert_eq!(named_folder(home, "../etc"), None);
        assert_eq!(named_folder(home, "Library"), None);
    }
}
