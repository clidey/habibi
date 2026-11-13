//! Browser destinations the assistant router may propose. A private copy of
//! `src/core/browser-url.ts` (habibi-local owns the route-facing port); keep
//! the two in step.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::util::decode_uri_component;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

static UNSAFE_CHARS: LazyLock<Regex> = LazyLock::new(|| re(r"[\s\x00-\x1f\x7f\\]"));
static COMMAND_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(?:open|visit|go\s+to|browse(?:\s+to)?)\s+"));
static HTTP_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^https?://"));
static BARE_DOMAIN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,63}(?::\d{1,5})?(?:[/?#]|$)"));
static DOCUMENT_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|json|js|ts|png|jpe?g|zip)$"));
static WRAPPING_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| re(r#"^["'(\[]+|["')\],.!]+$"#));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
static OPEN_VERB: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:open|visit|browse|navigate|go\s+to|take\s+me\s+to)\b"));
static PRIVATE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| re(r"\.(?:local|localhost|internal|test|invalid)$"));
static IPV4: LazyLock<Regex> = LazyLock::new(|| re(r"^\d+(?:\.\d+){3}$"));
static TASK_WORDS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:search|find|book|buy|tickets?|flights?|hotels?|buses?|from\b.+\bto)\b"));
static BRAND: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z][a-z0-9-]+$"));
static SENSITIVE_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:checkout|payment|pay|purchase|confirm|account|login|delete|admin|api)\b"));
static RELATIVE_DATE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:today|tomorrow|tonight|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b",
    )
});
// The JS pattern ends in a lookahead; consuming it instead yields the same
// first match and captures.
static JOURNEY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\bfrom\s+([a-z][a-z -]{0,50}?)\s+to\s+([a-z][a-z -]{0,50}?)(?:\s+(?:on|for|today|tomorrow|next|with|via|at)\b|[?.!,]|$)",
    )
});
// Same lookahead rewrite: the consumed character can never start a match.
static QUALIFIER: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:for|with)\s+([a-z0-9][a-z0-9 -]{0,80})(?:[?.!,]|$)"));
static LONG_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"[a-z]{4,}"));

fn alphanumeric(value: &str) -> String {
    value.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

/// `value.replace(/^["'(\[]+|["')\],.!]+$/g, '')`.
pub fn strip_wrapping(value: &str) -> String {
    WRAPPING_PUNCTUATION.replace_all(value, "").into_owned()
}

/// `[request, ...request.split(/\s+/)]`.
pub fn request_parts(request: &str) -> Vec<&str> {
    std::iter::once(request).chain(WHITESPACE.split(request)).collect()
}

/// Browser destinations only; never hand file paths, credentials, or custom
/// schemes to the opener.
pub fn browser_url(value: &str) -> Option<String> {
    if value.encode_utf16().count() > 4096 || UNSAFE_CHARS.is_match(value) {
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

pub fn browser_command(command: &str) -> Option<String> {
    let value = COMMAND_PREFIX.replace(command.trim(), "").into_owned();
    if HTTP_PREFIX.is_match(&value) {
        return browser_url(&value);
    }
    // A bare domain is a destination; common document suffixes remain local-file searches.
    if !BARE_DOMAIN.is_match(&value) || DOCUMENT_SUFFIX.is_match(&value) {
        return None;
    }
    browser_url(&format!("https://{value}"))
}

fn supplied_destination(request: &str) -> bool {
    request_parts(request).into_iter().any(|part| browser_command(&strip_wrapping(part)).is_some())
}

/// `url.search` / `url.hash` are empty both when absent and when bare.
fn empty(part: Option<&str>) -> bool {
    part.is_none_or(str::is_empty)
}

fn hostname(url: &Url) -> String {
    url.host_str().unwrap_or("").to_string()
}

pub fn requested_browser_url(request: &str, destination: Option<&str>, allow_named_website: bool) -> Option<String> {
    let url = destination.and_then(browser_url);
    let supplied: HashSet<String> = request_parts(request)
        .into_iter()
        .flat_map(|value| [browser_command(value), browser_command(&strip_wrapping(value))])
        .flatten()
        .collect();
    if let Some(url) = &url
        && supplied.contains(url)
    {
        return Some(url.clone());
    }
    let url = url?;
    if !supplied.is_empty() || !allow_named_website || !OPEN_VERB.is_match(request) {
        return None;
    }
    let site = Url::parse(&url).ok()?;
    let host = hostname(&site);
    let public_homepage = site.scheme() == "https"
        && site.path() == "/"
        && empty(site.query())
        && empty(site.fragment())
        && host.contains('.')
        && !PRIVATE_SUFFIX.is_match(&host)
        && !IPV4.is_match(&host)
        && !host.contains(':');
    public_homepage.then_some(url)
}

/// A model may propose a task page only when its site and search terms are
/// grounded in the request.
pub fn requested_website_task_url(request: &str, destination: Option<&str>) -> Option<String> {
    let source = request.trim();
    let url = destination.and_then(browser_url)?;
    if !TASK_WORDS.is_match(source) {
        return None;
    }
    // A typed URL or domain must continue through the exact-destination guard.
    if supplied_destination(source) {
        return None;
    }
    let candidate = Url::parse(&url).ok()?;
    let host = hostname(&candidate).to_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    let brand = if labels.len() >= 2 { labels[labels.len() - 2] } else { "" };
    let brand_pattern = Regex::new(&format!(r"(?i)\b{}\b", brand.replace('-', "[ -]?"))).ok()?;
    let path = candidate.path();
    let path_and_query = match candidate.query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_string(),
    };
    if candidate.scheme() != "https"
        || candidate.port().is_some()
        || !empty(candidate.fragment())
        || labels.len() < 2
        || brand.len() < 4
        || !BRAND.is_match(brand)
        || ["co", "com", "org", "net"].contains(&brand)
        || PRIVATE_SUFFIX.is_match(&host)
        || !brand_pattern.is_match(source)
        || SENSITIVE_PATH.is_match(path)
        || (path == "/" && empty(candidate.query()))
    {
        return None;
    }
    let route_text = alphanumeric(&decode_uri_component(&path_and_query)?);
    let source_text = alphanumeric(source);
    // Relative travel dates and extra filters cannot be checked against an
    // arbitrary site's private URL format. Search with the full request instead.
    if RELATIVE_DATE.is_match(source) {
        return None;
    }
    if let Some(journey) = JOURNEY.captures(source) {
        let from = alphanumeric(&journey[1]);
        let to = alphanumeric(&journey[2]);
        if !route_text.contains(&from) || !route_text.contains(&to) {
            return None;
        }
    }
    for (_, value) in candidate.query_pairs() {
        let normalized = alphanumeric(&value);
        if !normalized.is_empty() && !source_text.contains(&normalized) {
            return None;
        }
    }
    for qualifier in QUALIFIER.captures_iter(source) {
        let normalized = alphanumeric(&qualifier[1]);
        if !normalized.is_empty() && !route_text.contains(&normalized) {
            return None;
        }
    }
    let lowered = source.to_lowercase();
    let skip = [
        "open", "show", "find", "book", "search", "from", "with", "that", "this", "website", "online", "please", brand,
    ];
    let grounded = LONG_WORD
        .find_iter(&lowered)
        .map(|term| term.as_str())
        .filter(|term| !skip.contains(term))
        .any(|term| route_text.contains(term));
    grounded.then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_refuse_other_schemes_credentials_and_control_characters() {
        assert_eq!(browser_url("https://clidey.com").as_deref(), Some("https://clidey.com/"));
        assert_eq!(browser_url("javascript:alert(1)"), None);
        assert_eq!(browser_url("file:///etc/passwd"), None);
        assert_eq!(browser_url("https://user:pw@example.com/"), None);
        assert_eq!(browser_url("https://exa mple.com/"), None);
        assert_eq!(browser_url("https://example.com/\\x"), None);
    }

    #[test]
    fn browser_commands_accept_urls_and_bare_domains_but_not_documents() {
        assert_eq!(browser_command("open clidey.com").as_deref(), Some("https://clidey.com/"));
        assert_eq!(browser_command("go to https://clidey.com/a?b=1").as_deref(), Some("https://clidey.com/a?b=1"));
        assert_eq!(browser_command("report.pdf"), None);
        assert_eq!(browser_command("hello world"), None);
    }
}
