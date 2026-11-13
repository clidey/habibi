//! Path grants and confinement (`access.ts`).
//!
//! The UI can only act on paths the user mentioned, each granted for 30
//! minutes. Every later step re-checks that the grant still resolves to the
//! same canonical place and that files have not been swapped (size, mtime,
//! device, inode) before anything is read or moved.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::contract::{FileEntry, FileGrant};
use crate::error::{FileError, FileResult, fail};
use crate::util::{self, canonical, identity, js_len, mtime_ms, now_ms};

const GRANT_TTL_MS: u64 = 30 * 60_000;
const MAX_GRANTS: usize = 40;
const MAX_VISITED: usize = 8000;
const MAX_ENTRIES: usize = 2500;
const MAX_DEPTH: usize = 8;

/// Private app data, credentials and key material, matched per path segment
/// (case-insensitive). On macOS this also covers the login Keychain folder,
/// which TCC protects for the old app; the other OSes add the folders their
/// credential stores keep on disk.
pub fn denied_part(part: &str) -> bool {
    let lower = part.to_lowercase();
    const EXACT: &[&str] = &[
        ".git",
        ".ssh",
        ".aws",
        ".gnupg",
        ".habibi",
        ".openwa",
        ".wwebjs_auth",
        ".codex",
        ".claude",
        ".npmrc",
        ".netrc",
        "keychains",
        "cookies",
        "login data",
        "history",
    ];
    if EXACT.contains(&lower.as_str())
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower == "credentials"
        || lower.starts_with("credentials.")
        || [".pem", ".key", ".p12", ".pfx", ".keychain-db"].iter().any(|suffix| lower.ends_with(suffix))
    {
        return true;
    }
    // GNOME Keyring, KWallet, `pass` and the NSS certificate database.
    #[cfg(all(unix, not(target_os = "macos")))]
    if ["keyrings", "kwalletd", ".password-store", ".pki"].contains(&lower.as_str()) {
        return true;
    }
    false
}

fn names(target: &Path) -> Vec<String> {
    target
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// System locations no file plan may read from or write to.
fn system_location(parts: &[String]) -> bool {
    let first = parts.first().map(String::as_str).unwrap_or("");
    #[cfg(target_os = "macos")]
    {
        ["System", "usr", "bin", "sbin", "etc", "Library", "Applications"].contains(&first)
            || (first == "private" && parts.get(1).map(String::as_str) == Some("etc"))
    }
    #[cfg(windows)]
    {
        let lower: Vec<String> = parts.iter().map(|part| part.to_lowercase()).collect();
        let first = first.to_lowercase();
        // Credential Manager, DPAPI master keys and certificate stores.
        let credential_store = lower.windows(4).any(|window| {
            window[0] == "appdata"
                && (window[1] == "roaming" || window[1] == "local")
                && window[2] == "microsoft"
                && ["credentials", "protect", "vault", "systemcertificates", "crypto"].contains(&window[3].as_str())
        });
        credential_store
            || [
                "windows",
                "program files",
                "program files (x86)",
                "programdata",
                "$recycle.bin",
                "system volume information",
                "recovery",
            ]
            .contains(&first.as_str())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        [
            "usr", "bin", "sbin", "etc", "lib", "lib32", "lib64", "libx32", "boot", "proc", "sys", "dev", "run", "snap",
        ]
        .contains(&first)
            || (first == "var"
                && parts
                    .get(1)
                    .is_some_and(|second| ["lib", "log", "cache", "spool", "mail"].contains(&second.as_str())))
    }
}

/// `permitted(target)`: no private segment and not a system location.
pub fn permitted(target: &Path) -> bool {
    let parts = names(target);
    !parts.iter().any(|part| denied_part(part)) && !system_location(&parts)
}

const RELATIVE_ERROR: &str = "Choose a relative name without private folders or parent-directory segments.";

/// A model-proposed destination: relative, `/`-separated, no traversal.
pub fn safe_relative(value: Option<&Value>) -> FileResult<String> {
    let Some(Value::String(value)) = value else { return fail(RELATIVE_ERROR) };
    let windows_drive = value.as_bytes().get(1) == Some(&b':');
    if value.trim().is_empty()
        || js_len(value) > 500
        || value.chars().any(|c| (c as u32) < 0x20 || c == '\\')
        || value.starts_with('/')
        || windows_drive
        || value.split('/').any(|part| part.is_empty() || part == "." || part == ".." || denied_part(part))
    {
        return fail(RELATIVE_ERROR);
    }
    // Characters Windows refuses in names; `:` would also address an
    // alternate data stream of an existing file.
    #[cfg(windows)]
    if value.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return fail(RELATIVE_ERROR);
    }
    Ok(value.clone())
}

pub(crate) struct FileAccess {
    home: PathBuf,
    grants: Mutex<HashMap<String, FileGrant>>,
}

pub(crate) struct Inventory {
    pub entries: Vec<FileEntry>,
    pub limited: bool,
}

const CHANGED: &str = "Select this path again; its access has expired or changed.";

impl FileAccess {
    pub fn new(home: PathBuf) -> Self {
        Self { home, grants: Mutex::new(HashMap::new()) }
    }

    fn sweep(grants: &mut HashMap<String, FileGrant>) {
        let now = now_ms();
        grants.retain(|_, grant| grant.expires_at >= now);
    }

    pub fn grant(&self, value: Option<&Value>) -> FileResult<FileGrant> {
        {
            let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
            Self::sweep(&mut grants);
            if grants.len() >= MAX_GRANTS {
                return fail("Too many selected paths. Reopen Ask to start a fresh selection.");
            }
        }
        let value = match value {
            Some(Value::String(value)) if js_len(value) <= 2000 && !value.chars().any(|c| (c as u32) < 0x20) => value,
            _ => return fail("Choose a file or folder."),
        };
        let requested = match value.strip_prefix("~/") {
            Some(rest) => util::normalize(&util::join_relative(&self.home, rest)),
            None => PathBuf::from(value),
        };
        let resolved = util::normalize(&requested);
        if !requested.is_absolute() || !permitted(&resolved) || resolved.parent().is_none() {
            return fail("Choose a personal file or folder, outside private app data and system locations.");
        }
        let metadata = match fs::symlink_metadata(&requested) {
            Ok(metadata) if !metadata.file_type().is_symlink() && (metadata.is_dir() || metadata.is_file()) => metadata,
            _ => return fail("This path is unavailable or is a symbolic link. Choose its original location."),
        };
        let path = canonical(&requested)?;
        if !permitted(&path) {
            return fail("This path contains private or system data.");
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()).map(str::to_string) else {
            return fail("Choose a file or folder.");
        };
        if path.to_str().is_none() {
            return fail("Choose a file or folder.");
        }
        let grant = FileGrant {
            id: uuid::Uuid::new_v4().to_string(),
            path,
            name,
            directory: metadata.is_dir(),
            expires_at: now_ms() + GRANT_TTL_MS,
        };
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).insert(grant.id.clone(), grant.clone());
        Ok(grant)
    }

    pub fn get(&self, id: &str) -> FileResult<FileGrant> {
        let grant = {
            let mut grants = self.grants.lock().unwrap_or_else(|e| e.into_inner());
            Self::sweep(&mut grants);
            grants.get(id).cloned()
        };
        let Some(grant) = grant else { return fail(CHANGED) };
        if canonical(&grant.path).ok().as_deref() != Some(grant.path.as_path()) {
            return fail(CHANGED);
        }
        if fs::symlink_metadata(&grant.path)?.file_type().is_symlink() {
            return fail(CHANGED);
        }
        Ok(grant)
    }

    /// Where a change writes, confined to the grant and refusing any parent
    /// that is (or became) a symbolic link.
    pub fn destination(&self, grant: &FileGrant, relative: &str) -> FileResult<PathBuf> {
        let root = if grant.directory {
            grant.path.clone()
        } else {
            grant.path.parent().map(Path::to_path_buf).ok_or(FileError::Access)?
        };
        if !grant.directory && relative.contains('/') {
            return fail("Choose a folder to create nested destinations.");
        }
        let relative = safe_relative(Some(&Value::String(relative.to_string())))?;
        let target = util::join_relative(&root, &relative);
        if !permitted(&target) {
            return fail("This destination is protected.");
        }
        let mut parent = target.parent().map(Path::to_path_buf);
        while let Some(current) = parent {
            if current == root {
                break;
            }
            if let Ok(metadata) = fs::symlink_metadata(&current)
                && (!metadata.is_dir() || metadata.file_type().is_symlink() || canonical(&current)? != current)
            {
                return fail("A destination folder changed or is a symbolic link.");
            }
            parent = current.parent().map(Path::to_path_buf);
        }
        self.get(&grant.id)?;
        Ok(target)
    }

    /// Bounded walk of the granted paths: at most 8,000 visits, 2,500 files
    /// and eight directory levels. Symbolic links and private segments are
    /// skipped.
    pub fn inventory(&self, ids: &[String]) -> FileResult<Inventory> {
        let mut walk = Walk { entries: Vec::new(), seen: std::collections::HashSet::new(), visited: 0, limited: false };
        for id in ids {
            let selected = self.get(id)?;
            walk.visit(&selected, &selected.path, 0)?;
        }
        Ok(Inventory { entries: walk.entries, limited: walk.limited })
    }

    /// Fail unless `entry` is still the exact file that was scanned.
    pub fn verify(&self, entry: &FileEntry) -> FileResult<()> {
        let grant = self.get(&entry.grant_id)?;
        if !entry.path.starts_with(&grant.path) {
            return fail("A file is outside the selected path.");
        }
        const STALE: &str = "A file changed after preview. Prepare a fresh plan.";
        let Ok(metadata) = fs::symlink_metadata(&entry.path) else { return fail(STALE) };
        if !metadata.is_file() || metadata.file_type().is_symlink() || canonical(&entry.path)? != entry.path {
            return fail(STALE);
        }
        let (device, inode) = identity(&entry.path, &metadata)?;
        if metadata.len() != entry.size || mtime_ms(&metadata) != entry.modified || device != entry.device || inode != entry.inode {
            return fail(STALE);
        }
        Ok(())
    }
}

struct Walk {
    entries: Vec<FileEntry>,
    seen: std::collections::HashSet<PathBuf>,
    visited: usize,
    limited: bool,
}

impl Walk {
    fn visit(&mut self, selected: &FileGrant, target: &Path, depth: usize) -> FileResult<()> {
        self.visited += 1;
        if self.visited > MAX_VISITED || self.entries.len() >= MAX_ENTRIES {
            self.limited = true;
            return Ok(());
        }
        if !permitted(target) {
            return Ok(());
        }
        let Ok(metadata) = fs::symlink_metadata(target) else { return Ok(()) };
        if metadata.file_type().is_symlink() {
            return Ok(());
        }
        if metadata.is_dir() {
            if depth >= MAX_DEPTH {
                self.limited = true;
                return Ok(());
            }
            let mut names: Vec<String> = fs::read_dir(target)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        // Names that are not valid UTF-8 cannot round-trip
                        // through the JSON plan, so they are left alone.
                        .filter_map(|entry| entry.file_name().into_string().ok())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            for name in names {
                if self.entries.len() >= MAX_ENTRIES || self.visited > MAX_VISITED {
                    self.limited = true;
                    break;
                }
                self.visit(selected, &target.join(name), depth + 1)?;
            }
        } else if metadata.is_file() && !self.seen.contains(target) {
            self.seen.insert(target.to_path_buf());
            let relative = if selected.directory {
                names(target.strip_prefix(&selected.path).unwrap_or(target)).join("/")
            } else {
                selected.name.clone()
            };
            let (device, inode) = identity(target, &metadata)?;
            self.entries.push(FileEntry {
                id: uuid::Uuid::new_v4().to_string(),
                grant_id: selected.id.clone(),
                relative,
                path: target.to_path_buf(),
                size: metadata.len(),
                modified: mtime_ms(&metadata),
                device,
                inode,
                excerpt: None,
                pages: None,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn private_segments_and_system_locations_are_refused() {
        for denied in [".ssh", ".env.local", "Keychains", "id.pem", "Login Data", "credentials.json", ".habibi"] {
            assert!(denied_part(denied), "{denied}");
        }
        assert!(!denied_part("notes.txt"));
        let home = std::env::temp_dir();
        assert!(permitted(&home.join("Documents/report.pdf")));
        assert!(!permitted(&home.join("project/.git/config")));
        #[cfg(target_os = "macos")]
        {
            assert!(!permitted(Path::new("/System/Library")));
            assert!(!permitted(Path::new("/private/etc/hosts")));
            assert!(permitted(Path::new("/Users/someone/Library/Mobile Documents")));
        }
        #[cfg(windows)]
        {
            assert!(!permitted(Path::new(r"C:\Windows\System32")));
            assert!(!permitted(Path::new(r"C:\Users\a\AppData\Roaming\Microsoft\Credentials\x")));
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(!permitted(Path::new("/etc/passwd")));
            assert!(!permitted(Path::new("/home/a/.local/share/keyrings/login.keyring")));
        }
    }

    #[test]
    fn relative_names_cannot_escape_or_name_private_folders() {
        assert_eq!(safe_relative(Some(&json!("2026/receipt.pdf"))).unwrap(), "2026/receipt.pdf");
        for bad in [json!("../escape.txt"), json!("/abs.txt"), json!("a//b"), json!("a\\b"), json!(".ssh/key"), json!(""), json!(5), json!("C:/x")] {
            assert!(safe_relative(Some(&bad)).is_err(), "{bad}");
        }
        assert!(safe_relative(None).is_err());
    }
}
