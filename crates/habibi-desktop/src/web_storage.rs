//! The Swift app's browser settings (theme, colour mode, Home layout, WhoDB
//! instance, emoji recents, …) lived in WKWebView `localStorage` for the
//! origin `http://127.0.0.1:4173`. The Rust shell serves the UI from another
//! origin, so on first launch the shell reads those keys and seeds the new
//! origin's storage before the page's scripts run.
//!
//! WebKit (macOS 13+) keeps per-origin data under
//! `~/Library/WebKit/<bundle id>/WebsiteData/Default/<salted hash>/<salted hash>/`
//! with an `origin` file naming the top and frame origins and
//! `LocalStorage/localstorage.sqlite3` holding
//! `ItemTable(key TEXT, value BLOB)` with UTF-16LE values. Older WebKit used
//! `WebsiteData/LocalStorage/http_127.0.0.1_4173.localstorage` with the same
//! table. Both are read from a private copy so WebKit's files are never
//! opened for writing. Everything is best effort: any surprise means no import.

use std::path::Path;

/// The Swift app's UI origin.
pub const LEGACY_SCHEME: &str = "http";
pub const LEGACY_HOST: &str = "127.0.0.1";
pub const LEGACY_PORT: u16 = 4173;

/// Keys the UI owns: its own `habibi.` keys and the `@clidey/ux/` theme and
/// palette. Anything else in the old origin is left behind.
const PREFIXES: [&str; 2] = ["habibi.", "@clidey/ux/"];
const MAX_ITEMS: usize = 500;
const MAX_KEY_UTF16: usize = 256;
const MAX_VALUE_UTF16: usize = 1 << 20;
const MAX_TOTAL_UTF16: usize = 4 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
}

impl Origin {
    fn is_legacy(&self) -> bool {
        self.scheme == LEGACY_SCHEME && self.host == LEGACY_HOST && self.port == Some(LEGACY_PORT)
    }
}

/// WebKit's serialized `String`: u32 LE length, a 1-byte "is 8-bit" flag,
/// then Latin-1 bytes or UTF-16LE units.
fn read_string(bytes: &[u8], at: &mut usize) -> Option<String> {
    let length = u32::from_le_bytes(bytes.get(*at..*at + 4)?.try_into().ok()?) as usize;
    *at += 4;
    if length > 4096 {
        return None;
    }
    let eight_bit = *bytes.get(*at)?;
    *at += 1;
    match eight_bit {
        1 => {
            let raw = bytes.get(*at..*at + length)?;
            *at += length;
            Some(raw.iter().map(|&byte| byte as char).collect())
        }
        0 => {
            let raw = bytes.get(*at..*at + length * 2)?;
            *at += length * 2;
            decode_utf16le(raw)
        }
        _ => None,
    }
}

fn read_origin(bytes: &[u8], at: &mut usize) -> Option<Origin> {
    let scheme = read_string(bytes, at)?;
    let host = read_string(bytes, at)?;
    let has_port = *bytes.get(*at)?;
    *at += 1;
    let port = match has_port {
        0 => None,
        1 => {
            let port = u16::from_le_bytes(bytes.get(*at..*at + 2)?.try_into().ok()?);
            *at += 2;
            Some(port)
        }
        _ => return None,
    };
    Some(Origin { scheme, host, port })
}

/// Parse an `origin` file into (top origin, frame origin).
pub fn parse_origin_file(bytes: &[u8]) -> Option<(Origin, Origin)> {
    let mut at = 0;
    let top = read_origin(bytes, &mut at)?;
    let frame = read_origin(bytes, &mut at)?;
    Some((top, frame))
}

/// True when an `origin` file names the Swift app's origin as both top and frame.
pub fn is_legacy_origin_file(bytes: &[u8]) -> bool {
    parse_origin_file(bytes).is_some_and(|(top, frame)| top.is_legacy() && frame.is_legacy())
}

pub fn decode_utf16le(bytes: &[u8]) -> Option<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16(&units).ok()
}

/// Keep only the UI's own keys, within size limits, in a stable order.
pub fn importable(entries: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut entries = entries;
    entries.sort();
    for (key, value) in entries {
        let key_units = key.encode_utf16().count();
        let value_units = value.encode_utf16().count();
        if !PREFIXES.iter().any(|prefix| key.starts_with(prefix))
            || key_units > MAX_KEY_UTF16
            || value_units > MAX_VALUE_UTF16
            || key.chars().any(char::is_control)
        {
            continue;
        }
        if kept.len() == MAX_ITEMS || total + key_units + value_units > MAX_TOTAL_UTF16 {
            break;
        }
        total += key_units + value_units;
        kept.push((key, value));
    }
    kept
}

/// The legacy origin's `localStorage` from a `WebsiteData` directory, already
/// filtered by [`importable`]. Empty when missing or unreadable.
pub fn read_legacy(website_data: &Path) -> Vec<(String, String)> {
    #[cfg(target_os = "macos")]
    {
        importable(sqlite::read(website_data).unwrap_or_default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = website_data;
        Vec::new()
    }
}

/// The JS that seeds `localStorage` with `entries` when the origin's storage
/// is still empty. Runs before the page's own scripts.
pub fn seed_script(entries: &[(String, String)]) -> String {
    let payload = serde_json::to_string(entries).unwrap_or_else(|_| "[]".into());
    format!(
        "(() => {{ try {{ const entries = {payload}; if (!entries.length || window.localStorage.length) return; \
         for (const [key, value] of entries) window.localStorage.setItem(key, value); }} catch (_) {{}} }})();"
    )
}

#[cfg(target_os = "macos")]
mod sqlite {
    //! Just enough of the system `libsqlite3` to read `ItemTable`.

    use std::ffi::{CStr, CString, c_char, c_int, c_void};
    use std::path::{Path, PathBuf};

    #[link(name = "sqlite3")]
    unsafe extern "C" {
        fn sqlite3_open_v2(filename: *const c_char, db: *mut *mut c_void, flags: c_int, vfs: *const c_char) -> c_int;
        fn sqlite3_close(db: *mut c_void) -> c_int;
        fn sqlite3_prepare_v2(
            db: *mut c_void,
            sql: *const c_char,
            bytes: c_int,
            statement: *mut *mut c_void,
            tail: *mut *const c_char,
        ) -> c_int;
        fn sqlite3_step(statement: *mut c_void) -> c_int;
        fn sqlite3_finalize(statement: *mut c_void) -> c_int;
        fn sqlite3_column_text(statement: *mut c_void, column: c_int) -> *const u8;
        fn sqlite3_column_blob(statement: *mut c_void, column: c_int) -> *const c_void;
        fn sqlite3_column_bytes(statement: *mut c_void, column: c_int) -> c_int;
    }

    const OK: c_int = 0;
    const ROW: c_int = 100;
    const OPEN_READWRITE: c_int = 0x2;

    /// A private copy of the database (with its WAL) in a fresh temp dir.
    struct Copy(PathBuf);

    impl Drop for Copy {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn copy(database: &Path) -> Option<(Copy, PathBuf)> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        let directory = std::env::temp_dir().join(format!("habibi-legacy-storage-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&directory).ok()?;
        let guard = Copy(directory.clone());
        let name = database.file_name()?;
        let target = directory.join(name);
        if std::fs::metadata(database).ok()?.len() > 64 << 20 {
            return None;
        }
        std::fs::copy(database, &target).ok()?;
        for suffix in ["-wal", "-shm"] {
            let mut side = database.as_os_str().to_owned();
            side.push(suffix);
            let mut side_target = target.as_os_str().to_owned();
            side_target.push(suffix);
            if Path::new(&side).exists() {
                std::fs::copy(&side, &side_target).ok()?;
            }
        }
        Some((guard, target))
    }

    fn query(database: &Path) -> Option<Vec<(String, String)>> {
        let (_guard, path) = copy(database)?;
        let name = CString::new(path.to_str()?).ok()?;
        let mut rows = Vec::new();
        // SAFETY: standard sqlite3 C API use on a private copy: every handle
        // is checked, the statement is finalized and the database closed.
        unsafe {
            let mut db = std::ptr::null_mut();
            if sqlite3_open_v2(name.as_ptr(), &mut db, OPEN_READWRITE, std::ptr::null()) != OK {
                sqlite3_close(db);
                return None;
            }
            let sql = c"SELECT key, value FROM ItemTable";
            let mut statement = std::ptr::null_mut();
            if sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut statement, std::ptr::null_mut()) != OK {
                sqlite3_close(db);
                return None;
            }
            while rows.len() < 10_000 && sqlite3_step(statement) == ROW {
                let key = sqlite3_column_text(statement, 0);
                let value = sqlite3_column_blob(statement, 1);
                let length = sqlite3_column_bytes(statement, 1);
                if key.is_null() || value.is_null() || length < 0 {
                    continue;
                }
                let Ok(key) = CStr::from_ptr(key.cast()).to_str() else { continue };
                let bytes = std::slice::from_raw_parts(value.cast::<u8>(), length as usize);
                if let Some(value) = super::decode_utf16le(bytes) {
                    rows.push((key.to_string(), value));
                }
            }
            sqlite3_finalize(statement);
            sqlite3_close(db);
        }
        Some(rows)
    }

    fn origin_directories(website_data: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let Ok(tops) = std::fs::read_dir(website_data.join("Default")) else { return found };
        for top in tops.flatten().take(1000) {
            let Ok(frames) = std::fs::read_dir(top.path()) else { continue };
            for frame in frames.flatten().take(1000) {
                let directory = frame.path();
                let Ok(bytes) = std::fs::read(directory.join("origin")) else { continue };
                if bytes.len() <= 16_384 && super::is_legacy_origin_file(&bytes) {
                    found.push(directory);
                }
            }
        }
        found
    }

    pub fn read(website_data: &Path) -> Option<Vec<(String, String)>> {
        for directory in origin_directories(website_data) {
            let database = directory.join("LocalStorage/localstorage.sqlite3");
            if database.is_file()
                && let Some(rows) = query(&database)
                && !rows.is_empty()
            {
                return Some(rows);
            }
        }
        let old = website_data.join(format!(
            "LocalStorage/{}_{}_{}.localstorage",
            super::LEGACY_SCHEME,
            super::LEGACY_HOST,
            super::LEGACY_PORT
        ));
        if old.is_file() { query(&old) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `origin` file the Swift app's WebKit wrote (macOS 26).
    const LEGACY_ORIGIN: [u8; 52] = [
        0x04, 0, 0, 0, 0x01, b'h', b't', b't', b'p', 0x09, 0, 0, 0, 0x01, b'1', b'2', b'7', b'.', b'0', b'.', b'0', b'.',
        b'1', 0x01, 0x4d, 0x10, 0x04, 0, 0, 0, 0x01, b'h', b't', b't', b'p', 0x09, 0, 0, 0, 0x01, b'1', b'2', b'7', b'.',
        b'0', b'.', b'0', b'.', b'1', 0x01, 0x4d, 0x10,
    ];

    #[test]
    fn recognizes_the_swift_origin_file() {
        let (top, frame) = parse_origin_file(&LEGACY_ORIGIN).unwrap();
        assert_eq!(top, Origin { scheme: "http".into(), host: "127.0.0.1".into(), port: Some(4173) });
        assert_eq!(top, frame);
        assert!(is_legacy_origin_file(&LEGACY_ORIGIN));
        let mut other = LEGACY_ORIGIN;
        other[24] = 0x4e; // port 4174
        assert!(!is_legacy_origin_file(&other));
        assert!(!is_legacy_origin_file(&LEGACY_ORIGIN[..30]), "truncated");
        assert!(parse_origin_file(&[0xff, 0xff, 0xff, 0xff, 1]).is_none());
    }

    #[test]
    fn decodes_utf16_values() {
        let bytes: Vec<u8> = "deep-ocean ☀".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_utf16le(&bytes).as_deref(), Some("deep-ocean ☀"));
        assert_eq!(decode_utf16le(&[0x41]), None);
        assert_eq!(decode_utf16le(&[0x00, 0xd8]), None, "lone surrogate");
    }

    #[test]
    fn imports_only_the_ui_keys() {
        let entries = vec![
            ("habibi.theme".to_string(), "deep-ocean".to_string()),
            ("@clidey/ux/theme".to_string(), "dark".to_string()),
            ("someone-else".to_string(), "x".to_string()),
            ("habibi.\u{7}".to_string(), "x".to_string()),
            ("habibi.huge".to_string(), "a".repeat(MAX_VALUE_UTF16 + 1)),
        ];
        let kept = importable(entries);
        assert_eq!(
            kept,
            [("@clidey/ux/theme".to_string(), "dark".to_string()), ("habibi.theme".to_string(), "deep-ocean".to_string())]
        );
    }

    #[test]
    fn seed_script_is_inert_json() {
        let script = seed_script(&[("habibi.x".into(), "</script>\u{2028}\"'`${}".into())]);
        assert!(script.contains(r#"[["habibi.x","</script>"#));
        assert!(script.contains("window.localStorage.length"));
    }
}
