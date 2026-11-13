//! Small helpers that reproduce JavaScript semantics the Node host relied on.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::Value;

/// `value.length` for a JS string (UTF-16 code units).
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, max)` in UTF-16 units, never splitting a character.
pub fn utf16_slice(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, c) in value.char_indices() {
        units += c.len_utf16();
        if units > max {
            return value[..index].to_string();
        }
        end = index + c.len_utf8();
    }
    value[..end].to_string()
}

/// `Number(value)` for JSON values.
pub fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Null => 0.0,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16)
                    .map(|n| n as f64)
                    .unwrap_or(f64::NAN)
            } else {
                text.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(items) if items.is_empty() => 0.0,
        Value::Array(items) if items.len() == 1 => js_number(&items[0]),
        _ => f64::NAN,
    }
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `stat.mtime.toISOString()`.
pub fn iso_from_system_time(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.parse(value)` for the date formats Habibi writes and reads: RFC 3339
/// timestamps, `YYYY-MM-DD` (UTC) and `YYYY-MM-DDTHH:MM[:SS]` (local time).
pub fn js_date_parse(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(local) = NaiveDateTime::parse_from_str(value, format) {
            return local_ms(local);
        }
    }
    None
}

/// A local wall-clock time as epoch milliseconds (`new Date('YYYY-MM-DDTHH:MM')`).
pub fn local_ms(local: NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|date| date.timestamp_millis())
}

/// An approximation of `String.prototype.localeCompare` for sorting names:
/// case-insensitive, lowercase first on ties.
pub fn locale_cmp(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| right.cmp(left))
}

/// `homePath` from server.js: the caller-supplied path when it names an
/// existing file or directory inside (or equal to) the user's home, so callers
/// cannot reach the rest of the filesystem.
pub fn home_path(home: &Path, value: Option<&Value>) -> Option<PathBuf> {
    let Some(Value::String(value)) = value else {
        return None;
    };
    if value.is_empty() || value.contains('\0') {
        return None;
    }
    let home = habibi_platform::fsutil::resolve(home);
    let target = habibi_platform::fsutil::resolve(Path::new(value));
    if target != home && !habibi_platform::fsutil::starts_with(&target, &home) {
        return None;
    }
    target.exists().then_some(target)
}

/// Strictly inside home (not home itself), existing and not a directory.
pub fn home_file(home: &Path, value: &str) -> Option<PathBuf> {
    if value.contains('\0') {
        return None;
    }
    let home = habibi_platform::fsutil::resolve(home);
    let target = habibi_platform::fsutil::resolve(Path::new(value));
    if target == home || !habibi_platform::fsutil::starts_with(&target, &home) {
        return None;
    }
    let metadata = std::fs::metadata(&target).ok()?;
    (!metadata.is_dir()).then_some(target)
}

/// Node's `path.extname`: the last `.suffix` of the base name, ignoring a
/// leading dot.
pub fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(0) | None => "",
        Some(index) => &name[index..],
    }
}

/// The file name of `path` as text.
pub fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `Buffer.from(text).toString('base64url')` (no padding).
pub fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..=chunk.len() {
            out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// Collapse runs of whitespace to one space (`replace(/\s+/g, ' ')`).
pub fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_semantics() {
        assert_eq!(utf16_slice("ab😀c", 3), "ab");
        assert_eq!(utf16_slice("abc", 10), "abc");
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(js_number(&json!("12")), 12.0);
        assert_eq!(js_number(&json!(true)), 1.0);
        assert!(js_number(&json!({})).is_nan());
        assert!(js_number(&json!("x")).is_nan());
        assert_eq!(extname("a.tar.gz"), ".gz");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(
            base64url(b"/Applications/A.app"),
            "L0FwcGxpY2F0aW9ucy9BLmFwcA"
        );
        assert!(js_date_parse("2026-11-12T10:00:00.000Z").is_some());
        assert!(js_date_parse("nope").is_none());
        assert_eq!(collapse_whitespace(" a \n\t b "), " a b ");
    }

    #[test]
    fn home_paths_stay_inside_home() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let path = |value: &str| home_path(home.path(), Some(&json!(value)));
        assert_eq!(path(&file.to_string_lossy()), Some(file.clone()));
        assert!(path(&home.path().to_string_lossy()).is_some());
        assert!(path("/etc/hosts").is_none());
        assert!(path(&format!("{}/../outside", home.path().display())).is_none());
        assert!(path(&format!("{}/missing", home.path().display())).is_none());
        assert!(home_path(home.path(), Some(&json!(5))).is_none());
        assert!(home_file(home.path(), &home.path().to_string_lossy()).is_none());
        assert!(home_file(home.path(), &file.to_string_lossy()).is_some());
    }
}
