//! Filesystem helpers shared by services: lexical path resolution and private
//! (`0o700` directory / `0o600` file) state on Unix.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};

/// `path.resolve(value)`: make `value` absolute against the current directory
/// and remove `.`/`..` lexically, without touching the filesystem.
pub fn resolve(value: &Path) -> PathBuf {
    let absolute = if value.is_absolute() {
        value.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from(std::path::MAIN_SEPARATOR_STR))
            .join(value)
    };
    normalize(&absolute)
}

/// Remove `.` and `..` components lexically. `..` never climbs above the root.
pub fn normalize(value: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in value.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// True when `candidate` starts with `prefix` component-wise. Case-insensitive
/// on Windows, where the filesystem is.
pub fn starts_with(candidate: &Path, prefix: &Path) -> bool {
    if cfg!(target_os = "windows") {
        let lower = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
        lower(candidate).starts_with(lower(prefix))
    } else {
        candidate.starts_with(prefix)
    }
}

/// Create `directory` (and parents) and restrict it to the user on Unix.
pub fn create_private_dir(directory: &Path) -> io::Result<()> {
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Create a new file that must not already exist (`wx`), readable only by the
/// user on Unix.
pub fn create_private_file(file: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file)
}

/// Write `bytes` to `directory/file_name` atomically: a private temporary file
/// in the same directory, optionally fsynced, then renamed over the target.
/// The temporary file is removed on failure.
pub fn write_private_atomic(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
    sync: bool,
) -> io::Result<()> {
    use std::io::Write;
    create_private_dir(directory)?;
    let temporary = directory.join(format!("{}.tmp", unique_name()));
    let result = (|| {
        let mut handle = create_private_file(&temporary)?;
        handle.write_all(bytes)?;
        if sync {
            handle.sync_all()?;
        }
        drop(handle);
        std::fs::rename(&temporary, directory.join(file_name))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn unique_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lexically() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize(Path::new("/../../etc")), PathBuf::from("/etc"));
        assert!(resolve(Path::new("x")).is_absolute());
    }

    #[cfg(unix)]
    #[test]
    fn private_atomic_writes_use_owner_only_modes() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("state");
        write_private_atomic(&directory, "x.json", b"{}", true).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&directory), 0o700);
        assert_eq!(mode(&directory.join("x.json")), 0o600);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    }
}
