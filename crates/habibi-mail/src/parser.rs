//! Turns a fetched email into the conversation bubbles the mail view shows.
//! Ported from `src/server/services/mail-message-parser.js`.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use regex::Regex;
use serde::Serialize;

macro_rules! regex {
    ($pattern:literal) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).expect("valid regex"))
    }};
}

/// One bubble of a conversation.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessage {
    pub from: String,
    pub to: String,
    pub sent: String,
    pub body: String,
    pub html: String,
    pub direction: String,
    pub timestamp: i64,
    pub forwarded_from: String,
    pub forwarded_to: String,
}

/// Remove the "Note: This email is received from an external sender" banner
/// and the lines that follow it up to the next blank line.
fn strip_external_sender_note(text: &str) -> String {
    let start = regex!(r"(?im)^Note:\s*This email is received from an external sender[^\n]*");
    let blank_line = regex!(r"^\s*\n");
    let mut out = String::with_capacity(text.len());
    let mut position = 0;
    while let Some(found) = start.find_at(text, position) {
        out.push_str(&text[position..found.start()]);
        let mut end = found.end();
        // `(?:\n(?!\s*\n)[^\n]*)*`: keep consuming lines until a blank one.
        while text[end..].starts_with('\n') && !blank_line.is_match(&text[end + 1..]) {
            end += 1;
            end += text[end..].find('\n').unwrap_or(text.len() - end);
        }
        position = end;
    }
    out.push_str(&text[position..]);
    out
}

fn truncate_at(text: String, pattern: &Regex) -> String {
    match pattern.find(&text) {
        Some(found) => text[..found.start()].to_string(),
        None => text,
    }
}

// Mail clients commonly put the whole quoted conversation in `text/plain`.
// Treat the quoted headers as structure, rather than displaying one large
// MIME-ish blob. This deliberately preserves the message prose while dropping
// visual noise such as inline-image ids, link wrappers, warning banners and
// legal footers.
fn clean_mail_text(value: &str) -> String {
    let text = value.replace("\r\n", "\n");
    let text = regex!(r"(?im)^\s*\[cid:[^\]]+\].*$").replace_all(&text, "");
    let text = regex!(r"<https?://[^>\s]+>").replace_all(&text, "");
    let text = strip_external_sender_note(&text);
    let text = truncate_at(text, regex!(r"(?im)^This message \(including any attachments\)"));
    let text = truncate_at(text, regex!(r"(?im)^This message and any attachments are confidential"));
    let text = regex!(r"(?m)^_{10,}\s*$").replace_all(&text, "");
    let text = regex!(r"\n[ \t]*\n[ \t]*\n+").replace_all(&text, "\n\n");
    text.trim().to_string()
}

/// The first email address in `value`, lowercased.
pub fn address_from(value: &str) -> String {
    regex!(r"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}")
        .find(value)
        .map(|found| found.as_str().to_lowercase())
        .unwrap_or_default()
}

/// A subject without `Re:`/`Fwd:` prefixes, for matching replies.
pub fn conversation_subject(value: &str) -> String {
    let text = regex!(r"(?i)^(?:(?:re|fw|fwd)\s*:\s*)+").replace(value, "");
    let text = regex!(r"\s+").replace_all(&text, " ");
    text.trim().to_lowercase()
}

const ALLOWED_TAGS: &[&str] = &[
    "a",
    "b",
    "blockquote",
    "br",
    "div",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
];

/// `allowedStyles['*']` from the sanitize-html configuration.
fn style_allowed(property: &str, value: &str) -> bool {
    match property {
        "font-size" => regex!(r"(?i)^\d+(?:px|pt|em|rem|%)$").is_match(value),
        "font-weight" => regex!(r"(?i)^(?:normal|bold|[1-9]00)$").is_match(value),
        "font-style" => regex!(r"(?i)^(?:normal|italic)$").is_match(value),
        "text-align" => regex!(r"(?i)^(?:left|right|center)$").is_match(value),
        "text-decoration" => regex!(r"(?i)^(?:none|underline)$").is_match(value),
        _ => false,
    }
}

/// Keep only allowed declarations, serialized as sanitize-html did
/// (`prop:value;prop:value`); drop the attribute when nothing survives.
fn filter_style(style: &str) -> Option<String> {
    let kept: Vec<String> = style
        .split(';')
        .filter_map(|declaration| {
            let (property, value) = declaration.split_once(':')?;
            let (property, value) = (property.trim(), value.trim());
            style_allowed(property, value).then(|| format!("{property}:{value}"))
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join(";"))
}

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static CELL: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut builder = ammonia::Builder::empty();
        let link: HashSet<&str> = ["href", "title"].into();
        let cell: HashSet<&str> = ["colspan", "rowspan"].into();
        builder
            .tags(ALLOWED_TAGS.iter().copied().collect())
            // sanitize-html's `nonTextTags`: dropped together with their text.
            .clean_content_tags(["script", "style", "textarea", "option", "xmp"].into())
            .tag_attributes(HashMap::from([("a", link), ("td", cell.clone()), ("th", cell)]))
            .generic_attributes(["style"].into())
            .url_schemes(["http", "https", "mailto"].into())
            .url_relative(ammonia::UrlRelative::PassThrough)
            // The Node configuration asked for target/rel on links, but
            // sanitize-html filtered them out again because they are not in
            // `allowedAttributes`; the UI handles link clicks itself.
            .link_rel(None)
            .strip_comments(true)
            .attribute_filter(|_element, attribute, value| {
                if attribute == "style" { filter_style(value).map(Cow::Owned) } else { Some(Cow::Borrowed(value)) }
            });
        builder
    })
}

/// The current email's HTML, sanitized for display.
pub fn safe_email_html(value: &str) -> String {
    // Only render the current email's HTML. Quoted mail is already split into
    // separate plain-text bubbles below, so it must not be duplicated here.
    let current = truncate_at(value.to_string(), regex!(r"(?i)<hr\b[^>]*>"));
    let current =
        truncate_at(current, regex!(r"(?i)(?:<br\s*/?>(?:\s|&nbsp;|<br\s*/?>)*){2,}\s*(?:From:|On\s.+?wrote:)"));
    // HTML mail often wraps a reply header in a nest of spans/divs instead of
    // placing it directly after a <br>. Cutting at its first visible `From:` is
    // safe: the sanitizer closes any remaining open tags for us.
    let current = truncate_at(current, regex!(r"(?i)(?:<[^>]+>\s*){0,6}From:\s"));
    let current = regex!(r"(?i)={3,}\s*Forwarded message\s*={3,}").replace_all(&current, "");
    let sanitized = sanitizer().clean(&current).to_string();
    // Outlook/Zoho signatures often encode blank paragraphs as <div><br></div>.
    // They create huge visual gaps in a compact launcher, so collapse them while
    // retaining one meaningful line break between prose blocks.
    let collapsed = regex!(r"(?i)<(?:div|p)(?:\s[^>]*)?>\s*(?:<br\s*/?>\s*)+</(?:div|p)>").replace_all(&sanitized, "");
    let collapsed = regex!(r"(?i)(?:<br\s*/?>\s*){3,}").replace_all(&collapsed, "<br><br>");
    collapsed.trim().to_string()
}

struct Section {
    from: String,
    to: String,
    sent: String,
    body: String,
}

fn header(headers: &str, pattern: &Regex) -> String {
    pattern
        .captures(headers)
        .and_then(|captures| captures.get(1))
        .map(|found| found.as_str().trim().to_string())
        .unwrap_or_default()
}

fn section_headers(section: &str) -> Section {
    let normalized = regex!(r"(?i)^\s*_{10,}\s*\n*").replace(section, "");
    let normalized = normalized.trim();
    let from = regex!(r"(?im)^From:\s*(.+)$");
    if !regex!(r"(?i)^From:\s*").is_match(normalized) {
        return Section { from: String::new(), to: String::new(), sent: String::new(), body: normalized.into() };
    }
    let Some(boundary) = regex!(r"\n\s*\n").find(normalized) else {
        return Section { from: header(normalized, from), to: String::new(), sent: String::new(), body: String::new() };
    };
    let headers = &normalized[..boundary.start()];
    Section {
        from: header(headers, from),
        to: header(headers, regex!(r"(?im)^To:\s*(.+)$")),
        sent: header(headers, regex!(r"(?im)^(?:Sent|Date):\s*(.+)$")),
        body: normalized[boundary.start()..].trim().into(),
    }
}

/// `body.split(/\n(?:\s*_{10,}\s*\n\s*)?(?=From:\s)/i)` without lookahead.
fn split_sections(body: &str) -> Vec<&str> {
    let separator = regex!(r"(?i)\n(?:\s*_{10,}\s*\n\s*)?(From:\s)");
    let mut sections = Vec::new();
    let (mut section_start, mut search_from) = (0, 0);
    while let Some(captures) = separator.captures_at(body, search_from) {
        let (Some(whole), Some(next)) = (captures.get(0), captures.get(1)) else { break };
        sections.push(&body[section_start..whole.start()]);
        section_start = next.start();
        search_from = next.start();
    }
    sections.push(&body[section_start..]);
    sections
}

/// Split a plain-text email into its own message and the quoted ones.
pub fn split_mail_thread(
    body: &str,
    latest_from: &str,
    own_email: &str,
    fallback_timestamp: i64,
    first_html: &str,
) -> Vec<ThreadMessage> {
    // A separator may have an empty line before `From:`, or the client may omit it.
    let normalized = body.replace("\r\n", "\n");
    let sections = split_sections(&normalized);
    let own = own_email.to_lowercase();
    let messages: Vec<ThreadMessage> = sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            let parsed = section_headers(section);
            let from = if !parsed.from.is_empty() {
                parsed.from.clone()
            } else if index == 0 {
                latest_from.to_string()
            } else {
                "Unknown sender".into()
            };
            let content = clean_mail_text(&parsed.body);
            let sender = address_from(&from);
            let parsed_time = if parsed.sent.is_empty() { None } else { parse_date(&parsed.sent) };
            let body = regex!(r"(?i)={3,}\s*Forwarded message\s*={3,}").replace_all(&content, "").trim().to_string();
            ThreadMessage {
                direction: if !sender.is_empty() && sender == own { "outgoing" } else { "incoming" }.into(),
                timestamp: parsed_time.unwrap_or_else(|| (fallback_timestamp - index as i64).max(0)),
                from,
                to: parsed.to,
                sent: parsed.sent,
                body,
                html: if index == 0 { first_html.into() } else { String::new() },
                forwarded_from: String::new(),
                forwarded_to: String::new(),
            }
        })
        .filter(|message| !message.body.is_empty())
        .collect();
    // A forwarded email is followed by a normal From: header. Attach that sender
    // to the preceding bubble so the client can render a concise forward marker.
    // (Indexes `sections` by the filtered position, exactly as the Node code did.)
    let forwarded = regex!(r"(?i)forwarded message");
    let mut result = messages.clone();
    for (index, message) in result.iter_mut().enumerate() {
        if sections.get(index).is_some_and(|section| forwarded.is_match(section)) {
            message.forwarded_from = messages.get(index + 1).map(|next| next.from.clone()).unwrap_or_default();
            message.forwarded_to = messages.get(index + 1).map(|next| next.to.clone()).unwrap_or_default();
        }
    }
    result
}

/// Drop repeated bubbles (same sender and text) and order oldest first.
pub fn dedupe_messages(messages: Vec<ThreadMessage>) -> Vec<ThreadMessage> {
    let mut seen = HashSet::new();
    let mut kept: Vec<ThreadMessage> = messages
        .into_iter()
        .filter(|message| {
            let body = regex!(r"\s+").replace_all(&message.body, " ").trim().to_lowercase();
            seen.insert(format!("{}:{}", address_from(&message.from), body))
        })
        .collect();
    kept.sort_by_key(|message| message.timestamp);
    kept
}

/// One mailbox from `LIST`: its path and special-use attributes.
pub struct MailboxInfo {
    pub path: String,
    pub special_use: Vec<String>,
}

/// The mailbox that holds sent mail, or `""`.
pub fn sent_mailbox_path(mailboxes: &[MailboxInfo]) -> String {
    mailboxes
        .iter()
        .find(|mailbox| {
            let special = mailbox.special_use.join(" ");
            regex!(r"(?i)\\Sent").is_match(&special)
                || regex!(r"(?i)^(sent|sent items|sent mail)$").is_match(&mailbox.path)
        })
        .map(|mailbox| mailbox.path.clone())
        .unwrap_or_default()
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn zone_offset(token: &str) -> Option<i32> {
    let hours = match token {
        "z" | "gmt" | "ut" | "utc" => 0,
        "edt" => -4,
        "est" | "cdt" => -5,
        "cst" | "mdt" => -6,
        "mst" | "pdt" => -7,
        "pst" => -8,
        _ => {
            let captures = regex!(r"^(?:gmt|utc)?([+-])(\d{1,2}):?(\d{2})?$").captures(token)?;
            let sign = if &captures[1] == "-" { -1 } else { 1 };
            let (hours, minutes): (i32, i32) = match captures.get(3) {
                Some(minutes) => (captures[2].parse().ok()?, minutes.as_str().parse().ok()?),
                // `+0530` arrives as one run of digits.
                None if captures[2].len() > 2 => (captures[2][..2].parse().ok()?, captures[2][2..].parse().ok()?),
                None => (captures[2].parse().ok()?, 0),
            };
            return Some(sign * (hours * 3600 + minutes * 60));
        }
    };
    Some(hours * 3600)
}

/// A lenient `Date.parse` for the `Sent:`/`Date:` lines mail clients quote:
/// RFC 2822 dates, ISO dates and `Monday, January 6, 2025 10:00 AM`. Dates
/// without a zone are local time, as in JavaScript.
pub fn parse_date(value: &str) -> Option<i64> {
    let text = value.trim().to_lowercase();
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(&text.to_uppercase()) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
        return Some(date.and_time(NaiveTime::MIN).and_utc().timestamp_millis());
    }
    let (mut year, mut month, mut day) = (None::<i32>, None::<u32>, None::<u32>);
    let (mut time, mut meridiem, mut offset) = (None::<(u32, u32, u32)>, None::<bool>, None::<i32>);
    let spaced = regex!(r"([+-]\d)").replace_all(&text, " $1");
    let clock = regex!(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(am|pm)?$");
    let numeric = regex!(r"^(\d{1,2})/(\d{1,2})/(\d{4})$");
    for raw in spaced.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')') {
        let token = raw.trim_matches('.');
        if token.is_empty() || token == "at" {
            continue;
        }
        if let Some(captures) = clock.captures(token) {
            let second = captures.get(3).map_or(Some(0), |s| s.as_str().parse().ok())?;
            time = Some((captures[1].parse().ok()?, captures[2].parse().ok()?, second));
            if let Some(suffix) = captures.get(4) {
                meridiem = Some(suffix.as_str() == "pm");
            }
        } else if token == "am" || token == "pm" {
            meridiem = Some(token == "pm");
        } else if let Some(captures) = numeric.captures(token) {
            month = captures[1].parse().ok();
            day = captures[2].parse().ok();
            year = captures[3].parse().ok();
        } else if token.len() == 4 && token.bytes().all(|b| b.is_ascii_digit()) && year.is_none() {
            year = token.parse().ok();
        } else if token.len() <= 2 && token.bytes().all(|b| b.is_ascii_digit()) && day.is_none() {
            day = token.parse().ok();
        } else if let Some(index) = MONTHS.iter().position(|name| token.starts_with(name)) {
            month.get_or_insert(index as u32 + 1);
        } else if let Some(zone) = zone_offset(token) {
            offset = Some(zone);
        }
    }
    let date = NaiveDate::from_ymd_opt(year?, month?, day?)?;
    let (mut hour, minute, second) = time.unwrap_or((0, 0, 0));
    match meridiem {
        Some(true) if hour < 12 => hour += 12,
        Some(false) if hour == 12 => hour = 0,
        _ => {}
    }
    let naive = NaiveDateTime::new(date, NaiveTime::from_hms_opt(hour, minute, second)?);
    match offset {
        Some(seconds) => Some(naive.and_utc().timestamp_millis() - i64::from(seconds) * 1000),
        None => Local.from_local_datetime(&naive).earliest().map(|local| local.timestamp_millis()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_html_keeps_current_prose_while_removing_active_and_quoted_content() {
        let html = safe_email_html(
            r#"<p>Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script><hr><p>Quoted</p>"#,
        );
        assert!(html.contains("Hello"));
        for forbidden in ["javascript:", "<script", "Quoted", "alert(1)"] {
            assert!(!html.contains(forbidden), "{html}");
        }
        assert_eq!(html, "<p>Hello <a>link</a></p>");
    }

    #[test]
    fn mail_html_matches_the_sanitize_html_allowlist() {
        // Expected values are what the Node sanitizer produced for the same input.
        assert_eq!(
            safe_email_html(
                r#"<div style="font-size:12px; color:red; font-weight:bold">x</div><a href="https://x.com" title="t" onclick="y" target="_self">l</a><img src=x><table><tr><td colspan=2 width=3>c</td></tr></table>"#
            ),
            r#"<div style="font-size:12px;font-weight:bold">x</div><a href="https://x.com" title="t">l</a><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>"#
        );
        assert_eq!(
            safe_email_html("<p>One</p><div><br></div><div><br></div><p>Two<br><br><br><br>three</p>"),
            "<p>One</p><p>Two<br><br>three</p>"
        );
        assert_eq!(
            safe_email_html("<div>Hi there</div><div><span><b>From: </b>Bob</span></div>"),
            "<div>Hi there</div>"
        );
        assert_eq!(safe_email_html("<p>Hello</p><br><br>On Mon, Bob wrote:<p>old</p>"), "<p>Hello</p>");
        assert_eq!(
            safe_email_html(
                r#"<p style="color:red">x</p><a href="mailto:a@b.c">m</a><a href="/rel">r</a><textarea>t</textarea><style>p{}</style><!-- c --><u>u</u>"#
            ),
            r#"<p>x</p><a href="mailto:a@b.c">m</a><a href="/rel">r</a><u>u</u>"#
        );
        assert_eq!(
            safe_email_html(
                r#"<span style="FONT-SIZE: 10PT;text-align:center ; text-decoration: underline line-through">s</span>"#
            ),
            r#"<span style="text-align:center">s</span>"#
        );
        assert_eq!(safe_email_html("<div>===== Forwarded message =====</div>"), "<div></div>");
    }

    #[test]
    fn quoted_mail_becomes_separate_directional_messages_and_duplicates_collapse() {
        let messages = split_mail_thread(
            "Current reply\nFrom: Alice <alice@example.com>\nTo: Me <me@example.com>\nSent: 1 Jan 2025\n\nEarlier note",
            "Me <me@example.com>",
            "me@example.com",
            2,
            "",
        );
        let summary: Vec<_> =
            messages.iter().map(|m| (m.from.as_str(), m.body.as_str(), m.direction.as_str())).collect();
        assert_eq!(
            summary,
            vec![
                ("Me <me@example.com>", "Current reply", "outgoing"),
                ("Alice <alice@example.com>", "Earlier note", "incoming"),
            ]
        );
        let mut doubled = messages.clone();
        doubled.push(messages[1].clone());
        assert_eq!(dedupe_messages(doubled).len(), 2);
    }

    #[test]
    fn forwarded_and_quoted_sections_match_the_node_parser() {
        let messages = split_mail_thread(
            "Hi\n\n________________________________\nFrom: Al <al@x.com>\nSent: Monday, January 6, 2025 10:00 AM +0000\nTo: me@x.com\n\n---------- Forwarded message ---------\nbody2 [cid:abc] <https://x.y/z>\nFrom: Zed <z@y.com>\nTo: Q\n\nthird\n\n\n\nend",
            "Me <me@x.com>",
            "me@x.com",
            100,
            "<p>h</p>",
        );
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].body, "Hi");
        assert_eq!(messages[0].html, "<p>h</p>");
        assert_eq!(messages[0].direction, "outgoing");
        assert_eq!(messages[0].timestamp, 100);
        assert_eq!(messages[1].from, "Al <al@x.com>");
        assert_eq!(messages[1].to, "me@x.com");
        assert_eq!(messages[1].body, "---------- Forwarded message ---------\nbody2 [cid:abc]");
        assert_eq!(messages[1].timestamp, 1_736_157_600_000);
        assert_eq!(messages[1].forwarded_from, "Zed <z@y.com>");
        assert_eq!(messages[1].forwarded_to, "Q");
        assert_eq!(messages[2].body, "third\n\nend");
        assert_eq!(messages[2].timestamp, 98);
    }

    #[test]
    fn mail_text_drops_banners_and_footers() {
        let text = clean_mail_text(
            "Hello\n[cid:image001.png@01] logo\nNote: This email is received from an external sender\nbe careful\n\nReal text\n__________\nThis message and any attachments are confidential\nlegal",
        );
        assert_eq!(text, "Hello\n\nReal text");
    }

    #[test]
    fn subjects_and_mailboxes() {
        assert_eq!(conversation_subject("Re: FWD:  Lunch   plans "), "lunch plans");
        let boxes = [
            MailboxInfo { path: "INBOX".into(), special_use: vec![] },
            MailboxInfo { path: "[Gmail]/Sent Mail".into(), special_use: vec!["\\Sent".into()] },
        ];
        assert_eq!(sent_mailbox_path(&boxes), "[Gmail]/Sent Mail");
        assert_eq!(sent_mailbox_path(&[MailboxInfo { path: "Sent Items".into(), special_use: vec![] }]), "Sent Items");
        assert_eq!(sent_mailbox_path(&boxes[..1]), "");
    }

    #[test]
    fn dates_parse_like_javascript() {
        assert_eq!(parse_date("Mon, 6 Jan 2025 10:00:00 +0000"), Some(1_736_157_600_000));
        assert_eq!(parse_date("Mon, 6 Jan 2025 11:00:00 +0100"), Some(1_736_157_600_000));
        assert_eq!(parse_date("2025-01-06"), Some(1_736_121_600_000));
        assert_eq!(parse_date("Monday, January 6, 2025 10:00 AM GMT"), Some(1_736_157_600_000));
        assert_eq!(parse_date("Monday, January 6, 2025 10:00 PM UTC"), Some(1_736_200_800_000));
        assert!(parse_date("1 Jan 2025").is_some());
        assert_eq!(parse_date("yesterday"), None);
    }
}
