//! Browser destinations only; never hand file paths, credentials, or custom
//! schemes to the OS opener. Ported from `src/core/browser-url.ts`.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use url::Url;

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// An `http(s)` URL without embedded credentials, whitespace, control
/// characters or backslashes, normalized (`href`); else `None`.
pub fn browser_url(value: &str) -> Option<String> {
    if crate::util::utf16_len(value) > 4096
        || value
            .chars()
            .any(|c| c.is_whitespace() || c == '\u{feff}' || c.is_control() || c == '\\')
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

/// [`browser_url`] for an untrusted JSON value (non-strings are refused).
pub fn browser_url_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => browser_url(text),
        _ => None,
    }
}

/// A typed website command (`open clidey.com`, `https://…`) as a URL.
pub fn browser_command(command: &str) -> Option<String> {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    static SCHEME: OnceLock<Regex> = OnceLock::new();
    static DOMAIN: OnceLock<Regex> = OnceLock::new();
    static DOCUMENT: OnceLock<Regex> = OnceLock::new();
    let trimmed = command.trim();
    let value =
        regex(&PREFIX, r"(?i)^(?:open|visit|go\s+to|browse(?:\s+to)?)\s+").replace(trimmed, "");
    if regex(&SCHEME, r"(?i)^https?://").is_match(&value) {
        return browser_url(&value);
    }
    // A bare domain is a destination; common document suffixes remain local-file searches.
    if !regex(
        &DOMAIN,
        r"^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,63}(?::\d{1,5})?(?:[/?#]|$)",
    )
    .is_match(&value)
    {
        return None;
    }
    if regex(
        &DOCUMENT,
        r"(?i)\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|js|ts|png|jpe?g|zip)$",
    )
    .is_match(&value)
    {
        return None;
    }
    browser_url(&format!("https://{value}"))
}

fn strip_wrapping(value: &str) -> String {
    static WRAP: OnceLock<Regex> = OnceLock::new();
    regex(&WRAP, r#"^["'(\[]+|["')\],.!]+$"#)
        .replace_all(value, "")
        .into_owned()
}

fn words(source: &str) -> impl Iterator<Item = &str> {
    std::iter::once(source).chain(source.split(|c: char| c.is_whitespace()))
}

/// A model-routed website action may only open a destination the user typed
/// (or, with `allow_named_website`, a public homepage when the user asked to
/// open a site by name).
pub fn requested_browser_url(
    request: &str,
    destination: Option<&Value>,
    allow_named_website: bool,
) -> Option<String> {
    static VERB: OnceLock<Regex> = OnceLock::new();
    static LOCAL_TLD: OnceLock<Regex> = OnceLock::new();
    static IPV4: OnceLock<Regex> = OnceLock::new();
    let url = browser_url_value(destination);
    let supplied: HashSet<String> = words(request)
        .flat_map(|value| {
            [
                browser_command(value),
                browser_command(&strip_wrapping(value)),
            ]
        })
        .flatten()
        .collect();
    if let Some(url) = &url
        && supplied.contains(url)
    {
        return Some(url.clone());
    }
    let url = url?;
    if !supplied.is_empty()
        || !allow_named_website
        || !regex(
            &VERB,
            r"(?i)\b(?:open|visit|browse|navigate|go\s+to|take\s+me\s+to)\b",
        )
        .is_match(request)
    {
        return None;
    }
    let site = Url::parse(&url).ok()?;
    let host = site.host_str().unwrap_or("");
    let public_homepage = site.scheme() == "https"
        && site.path() == "/"
        && site.query().is_none_or(str::is_empty)
        && site.fragment().is_none_or(str::is_empty)
        && host.contains('.')
        && !regex(&LOCAL_TLD, r"\.(?:local|localhost|internal|test|invalid)$").is_match(host)
        && !regex(&IPV4, r"^\d+(?:\.\d+){3}$").is_match(host)
        && !host.contains(':');
    public_homepage.then_some(url)
}

/// `decodeURIComponent`, failing on malformed escapes or invalid UTF-8.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn alphanumeric_lower(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// A model may propose a task page only when its site and search terms are
/// grounded in the request.
pub fn requested_website_task_url(request: &str, destination: Option<&Value>) -> Option<String> {
    static TASK: OnceLock<Regex> = OnceLock::new();
    static LOCAL_TLD: OnceLock<Regex> = OnceLock::new();
    static BRAND: OnceLock<Regex> = OnceLock::new();
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    static RELATIVE: OnceLock<Regex> = OnceLock::new();
    static JOURNEY: OnceLock<Regex> = OnceLock::new();
    static QUALIFIER: OnceLock<Regex> = OnceLock::new();
    static TERM: OnceLock<Regex> = OnceLock::new();
    let source = request.trim();
    let url = browser_url_value(destination)?;
    if !regex(
        &TASK,
        r"(?i)\b(?:search|find|book|buy|tickets?|flights?|hotels?|buses?|from\b.+\bto)\b",
    )
    .is_match(source)
    {
        return None;
    }
    // A typed URL or domain must continue through the exact-destination guard above.
    if words(source).any(|part| browser_command(&strip_wrapping(part)).is_some()) {
        return None;
    }
    let candidate = Url::parse(&url).ok()?;
    let host = candidate.host_str().unwrap_or("").to_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    let brand = if labels.len() >= 2 {
        labels[labels.len() - 2]
    } else {
        ""
    };
    let brand_pattern = format!(r"(?i)\b{}\b", regex::escape(brand).replace('-', "[ -]?"));
    if candidate.scheme() != "https"
        || candidate.port().is_some()
        || candidate.fragment().is_some_and(|f| !f.is_empty())
        || labels.len() < 2
        || brand.len() < 4
        || !regex(&BRAND, r"^[a-z][a-z0-9-]+$").is_match(brand)
        || ["co", "com", "org", "net"].contains(&brand)
        || regex(&LOCAL_TLD, r"\.(?:local|localhost|internal|test|invalid)$").is_match(&host)
        || !Regex::new(&brand_pattern).is_ok_and(|pattern| pattern.is_match(source))
        || regex(
            &SENSITIVE,
            r"(?i)\b(?:checkout|payment|pay|purchase|confirm|account|login|delete|admin|api)\b",
        )
        .is_match(candidate.path())
        || (candidate.path() == "/" && candidate.query().is_none_or(str::is_empty))
    {
        return None;
    }
    let search = candidate
        .query()
        .filter(|q| !q.is_empty())
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let route_text = alphanumeric_lower(&decode_uri_component(&format!(
        "{}{}",
        candidate.path(),
        search
    ))?);
    let source_text = alphanumeric_lower(source);
    // Relative travel dates and extra filters cannot be checked against an
    // arbitrary site's private URL format. Search with the full request instead.
    if regex(&RELATIVE, r"(?i)\b(?:today|tomorrow|tonight|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b").is_match(source) {
        return None;
    }
    // The original used a lookahead for the terminator; consuming it is
    // equivalent because only the first match's groups are used.
    let journey = regex(
        &JOURNEY,
        r"(?i)\bfrom\s+([a-z][a-z -]{0,50}?)\s+to\s+([a-z][a-z -]{0,50}?)(?:\s+(?:on|for|today|tomorrow|next|with|via|at)\b|[?.!,]|$)",
    );
    if let Some(captures) = journey.captures(source) {
        let from = alphanumeric_lower(&captures[1]);
        let to = alphanumeric_lower(&captures[2]);
        if !route_text.contains(&from) || !route_text.contains(&to) {
            return None;
        }
    }
    for (_, value) in candidate.query_pairs() {
        let normalized = alphanumeric_lower(&value);
        if !normalized.is_empty() && !source_text.contains(&normalized) {
            return None;
        }
    }
    for captures in regex(
        &QUALIFIER,
        r"(?i)\b(?:for|with)\s+([a-z0-9][a-z0-9 -]{0,80})(?:[?.!,]|$)",
    )
    .captures_iter(source)
    {
        let normalized = alphanumeric_lower(&captures[1]);
        if !normalized.is_empty() && !route_text.contains(&normalized) {
            return None;
        }
    }
    let lower = source.to_lowercase();
    let stop = [
        "open", "show", "find", "book", "search", "from", "with", "that", "this", "website",
        "online", "please", brand,
    ];
    let grounded = regex(&TERM, r"[a-z]{4,}")
        .find_iter(&lower)
        .map(|m| m.as_str())
        .filter(|term| !stop.contains(term))
        .any(|term| route_text.contains(term));
    grounded.then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_website_commands_normalize_domains_without_misrouting_files_or_prose() {
        for command in [
            "open clidey.com",
            "visit clidey.com",
            "go to clidey.com",
            "clidey.com",
            "https://clidey.com",
        ] {
            assert_eq!(
                browser_command(command).as_deref(),
                Some("https://clidey.com/"),
                "{command}"
            );
        }
        assert_eq!(
            browser_command("open clidey.com/docs?q=hello%20world#intro").as_deref(),
            Some("https://clidey.com/docs?q=hello%20world#intro")
        );
        assert_eq!(
            browser_command("open http://localhost:3000").as_deref(),
            Some("http://localhost:3000/")
        );
        for command in [
            "project.md",
            "open report.pdf",
            "open ./clidey.com",
            "explain clidey.com",
            "open javascript:alert(1)",
            "file:///tmp/test",
            "open https://user:password@clidey.com",
            "open https://clidey.com\nhttps://other.test",
            "open https://clidey.com\\evil",
        ] {
            assert_eq!(browser_command(command), None, "{command}");
        }
        let long = format!("https://example.test/{}", "a".repeat(4096));
        for url in [
            json!("clidey.com"),
            json!("javascript:alert(1)"),
            json!("file:///tmp/test"),
            json!("https://user:password@clidey.com"),
            json!(null),
            json!({}),
            json!(long),
        ] {
            assert_eq!(browser_url_value(Some(&url)), None, "{url}");
        }
    }

    #[test]
    fn model_routed_website_actions_cannot_invent_or_change_a_user_supplied_destination() {
        let check =
            |request: &str, url: &str| requested_browser_url(request, Some(&json!(url)), false);
        assert_eq!(
            check("Please open clidey.com for me", "https://clidey.com/").as_deref(),
            Some("https://clidey.com/")
        );
        assert_eq!(
            check(
                "Visit https://clidey.com/docs?q=help please",
                "https://clidey.com/docs?q=help"
            )
            .as_deref(),
            Some("https://clidey.com/docs?q=help")
        );
        assert_eq!(
            check("Open clidey.com.", "https://clidey.com/").as_deref(),
            Some("https://clidey.com/")
        );
        for url in [
            "https://attacker.example/",
            "https://clidey.com/other",
            "javascript:alert(1)",
            "https://clidey.com/?leak=secret",
        ] {
            assert_eq!(check("Open clidey.com", url), None, "{url}");
        }
        assert_eq!(
            requested_browser_url(
                "open the airbnb website",
                Some(&json!("https://www.airbnb.com/")),
                true
            )
            .as_deref(),
            Some("https://www.airbnb.com/")
        );
        assert_eq!(
            requested_browser_url(
                "open the site",
                Some(&json!("https://intranet.local/")),
                true
            ),
            None
        );
    }

    #[test]
    fn website_tasks_must_be_grounded_in_the_request() {
        let task =
            |request: &str, url: &str| requested_website_task_url(request, Some(&json!(url)));
        assert!(
            task(
                "search trainline from london to paris",
                "https://www.trainline.com/search/london/paris"
            )
            .is_some()
        );
        assert_eq!(
            task(
                "search trainline from london to paris",
                "https://www.trainline.com/search/london/rome"
            ),
            None
        );
        // A qualifier that the page does not reflect is not grounded.
        assert_eq!(
            task(
                "search trainline for cheap seats from london to paris",
                "https://www.trainline.com/search/london/paris"
            ),
            None
        );
        assert_eq!(
            task(
                "search trainline tomorrow",
                "https://www.trainline.com/search?q=tomorrow"
            ),
            None
        );
        assert_eq!(
            task(
                "search trainline for trains",
                "https://www.trainline.com/account/trains"
            ),
            None
        );
        assert_eq!(
            task(
                "search other for trains",
                "https://www.trainline.com/search/trains"
            ),
            None
        );
    }
}
