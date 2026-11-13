//! Provider-qualified ids and small encoding helpers.
//!
//! Every id the UI sees is `<account>:<local>`, where `<account>` is
//! [`SYSTEM`] for EventKit or the account's UUID, and `<local>` is opaque
//! provider data. Account ids never contain `:`, so the first `:` splits.

use chrono::{DateTime, SecondsFormat, Utc};

/// The account id of the OS calendar store.
pub const SYSTEM: &str = "system";

pub fn qualify(account: &str, local: &str) -> String {
    format!("{account}:{local}")
}

/// `(account, local)`, or `None` when `id` is not qualified.
pub fn split(id: &str) -> Option<(&str, &str)> {
    let (account, local) = id.split_once(':')?;
    let valid_account = !account.is_empty()
        && account.len() <= 64
        && account
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    (valid_account && !local.is_empty()).then_some((account, local))
}

/// Join several components into one local id, escaping `%` and `/`.
pub fn join_parts(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| part.replace('%', "%25").replace('/', "%2F"))
        .collect::<Vec<_>>()
        .join("/")
}

/// Inverse of [`join_parts`]; `None` when the component count differs.
pub fn split_parts(local: &str, count: usize) -> Option<Vec<String>> {
    let parts: Vec<String> = local
        .split('/')
        .map(|part| part.replace("%2F", "/").replace("%25", "%"))
        .collect();
    (parts.len() == count && parts.iter().all(|part| !part.is_empty())).then_some(parts)
}

/// ISO 8601 in UTC without fractional seconds, as Foundation's
/// `ISO8601DateFormatter` produced for the Swift app: `2026-11-12T09:30:00Z`.
pub fn iso(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Parse an RFC 3339 timestamp, with or without fractional seconds.
pub fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

/// Length in UTF-16 code units, matching Swift's `utf16.count` bounds.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Standard base64 with padding (HTTP Basic credentials).
pub fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let value = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(TABLE[((value >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_ids_round_trip_and_reject_garbage() {
        let id = qualify("2f1c-ab", "x:y/z");
        assert_eq!(split(&id), Some(("2f1c-ab", "x:y/z")));
        assert_eq!(split("system:ABC:DEF"), Some(("system", "ABC:DEF")));
        assert_eq!(split("no-colon"), None);
        assert_eq!(split(":x"), None);
        assert_eq!(split("a b:x"), None);
        assert_eq!(split("a:"), None);
    }

    #[test]
    fn parts_escape_separators() {
        let local = join_parts(&["en.usa#holiday@group.v.calendar.google.com", "a/b%c"]);
        assert_eq!(
            split_parts(&local, 2).unwrap(),
            vec![
                "en.usa#holiday@group.v.calendar.google.com".to_string(),
                "a/b%c".to_string()
            ]
        );
        assert_eq!(split_parts(&local, 3), None);
    }

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(b"user:pass word"), "dXNlcjpwYXNzIHdvcmQ=");
    }

    #[test]
    fn iso_formats_like_foundation() {
        let date = parse_iso("2026-11-12T10:30:00.250+01:00").unwrap();
        assert_eq!(iso(date), "2026-11-12T09:30:00Z");
        assert_eq!(utf16_len("a😀"), 3);
    }
}
