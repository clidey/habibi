//! Daily utility proposals (`daily-plan.ts`): the model picks one bounded
//! utility; nothing here executes it.

use chrono::{DateTime, Local, Utc};
use serde_json::{Value, json};

use crate::error::{FileResult, fail};
use crate::util::{js_integer, js_slice};

pub fn daily_planning_prompt(now: DateTime<Local>) -> String {
    let local = now.format("%a %b %d %Y %H:%M:%S GMT%z");
    let iso = now.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ");
    format!(
        r#"You are Habibi's daily utility planner. Current local time: {local}, ISO: {iso}. Return ONE JSON object, no Markdown, never execute. For a focus/countdown timer: {{"kind":"timer","action":"start"|"pause"|"resume"|"reset"|"show","seconds":integer 60..14400,"label":"short name"}}. For Apple Reminders: {{"kind":"reminder","action":"create"|"list"|"complete","title":"task or existing task title","due":"ISO timestamp with timezone or empty","notes":"optional"}}. For clipboard: {{"kind":"clipboard"}}. For recent files: {{"kind":"recents"}}. Otherwise {{"kind":"clarify","question":"specific question"}}. Relative dates must use the given local clock/timezone. Keep the task separate from scheduling words. Missing dates stay empty; never invent people or data. Writes require the user's subsequent review button. Never claim an action happened."#
    )
}

fn text(value: Option<&Value>, limit: usize) -> String {
    match value {
        Some(Value::String(text)) => js_slice(text.trim(), limit),
        _ => String::new(),
    }
}

fn action(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        None => "undefined".into(),
        Some(other) => other.to_string(),
    }
}

/// `/T.*(?:Z|[+-]\d\d:\d\d)$/` and a parseable date.
fn valid_due(due: &str) -> bool {
    let bytes = due.as_bytes();
    let zone = due.ends_with('Z')
        || (bytes.len() >= 6 && {
            let tail = &bytes[bytes.len() - 6..];
            matches!(tail[0], b'+' | b'-')
                && tail[1].is_ascii_digit()
                && tail[2].is_ascii_digit()
                && tail[3] == b':'
                && tail[4].is_ascii_digit()
                && tail[5].is_ascii_digit()
        });
    let has_time = due.contains('T');
    if !zone || !has_time {
        return false;
    }
    DateTime::parse_from_rfc3339(due).is_ok()
        || DateTime::parse_from_str(due, "%Y-%m-%dT%H:%M%:z").is_ok()
        || DateTime::parse_from_str(&due.replace('Z', "+00:00"), "%Y-%m-%dT%H:%M%:z").is_ok()
}

pub fn normalize_daily_plan(value: &Value) -> FileResult<Value> {
    let empty = serde_json::Map::new();
    let data = value.as_object().unwrap_or(&empty);
    let kind = data.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "clipboard" | "recents" => Ok(json!({ "kind": kind })),
        "clarify" => {
            let question = text(data.get("question"), 500);
            Ok(json!({
                "kind": "clarify",
                "question": if question.is_empty() { "Which task should I prepare?".to_string() } else { question },
            }))
        }
        "timer" => {
            let action = action(data.get("action"));
            if !["start", "pause", "resume", "reset", "show"].contains(&action.as_str()) {
                return fail("The timer action is invalid.");
            }
            let seconds = match data.get("seconds") {
                None | Some(Value::Null) => Some(1500),
                Some(seconds) => js_integer(seconds),
            };
            let Some(seconds) = seconds.filter(|seconds| (60..=14400).contains(seconds)) else {
                return fail("Choose a timer between 1 minute and 4 hours.");
            };
            let label = text(data.get("label"), 100);
            Ok(json!({
                "kind": "timer",
                "action": action,
                "seconds": seconds,
                "label": if label.is_empty() { "Focus".to_string() } else { label },
            }))
        }
        "reminder" => {
            let action = action(data.get("action"));
            let title = text(data.get("title"), 500);
            if !["create", "list", "complete"].contains(&action.as_str()) || (action != "list" && title.is_empty()) {
                return fail("The reminder needs a task title.");
            }
            let due = text(data.get("due"), 100);
            if !due.is_empty() && !valid_due(&due) {
                return fail("The reminder date is invalid.");
            }
            Ok(json!({
                "kind": "reminder",
                "action": action,
                "title": title,
                "due": due,
                "notes": text(data.get("notes"), 2000),
            }))
        }
        _ => fail("The model could not choose a daily utility. Try stating the task and time."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(value: Value) -> String {
        normalize_daily_plan(&value).unwrap_err().message().to_string()
    }

    #[test]
    fn daily_ai_proposals_validate_durations_dates_and_bounded_actions_without_executing() {
        assert_eq!(normalize_daily_plan(&json!({ "kind": "timer", "action": "start", "seconds": 1500 })).unwrap()["seconds"], 1500);
        assert!(message(json!({ "kind": "timer", "action": "start", "seconds": -1 })).contains("between"));
        assert!(message(json!({ "kind": "reminder", "action": "create", "title": "Task", "due": "tomorrow" })).contains("date"));
        assert!(message(json!({ "kind": "shell", "command": "rm" })).contains("choose"));
        let reminder = normalize_daily_plan(&json!({
            "kind": "reminder",
            "action": "create",
            "title": "Pack lunch",
            "due": "2026-11-07T12:00:00+05:30",
        }))
        .unwrap();
        assert_eq!(reminder["title"], "Pack lunch");
        assert!(valid_due("2026-11-07T12:00Z"));
        assert_eq!(normalize_daily_plan(&json!({ "kind": "timer", "action": "show" })).unwrap()["label"], "Focus");
    }

    #[test]
    fn the_prompt_carries_the_local_clock() {
        let prompt = daily_planning_prompt(Local::now());
        assert!(prompt.contains("GMT") && prompt.contains("ISO: 20"));
    }
}
