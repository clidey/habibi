//! Small helpers that reproduce the JavaScript semantics the Node service
//! relied on, plus the filesystem primitives shared by every module.

use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// JavaScript truthiness for a JSON value (`if (value)`).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number.isInteger(value)`: a JSON number with no fractional part.
pub(crate) fn js_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() < 9.0e15).then_some(number as i64)
}

/// `Number(value)` for the inputs a model plan can contain.
pub(crate) fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
        }
        _ => f64::NAN,
    }
}

/// JavaScript `.length` (UTF-16 code units).
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, limit)` counted in UTF-16 code units, never splitting a
/// character.
pub(crate) fn js_slice(text: &str, limit: usize) -> String {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > limit {
            return text[..index].to_string();
        }
    }
    text.to_string()
}

/// Swift `String.prefix(n)` (approximated by Unicode scalars).
pub(crate) fn prefix_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Node's `path.extname` on the last segment: `.txt`, or empty for
/// `.bashrc` and names without a dot.
pub(crate) fn extname(name: &str) -> String {
    let base = name.rsplit(['/', std::path::MAIN_SEPARATOR]).next().unwrap_or(name);
    match base.rfind('.') {
        Some(index) if index > 0 && !base[..index].chars().all(|c| c == '.') => base[index..].to_string(),
        _ => String::new(),
    }
}

pub(crate) fn path_extname(path: &Path) -> String {
    path.file_name().map(|name| extname(&name.to_string_lossy())).unwrap_or_default()
}

/// `fs.Stats.mtimeMs`.
pub(crate) fn mtime_ms(metadata: &Metadata) -> f64 {
    match metadata.modified() {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(since) => since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6,
            Err(before) => {
                let before = before.duration();
                -(before.as_secs() as f64 * 1000.0 + f64::from(before.subsec_nanos()) / 1e6)
            }
        },
        Err(_) => 0.0,
    }
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_time(ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(ms.trunc() as i64)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `fs.realpath`. On Windows the `\\?\` prefix `canonicalize` adds is removed
/// so results compare equal to the ordinary paths the rest of the code uses.
pub(crate) fn canonical(path: &Path) -> io::Result<PathBuf> {
    let resolved = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && rest.as_bytes().get(1) == Some(&b':')
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(resolved)
}

/// Lexical `path.resolve` for an absolute path: removes `.` and `..`.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if out.parent().is_some() {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Join a `/`-separated relative name one segment at a time so Windows gets
/// native separators.
pub(crate) fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut target = root.to_path_buf();
    for part in relative.split('/') {
        target.push(part);
    }
    target
}

/// `(stat.dev, stat.ino)`: the identity used to detect a substituted file.
#[cfg(unix)]
pub(crate) fn identity(_path: &Path, metadata: &Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

/// Volume serial and file index, which is what Node reports as `dev`/`ino`.
#[cfg(windows)]
pub(crate) fn identity(path: &Path, _metadata: &Metadata) -> io::Result<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        GetFileInformationByHandle,
    };
    // Attribute-only handle; never follows a reparse point and never blocks
    // other readers, writers or deleters.
    let file = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(0x7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| io::Error::other("file identity unavailable"))?;
    Ok((
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

/// `mkdir -p` + `chmod 0700`.
pub(crate) fn private_directory(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    set_mode(directory, 0o700)
}

#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// Windows has no POSIX modes; the state directory is already per-user.
#[cfg(not(unix))]
pub(crate) fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

/// Create `path` exclusively (`flag: 'wx'`) with `0o600` and write `data`.
pub(crate) fn write_new(path: &Path, data: &[u8], private: bool) -> io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()
}

/// Open for reading without following a final symbolic link (`O_NOFOLLOW`).
pub(crate) fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x0100);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0o400000);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    options.open(path)
}

pub(crate) fn exists_no_follow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn javascript_coercions() {
        assert!(truthy(Some(&json!(1))) && !truthy(Some(&json!(""))) && !truthy(None));
        assert_eq!(js_integer(&json!(1600.0)), Some(1600));
        assert_eq!(js_integer(&json!(1.5)), None);
        assert_eq!(js_number(&json!("90")), 90.0);
        assert_eq!(js_slice("a😀b", 2), "a");
        assert_eq!(extname("a/b.TXT"), ".TXT");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("name"), "");
        assert_eq!(iso_time(0.5), "1970-01-01T00:00:00.000Z");
    }
}
