//! JavaScript-compatible helpers. The Node services leaned on `||`, `Number()`
//! and template-literal coercion; these reproduce the cases the ported code
//! relies on so the JSON the UI receives stays the same.

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Number, Value};

/// JavaScript truthiness.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a || b` over JSON values.
pub fn or<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    match value {
        Some(value) if truthy(Some(value)) => value,
        _ => fallback,
    }
}

/// `Number(value)`.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
        }
        Some(Value::Array(items)) if items.is_empty() => 0.0,
        Some(Value::Array(items)) if items.len() == 1 => number(items.first()),
        Some(_) => f64::NAN,
    }
}

/// A JSON number the way `JSON.stringify` writes it (`NaN` becomes `null`).
pub fn number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `${value}` in a template literal.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 9.0e15 => (float as i64).to_string(),
            _ => number.to_string(),
        },
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value || '')`.
pub fn string_or_empty(value: Option<&Value>) -> String {
    if truthy(value) { value.map(js_string).unwrap_or_default() } else { String::new() }
}

/// `typeof value === 'string' ? value.slice(0, max) : ''`.
pub fn bounded(value: Option<&Value>, max: usize) -> String {
    match value {
        Some(Value::String(text)) => take(text, max),
        _ => String::new(),
    }
}

/// The first `max` characters.
pub fn take(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The last `max` characters (`text.slice(-max)`).
pub fn take_last(text: &str, max: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

/// The value as an object, or an empty one.
pub fn record(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// The value as an array slice, or an empty one.
pub fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Unpadded base64url, as Node's `toString('base64url')`.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..symbols {
            out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

/// `randomBytes(n).toString('base64url')`.
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::fill(&mut buffer).is_err() {
        // The OS generator is unavailable only on a broken system; uuid's v4
        // generator is a second, independent source rather than a weak one.
        for chunk in buffer.chunks_mut(16) {
            let random = uuid::Uuid::new_v4();
            chunk.copy_from_slice(&random.as_bytes()[..chunk.len()]);
        }
    }
    base64url(&buffer)
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let millis = now_ms() as i64;
    let (seconds, ms) = (millis.div_euclid(1000), millis.rem_euclid(1000));
    let (days, secs) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Create `directory` (and parents) readable only by this user on Unix.
pub fn create_private_dir(directory: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)
}

fn private_options() -> std::fs::OpenOptions {
    #[allow(unused_mut)]
    let mut options = std::fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Replace `path` with `bytes`, creating it `0o600` on Unix.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = private_options().write(true).create(true).truncate(true).open(path)?;
    file.write_all(bytes)
}

/// Append to `path`, creating it `0o600` on Unix.
pub fn append_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = private_options().append(true).create(true).open(path)?;
    file.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coercions_match_javascript() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!([]))));
        assert_eq!(number(Some(&json!("3"))), 3.0);
        assert!(number(Some(&json!("x"))).is_nan());
        assert_eq!(number_value(f64::NAN), Value::Null);
        assert_eq!(number_value(3.0), json!(3));
        assert_eq!(js_string(&json!(3)), "3");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(encode_component("a b,c/é"), "a%20b%2Cc%2F%C3%A9");
        assert_eq!(take_last("abcdef", 2), "ef");
    }

    #[test]
    fn base64url_matches_node() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(random_token(32).len(), 43);
    }

    #[test]
    fn iso_dates_are_well_formed() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        let now = iso_now();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
    }
}
