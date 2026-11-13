//! A small iCalendar (RFC 5545) reader/writer: enough for VEVENT and VTODO
//! over CalDAV. Unknown properties and components are kept verbatim so an
//! edit round-trips everything Habibi does not touch.

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

/// Calendar data larger than this is ignored rather than parsed.
pub const MAX_ICS_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Property {
    /// Upper-cased name, e.g. `DTSTART`.
    pub name: String,
    /// `(NAME, value)` with the name upper-cased and quotes removed.
    pub params: Vec<(String, String)>,
    /// The raw (still escaped) value.
    pub value: String,
}

impl Property {
    pub fn new(name: &str, value: impl Into<String>) -> Self {
        Self {
            name: name.to_ascii_uppercase(),
            params: Vec::new(),
            value: value.into(),
        }
    }

    pub fn text(name: &str, value: &str) -> Self {
        Self::new(name, escape_text(value))
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Component {
    pub name: String,
    pub properties: Vec<Property>,
    pub children: Vec<Component>,
}

impl Component {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_ascii_uppercase(),
            ..Self::default()
        }
    }

    pub fn property(&self, name: &str) -> Option<&Property> {
        self.properties
            .iter()
            .find(|property| property.name.eq_ignore_ascii_case(name))
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.property(name)
            .map(|property| unescape_text(&property.value))
    }

    /// Replace every `name` property with `property`.
    pub fn set(&mut self, property: Property) {
        self.remove(&property.name.clone());
        self.properties.push(property);
    }

    pub fn remove(&mut self, name: &str) {
        self.properties
            .retain(|property| !property.name.eq_ignore_ascii_case(name));
    }

    /// Direct children named `name` (`VEVENT`, `VTODO`, …).
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Component> + 'a {
        self.children
            .iter()
            .filter(move |child| child.name.eq_ignore_ascii_case(name))
    }

    pub fn first_child_mut(&mut self, name: &str) -> Option<&mut Component> {
        self.children
            .iter_mut()
            .find(|child| child.name.eq_ignore_ascii_case(name))
    }

    /// Serialize with CRLF line endings and 75-octet folding.
    pub fn serialize(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        fold_into(out, &format!("BEGIN:{}", self.name));
        for property in &self.properties {
            let mut line = property.name.clone();
            for (name, value) in &property.params {
                line.push(';');
                line.push_str(name);
                line.push('=');
                if value.contains([':', ';', ',']) {
                    line.push('"');
                    line.push_str(&value.replace('"', ""));
                    line.push('"');
                } else {
                    line.push_str(value);
                }
            }
            line.push(':');
            line.push_str(&property.value);
            fold_into(out, &line);
        }
        for child in &self.children {
            child.write(out);
        }
        fold_into(out, &format!("END:{}", self.name));
    }
}

fn fold_into(out: &mut String, line: &str) {
    let line = line.replace(['\r', '\n'], "");
    let mut width = 0;
    for character in line.chars() {
        let size = character.len_utf8();
        if width + size > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(character);
        width += size;
    }
    out.push_str("\r\n");
}

/// Undo RFC 5545 line folding.
fn unfold(input: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in input.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
            continue;
        }
        if !raw.is_empty() {
            lines.push(raw.to_string());
        }
    }
    lines
}

fn parse_line(line: &str) -> Option<Property> {
    let mut chars = line.char_indices().peekable();
    let mut name_end = None;
    while let Some(&(index, character)) = chars.peek() {
        if character == ';' || character == ':' {
            name_end = Some(index);
            break;
        }
        chars.next();
    }
    let name_end = name_end?;
    let name = line[..name_end].trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    let rest = &line[name_end..];
    let mut index = 0;
    let bytes = rest.as_bytes();
    // Walk `;NAME=value[,value]` until the first unquoted `:`.
    while index < bytes.len() && bytes[index] == b';' {
        index += 1;
        let start = index;
        while index < bytes.len()
            && bytes[index] != b'='
            && bytes[index] != b':'
            && bytes[index] != b';'
        {
            index += 1;
        }
        let param_name = rest[start..index].to_ascii_uppercase();
        let mut value = String::new();
        if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            let mut quoted = false;
            let value_start = index;
            while index < bytes.len() {
                match bytes[index] {
                    b'"' => quoted = !quoted,
                    b';' | b':' if !quoted => break,
                    _ => {}
                }
                index += 1;
            }
            value = rest[value_start..index].replace('"', "");
        }
        params.push((param_name, value));
    }
    if index >= bytes.len() || bytes[index] != b':' {
        return None;
    }
    Some(Property {
        name,
        params,
        value: rest[index + 1..].to_string(),
    })
}

/// Parse a VCALENDAR stream. Returns the top-level components.
pub fn parse(input: &str) -> Vec<Component> {
    if input.len() > MAX_ICS_BYTES {
        return Vec::new();
    }
    let mut stack: Vec<Component> = Vec::new();
    let mut roots = Vec::new();
    for line in unfold(input) {
        let Some(property) = parse_line(&line) else {
            continue;
        };
        match property.name.as_str() {
            "BEGIN" => {
                if stack.len() >= MAX_DEPTH {
                    return roots;
                }
                stack.push(Component::new(property.value.trim()));
            }
            "END" => {
                let Some(component) = stack.pop() else {
                    continue;
                };
                if !component.name.eq_ignore_ascii_case(property.value.trim()) {
                    // Mismatched nesting: stop rather than guess.
                    return roots;
                }
                match stack.last_mut() {
                    Some(parent) => parent.children.push(component),
                    None => roots.push(component),
                }
            }
            _ => {
                if let Some(current) = stack.last_mut() {
                    current.properties.push(property);
                }
            }
        }
    }
    roots
}

pub fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            other => out.push(other),
        }
    }
    out
}

pub fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            out.push(character);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// A parsed DATE or DATE-TIME.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IcsTime {
    pub instant: DateTime<Utc>,
    /// The value was a DATE (an all-day boundary in local time).
    pub date_only: bool,
}

fn resolve_zone(tzid: &str) -> Option<chrono_tz::Tz> {
    let tzid = tzid.trim();
    if let Ok(zone) = tzid.parse::<chrono_tz::Tz>() {
        return Some(zone);
    }
    // Some clients prefix the IANA name, e.g. `/mozilla.org/20050126_1/Europe/Paris`.
    let segments: Vec<&str> = tzid
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    (1..segments.len()).find_map(|skip| segments[skip..].join("/").parse::<chrono_tz::Tz>().ok())
}

fn local_instant(naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|date| date.with_timezone(&Utc))
}

/// Read a DTSTART/DTEND/DUE-style property.
pub fn parse_time(property: &Property) -> Option<IcsTime> {
    let value = property.value.trim();
    let date_only = property
        .param("VALUE")
        .is_some_and(|kind| kind.eq_ignore_ascii_case("DATE"))
        || (value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_digit()));
    if date_only {
        let date = NaiveDate::parse_from_str(value.get(..8)?, "%Y%m%d").ok()?;
        return Some(IcsTime {
            instant: local_instant(date.and_hms_opt(0, 0, 0)?)?,
            date_only: true,
        });
    }
    if let Some(utc) = value.strip_suffix(['Z', 'z']) {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some(IcsTime {
            instant: Utc.from_utc_datetime(&naive),
            date_only: false,
        });
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    let instant = match property.param("TZID").and_then(resolve_zone) {
        Some(zone) => zone
            .from_local_datetime(&naive)
            .earliest()?
            .with_timezone(&Utc),
        // Floating time, or a zone name we cannot resolve (e.g. a Windows
        // zone name): the user's local time is the closest reading.
        None => local_instant(naive)?,
    };
    Some(IcsTime {
        instant,
        date_only: false,
    })
}

/// RFC 5545 DURATION (`P1D`, `PT1H30M`, `-PT15M`, `P2W`).
pub fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (negative, rest) = match value.as_bytes().first()? {
        b'-' => (true, &value[1..]),
        b'+' => (false, &value[1..]),
        _ => (false, value),
    };
    let rest = rest.strip_prefix(['P', 'p'])?;
    let mut seconds: i64 = 0;
    let mut number = String::new();
    let mut in_time = false;
    for character in rest.chars() {
        match character.to_ascii_uppercase() {
            digit @ '0'..='9' => number.push(digit),
            'T' => in_time = true,
            unit => {
                let amount: i64 = number.parse().ok()?;
                number.clear();
                let scale = match (unit, in_time) {
                    ('W', false) => 7 * 86_400,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
                seconds = seconds.checked_add(amount.checked_mul(scale)?)?;
            }
        }
    }
    if !number.is_empty() {
        return None;
    }
    let duration = Duration::try_seconds(seconds)?;
    Some(if negative { -duration } else { duration })
}

/// `YYYYMMDDTHHMMSSZ`.
pub fn format_utc(date: DateTime<Utc>) -> String {
    date.format("%Y%m%dT%H%M%SZ").to_string()
}

/// Start, end and all-day flag of a VEVENT.
pub fn event_times(event: &Component) -> Option<(DateTime<Utc>, DateTime<Utc>, bool)> {
    let start = parse_time(event.property("DTSTART")?)?;
    let end = match event.property("DTEND").and_then(parse_time) {
        Some(end) => end.instant,
        None => match event
            .property("DURATION")
            .and_then(|property| parse_duration(&property.value))
        {
            Some(duration) => start.instant + duration,
            // RFC 5545: a DATE start with no end lasts one day; a DATE-TIME
            // start with no end is instantaneous.
            None if start.date_only => start.instant + Duration::days(1),
            None => start.instant,
        },
    };
    Some((start.instant, end.max(start.instant), start.date_only))
}

/// True when this VEVENT is part of a recurrence (a master or an override).
pub fn is_recurring(event: &Component) -> bool {
    ["RRULE", "RDATE", "RECURRENCE-ID"]
        .iter()
        .any(|name| event.property(name).is_some())
}

/// True when a VTODO is finished (completed or cancelled).
pub fn todo_done(todo: &Component) -> bool {
    let status = todo
        .property("STATUS")
        .map(|property| property.value.trim().to_ascii_uppercase());
    matches!(status.as_deref(), Some("COMPLETED" | "CANCELLED"))
        || todo.property("COMPLETED").is_some()
}

/// A complete VCALENDAR wrapping one component.
pub fn calendar_with(component: Component) -> Component {
    let mut calendar = Component::new("VCALENDAR");
    calendar.properties.push(Property::new("VERSION", "2.0"));
    calendar
        .properties
        .push(Property::new("PRODID", "-//Clidey//Habibi//EN"));
    calendar.children.push(component);
    calendar
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:abc@example.com\r\nSUMMARY:Design review\\, round 2\\nwith notes\r\nDESCRIPTION:Long line that is folded acr\r\n oss two lines\r\nDTSTART;TZID=Europe/Paris:20261112T100000\r\nDTEND;TZID=\"Europe/Paris\":20261112T113000\r\nX-CUSTOM;X-PARAM=\"a:b;c\":keep me\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn parses_unfolds_and_unescapes() {
        let roots = parse(SAMPLE);
        assert_eq!(roots.len(), 1);
        let event = roots[0].children_named("VEVENT").next().unwrap();
        assert_eq!(
            event.text("SUMMARY").unwrap(),
            "Design review, round 2\nwith notes"
        );
        assert_eq!(
            event.text("DESCRIPTION").unwrap(),
            "Long line that is folded across two lines"
        );
        let custom = event.property("X-CUSTOM").unwrap();
        assert_eq!(custom.param("x-param"), Some("a:b;c"));
        assert_eq!(custom.value, "keep me");
    }

    #[test]
    fn resolves_tzid_utc_and_durations() {
        let roots = parse(SAMPLE);
        let event = roots[0].children_named("VEVENT").next().unwrap();
        let (start, end, all_day) = event_times(event).unwrap();
        assert_eq!(crate::ids::iso(start), "2026-11-12T09:00:00Z");
        assert_eq!(crate::ids::iso(end), "2026-11-12T10:30:00Z");
        assert!(!all_day);

        let utc = parse("BEGIN:VEVENT\nDTSTART:20261112T090000Z\nDURATION:PT1H30M\nEND:VEVENT\n");
        let (start, end, _) = event_times(&utc[0]).unwrap();
        assert_eq!(end - start, Duration::minutes(90));

        let prefixed = Property {
            name: "DTSTART".into(),
            params: vec![(
                "TZID".into(),
                "/mozilla.org/20050126_1/America/New_York".into(),
            )],
            value: "20260701T120000".into(),
        };
        assert_eq!(
            crate::ids::iso(parse_time(&prefixed).unwrap().instant),
            "2026-07-01T16:00:00Z"
        );
    }

    #[test]
    fn date_only_events_are_all_day_and_default_to_one_day() {
        let roots = parse("BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261112\nEND:VEVENT\n");
        let (start, end, all_day) = event_times(&roots[0]).unwrap();
        assert!(all_day);
        assert_eq!(end - start, Duration::days(1));
    }

    #[test]
    fn durations_cover_weeks_days_and_signs() {
        assert_eq!(parse_duration("P2W"), Some(Duration::days(14)));
        assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("PT"), Some(Duration::zero()));
        assert_eq!(parse_duration("P1H"), None);
        assert_eq!(parse_duration("1D"), None);
    }

    #[test]
    fn vtodo_status_and_recurrence_detection() {
        let roots = parse(
            "BEGIN:VCALENDAR\nBEGIN:VTODO\nUID:1\nSUMMARY:Open\nSTATUS:NEEDS-ACTION\nEND:VTODO\nBEGIN:VTODO\nUID:2\nSTATUS:COMPLETED\nEND:VTODO\nBEGIN:VTODO\nUID:3\nCOMPLETED:20261101T100000Z\nEND:VTODO\nBEGIN:VEVENT\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR\n",
        );
        let todos: Vec<_> = roots[0].children_named("VTODO").collect();
        assert_eq!(
            todos.iter().map(|todo| todo_done(todo)).collect::<Vec<_>>(),
            vec![false, true, true]
        );
        assert!(is_recurring(
            roots[0].children_named("VEVENT").next().unwrap()
        ));
    }

    #[test]
    fn serializes_round_trip_with_folding_and_escaping() {
        let mut event = Component::new("VEVENT");
        event.properties.push(Property::text(
            "SUMMARY",
            &"Ünïcode, semi; back\\slash ".repeat(5),
        ));
        let text = calendar_with(event).serialize();
        assert!(
            text.lines()
                .all(|line| line.trim_end_matches('\r').len() <= 75)
        );
        assert!(text.contains("\\,") && text.contains("\\;") && text.contains("\\\\"));
        let parsed = parse(&text);
        let summary = parsed[0]
            .children_named("VEVENT")
            .next()
            .unwrap()
            .text("SUMMARY")
            .unwrap();
        assert_eq!(summary, "Ünïcode, semi; back\\slash ".repeat(5));
    }

    #[test]
    fn malformed_input_is_ignored_safely() {
        assert!(parse("BEGIN:VEVENT\nEND:VTODO\n").is_empty());
        assert!(parse("garbage\nmore").is_empty());
        let deep = "BEGIN:X\n".repeat(50);
        assert!(parse(&deep).is_empty());
        assert!(parse(&"A".repeat(MAX_ICS_BYTES + 1)).is_empty());
    }
}
