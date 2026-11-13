//! The handful of JavaScript coercions the Node routes relied on
//! (`String(x || '')`, `Number(x) || 4`, truthiness, `encodeURIComponent`),
//! so request bodies are interpreted exactly as before.

use serde_json::Value;

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn number_string(number: f64) -> String {
    if number.is_finite() && number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        number.to_string()
    }
}

/// `String(value)`.
pub fn string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.as_f64().map(number_string).unwrap_or_else(|| number.to_string()),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value || '')`.
pub fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(Some(value)) => string(value),
        _ => String::new(),
    }
}

/// `Number(value)` for a query-string value (`null` when absent is 0).
pub fn number_from_text(value: Option<&str>) -> f64 {
    let Some(text) = value else { return 0.0 };
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for a JSON value.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => number_from_text(Some(text)),
        Some(_) => f64::NAN,
    }
}

/// `value.length` of a JavaScript string (UTF-16 code units).
pub fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The first `count` characters (`slice(0, count)` without splitting a
/// surrogate pair).
pub fn prefix(value: &str, count: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for character in value.chars() {
        units += character.len_utf16();
        if units > count {
            break;
        }
        out.push(character);
    }
    out
}

/// `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coercions_match_javascript() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("0"))));
        assert_eq!(string_or_empty(Some(&json!(0))), "");
        assert_eq!(string_or_empty(Some(&json!(12))), "12");
        assert_eq!(string_or_empty(Some(&json!({}))), "[object Object]");
        assert_eq!(string(&json!(1.5)), "1.5");
        assert!(number_from_text(Some("abc")).is_nan());
        assert_eq!(number_from_text(None), 0.0);
        assert_eq!(number(Some(&json!("993"))), 993.0);
        assert_eq!(encode_uri_component("subject:\"a b\"/é"), "subject%3A%22a%20b%22%2F%C3%A9");
        assert_eq!(prefix("ab😀c", 3), "ab");
        assert_eq!(length("😀"), 2);
    }
}
