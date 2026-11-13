//! Small JavaScript-compatible helpers so ported checks behave the same.

use std::fs;
use std::io::Write;
use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;

/// Characters `encodeURIComponent` leaves alone.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// `decodeURIComponent`, which throws on a malformed escape or invalid UTF-8.
pub fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let valid = bytes.get(index + 1..index + 3).is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit));
            if !valid {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    percent_encoding::percent_decode_str(value).decode_utf8().ok().map(|text| text.into_owned())
}

/// JavaScript truthiness for a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` for a value already known to be present.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// The first `limit` characters (JavaScript slices UTF-16 units; characters
/// are the closest safe equivalent).
pub fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

fn private_file_options() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Replace `file` with `contents`, readable only by the user.
pub fn write_private_file(file: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        create_private_dir(dir)?;
    }
    let mut handle = private_file_options().write(true).create(true).truncate(true).open(file)?;
    handle.write_all(contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Append to `file`, creating it readable only by the user.
pub fn append_private_file(file: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        create_private_dir(dir)?;
    }
    private_file_options().append(true).create(true).open(file)?.write_all(contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uri_component_round_trips_like_javascript() {
        assert_eq!(encode_uri_component("gpt-4o mini/a?b=c"), "gpt-4o%20mini%2Fa%3Fb%3Dc");
        assert_eq!(encode_uri_component("it's(ok)*~"), "it's(ok)*~");
        assert_eq!(decode_uri_component("/bus%20tickets").as_deref(), Some("/bus tickets"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%FF"), None);
    }

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(""))));
        assert!(!truthy(Some(&json!(0))));
        assert!(truthy(Some(&json!("x"))));
        assert!(truthy(Some(&json!({}))));
        assert_eq!(js_string(&json!(["a", 1])), "a,1");
    }
}
