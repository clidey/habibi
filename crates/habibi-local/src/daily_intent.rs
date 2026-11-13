//! Exact utility intents work locally, even before a model has been
//! configured. Ported from `src/core/daily-intent.ts`.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DailyIntent {
    /// `clipboard`, `reminders`, `focus` or `recents`.
    pub name: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
}

pub fn daily_intent(value: &str) -> Option<DailyIntent> {
    static REMINDER: OnceLock<Regex> = OnceLock::new();
    static FOCUS: OnceLock<Regex> = OnceLock::new();
    static TIMED: OnceLock<Regex> = OnceLock::new();
    static MINUTES: OnceLock<Regex> = OnceLock::new();
    static CLIPBOARD: OnceLock<Regex> = OnceLock::new();
    static RECENTS: OnceLock<Regex> = OnceLock::new();
    let get = |cell: &'static OnceLock<Regex>, pattern: &str| {
        cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
    };
    let text = value.trim().to_lowercase();
    let intent = |name| {
        Some(DailyIntent {
            name,
            minutes: None,
        })
    };
    if get(&REMINDER, r"^(?:(?:today|tomorrow)\s+)?(?:please\s+)?(?:remind me\b|(?:create|add|set)\s+(?:a\s+)?reminder\b)").is_match(&text) {
        return intent("reminders");
    }
    if get(
        &FOCUS,
        r"^(?:(?:start|set|begin)\s+(?:a\s+)?)?(?:focus|pomodoro|(?:focus\s+)?timer)\b",
    )
    .is_match(&text)
        || get(
            &TIMED,
            r"^(?:start|set)\s+(?:a\s+)?\d+\s*(?:min(?:ute)?s?)\s+(?:focus|timer|break)\b",
        )
        .is_match(&text)
    {
        let minutes = get(&MINUTES, r"\b(\d{1,3})\s*(?:m|min(?:ute)?s?)\b")
            .captures(&text)
            .and_then(|captures| captures[1].parse::<u32>().ok())
            .filter(|minutes| *minutes > 0 && *minutes <= 240);
        return Some(DailyIntent {
            name: "focus",
            minutes,
        });
    }
    if get(
        &CLIPBOARD,
        r"^(?:open|show)\s+(?:my\s+)?clipboard(?:\s+history)?$",
    )
    .is_match(&text)
    {
        return intent("clipboard");
    }
    if get(
        &RECENTS,
        r"^(?:open|show)\s+(?:my\s+)?recent(?:ly opened)?(?:\s+(?:files|items))?$",
    )
    .is_match(&text)
    {
        return intent("recents");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_commands_route_locally_without_confusing_ordinary_prose_with_actions() {
        assert_eq!(
            daily_intent("Tomorrow remind me at 12pm to pack lunch")
                .unwrap()
                .name,
            "reminders"
        );
        assert_eq!(
            daily_intent("start a 25 minute focus timer"),
            Some(DailyIntent {
                name: "focus",
                minutes: Some(25)
            })
        );
        assert_eq!(
            daily_intent("show my recent files").unwrap().name,
            "recents"
        );
        assert_eq!(daily_intent("What is a focus timer?"), None);
    }
}
