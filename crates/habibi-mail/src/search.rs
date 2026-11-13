//! Mailbox search: turning the user's words into a read-only IMAP search,
//! optionally with help from a model running on this machine.
//! `mail_search_plan` was `mailSearchPlan` in `llm-service.js`.

use std::cmp::Ordering;

use chrono::{Datelike, NaiveDate};
use habibi_core::services::{ChatMessage, CompletionRequest, Llm};
use serde::Serialize;
use serde_json::Value;

use crate::js;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SearchPlan {
    pub terms: Vec<String>,
    pub from: String,
    pub subject: String,
    pub after: String,
    pub before: String,
    pub unread: Option<bool>,
    pub source: String,
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace().filter(|word| js::length(word) > 1).take(8).map(str::to_string).collect()
}

fn valid_date(value: Option<&Value>) -> String {
    let text = js::string_or_empty(value);
    let bytes = text.as_bytes();
    let shape = bytes.len() == 10
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| if index == 4 || index == 7 { *byte == b'-' } else { byte.is_ascii_digit() });
    if shape { text } else { String::new() }
}

fn strip_code_fence(text: &str) -> String {
    let text = text.strip_prefix("```json").map(str::trim_start).unwrap_or(text);
    let text = text.trim_end();
    text.strip_suffix("```").unwrap_or(text).trim().to_string()
}

/// The plan for `query`. Falls back to plain word matching unless a local
/// model is configured.
pub async fn mail_search_plan(llm: &dyn Llm, query: &str) -> SearchPlan {
    let text = js::prefix(query.trim(), 360);
    let fallback = SearchPlan {
        terms: words(&text),
        from: String::new(),
        subject: String::new(),
        after: String::new(),
        before: String::new(),
        unread: None,
        source: "rules".into(),
    };
    let state = llm.state().await;
    // A mailbox query is personal data too. Never send it to a hosted model just
    // to make a search nicer; the local rules remain a good, instant fallback.
    let local = matches!(state.provider.as_deref(), Some("ollama" | "lmstudio"));
    if !state.configured || !local || text.is_empty() {
        return fallback;
    }
    let today = chrono::Utc::now().format("%Y-%m-%d");
    let system_prompt = format!(
        "You translate a user's mailbox search into a safe, read-only IMAP search plan. Return JSON only: {{\"terms\":[\"...\"],\"from\":\"\",\"subject\":\"\",\"after\":\"YYYY-MM-DD or empty\",\"before\":\"YYYY-MM-DD or empty\",\"unread\":true|false|null}}. Today is {today}. Do not invent names, addresses, dates, or mailbox contents. Preserve useful words exactly. Use at most 8 short terms. The plan cannot modify, send, archive, or delete anything."
    );
    let result = llm
        .complete(CompletionRequest {
            system_prompt: Some(system_prompt),
            messages: vec![ChatMessage { role: "user".into(), text: text.clone() }],
            ..Default::default()
        })
        .await;
    if !result.ok {
        return fallback;
    }
    let Ok(value) = serde_json::from_str::<Value>(&strip_code_fence(result.text.as_deref().unwrap_or(""))) else {
        return fallback;
    };
    if value.is_null() {
        return fallback;
    }
    SearchPlan {
        terms: match value.get("terms") {
            Some(Value::Array(terms)) => terms
                .iter()
                .map(|term| js::string(term).trim().to_string())
                .filter(|term| js::length(term) > 1)
                .take(8)
                .collect(),
            _ => fallback.terms,
        },
        from: js::prefix(js::string_or_empty(value.get("from")).trim(), 160),
        subject: js::prefix(js::string_or_empty(value.get("subject")).trim(), 200),
        after: valid_date(value.get("after")),
        before: valid_date(value.get("before")),
        unread: value.get("unread").and_then(Value::as_bool),
        source: "local-model".into(),
    }
}

/// The plan as `mailService.search` normalized it. (Its fallback to the raw
/// query words never applies: `mail_search_plan` always returns terms.)
pub fn normalize(plan: &SearchPlan) -> SearchPlan {
    SearchPlan {
        terms: plan.terms.iter().map(|term| term.trim().to_string()).filter(|term| !term.is_empty()).take(8).collect(),
        from: plan.from.trim().into(),
        subject: plan.subject.trim().into(),
        after: plan.after.trim().into(),
        before: plan.before.trim().into(),
        unread: plan.unread,
        source: if plan.source == "local-model" { "local-model" } else { "rules" }.into(),
    }
}

/// An IMAP quoted string. CR/LF cannot be quoted, so they become spaces.
fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' | '\\' => {
                out.push('\\');
                out.push(character);
            }
            '\r' | '\n' | '\0' => out.push(' '),
            _ => out.push(character),
        }
    }
    out.push('"');
    out
}

fn imap_date(value: &str) -> Option<String> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    Some(format!("{}-{}-{}", date.day(), MONTHS[date.month0() as usize], date.year()))
}

fn or_tree(alternatives: &[String]) -> String {
    match alternatives {
        [] => "ALL".into(),
        [only] => only.clone(),
        [first, last] => format!("OR {first} {last}"),
        [first, rest @ ..] => format!("OR {first} ({})", or_tree(rest)),
    }
}

/// The `UID SEARCH` arguments for a normalized plan: any term in subject,
/// sender, recipient or body, narrowed by sender, subject, dates and unread.
pub fn search_criteria(plan: &SearchPlan) -> String {
    let mut alternatives = Vec::new();
    for term in plan.terms.iter().map(|term| term.trim()).filter(|term| !term.is_empty()).take(8) {
        for key in ["SUBJECT", "FROM", "TO", "BODY"] {
            alternatives.push(format!("{key} {}", quote(term)));
        }
    }
    let mut parts = vec![or_tree(&alternatives)];
    if !plan.from.is_empty() {
        parts.push(format!("FROM {}", quote(plan.from.trim())));
    }
    if !plan.subject.is_empty() {
        parts.push(format!("SUBJECT {}", quote(plan.subject.trim())));
    }
    // The Node version built a local-midnight Date and imapflow printed its UTC
    // day, which shifted the day east of UTC; the plan's own date is meant.
    if let Some(date) = (!plan.after.is_empty()).then(|| imap_date(&plan.after)).flatten() {
        parts.push(format!("SINCE {date}"));
    }
    if let Some(date) = (!plan.before.is_empty()).then(|| imap_date(&plan.before)).flatten() {
        parts.push(format!("BEFORE {date}"));
    }
    match plan.unread {
        Some(true) => parts.push("UNSEEN".into()),
        Some(false) => parts.push("SEEN".into()),
        None => {}
    }
    let criteria = parts.join(" ");
    if criteria.is_ascii() { criteria } else { format!("CHARSET UTF-8 {criteria}") }
}

fn field<'a>(thread: &'a Value, key: &str) -> &'a str {
    thread.get(key).and_then(Value::as_str).unwrap_or("")
}

fn timestamp(thread: &Value) -> f64 {
    thread.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0)
}

/// Local relevance for a result row; no mail is shown to a model.
pub fn score(thread: &Value, plan: &SearchPlan) -> f64 {
    let haystack =
        format!("{} {} {}", field(thread, "subject"), field(thread, "from"), field(thread, "to")).to_lowercase();
    let matches: f64 = [plan.from.as_str(), plan.subject.as_str()]
        .into_iter()
        .chain(plan.terms.iter().map(String::as_str))
        .map(str::to_lowercase)
        .filter(|term| !term.is_empty())
        .map(|term| if haystack.contains(&term) { 12.0 } else { 0.0 })
        .sum();
    let subject = field(thread, "subject").to_lowercase();
    let boost = if plan.terms.iter().any(|term| subject.contains(&term.to_lowercase())) { 8.0 } else { 0.0 };
    matches + boost + (timestamp(thread) / 1e13).clamp(0.0, 6.0)
}

/// Best match first, then newest.
pub fn rank(threads: &mut [Value], plan: &SearchPlan) {
    threads.sort_by(|left, right| {
        score(right, plan)
            .partial_cmp(&score(left, plan))
            .unwrap_or(Ordering::Equal)
            .then_with(|| timestamp(right).partial_cmp(&timestamp(left)).unwrap_or(Ordering::Equal))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use habibi_core::services::{CompletionResult, LlmState};
    use serde_json::json;
    use std::sync::Mutex;

    struct FakeLlm {
        provider: &'static str,
        reply: &'static str,
        calls: Mutex<Vec<CompletionRequest>>,
    }

    #[async_trait]
    impl Llm for FakeLlm {
        async fn state(&self) -> LlmState {
            LlmState { configured: true, provider: Some(self.provider.into()) }
        }
        async fn complete(&self, request: CompletionRequest) -> CompletionResult {
            self.calls.lock().unwrap().push(request);
            CompletionResult { ok: true, text: Some(self.reply.into()), ..Default::default() }
        }
    }

    #[tokio::test]
    async fn a_hosted_model_never_sees_the_query() {
        let llm = FakeLlm { provider: "openai", reply: "{}", calls: Mutex::new(vec![]) };
        let plan = mail_search_plan(&llm, "  invoice from a acme ").await;
        assert_eq!(plan.terms, vec!["invoice", "from", "acme"]);
        assert_eq!(plan.source, "rules");
        assert!(llm.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_local_model_plan_is_validated() {
        let llm = FakeLlm {
            provider: "ollama",
            reply: "```json\n{\"terms\":[\"invoice\",\"x\",\" acme \"],\"from\":\"bob@example.com\",\"after\":\"2025-01-02\",\"before\":\"soon\",\"unread\":true}\n```",
            calls: Mutex::new(vec![]),
        };
        let plan = mail_search_plan(&llm, "unread invoices from bob since jan 2").await;
        assert_eq!(plan.terms, vec!["invoice", "acme"]);
        assert_eq!(plan.from, "bob@example.com");
        assert_eq!(plan.after, "2025-01-02");
        assert_eq!(plan.before, "");
        assert_eq!(plan.unread, Some(true));
        assert_eq!(plan.source, "local-model");
        let calls = llm.calls.lock().unwrap();
        assert!(calls[0].system_prompt.as_deref().unwrap().contains("read-only IMAP search plan"));
        assert_eq!(calls[0].messages[0].text, "unread invoices from bob since jan 2");
    }

    #[tokio::test]
    async fn unparseable_model_output_falls_back_to_words() {
        let llm = FakeLlm { provider: "lmstudio", reply: "sure! here you go", calls: Mutex::new(vec![]) };
        let plan = mail_search_plan(&llm, "budget review").await;
        assert_eq!(plan.terms, vec!["budget", "review"]);
        assert_eq!(plan.source, "rules");
    }

    #[test]
    fn criteria_are_quoted_and_combined() {
        let plan = SearchPlan {
            terms: vec!["a\"b".into(), "c".into()],
            from: "x@y.z".into(),
            subject: String::new(),
            after: "2025-01-02".into(),
            before: "2025-13-40".into(),
            unread: Some(false),
            source: "rules".into(),
        };
        assert_eq!(
            search_criteria(&plan),
            "OR SUBJECT \"a\\\"b\" (OR FROM \"a\\\"b\" (OR TO \"a\\\"b\" (OR BODY \"a\\\"b\" (OR SUBJECT \"c\" (OR FROM \"c\" (OR TO \"c\" BODY \"c\")))))) FROM \"x@y.z\" SINCE 2-Jan-2025 SEEN"
        );
        let empty = SearchPlan {
            terms: vec![],
            unread: None,
            after: String::new(),
            before: String::new(),
            from: String::new(),
            ..plan.clone()
        };
        assert_eq!(search_criteria(&empty), "ALL");
        let unicode = SearchPlan { terms: vec!["café".into()], ..empty };
        assert!(search_criteria(&unicode).starts_with("CHARSET UTF-8 OR SUBJECT \"café\""));
    }

    #[test]
    fn subject_hits_rank_first() {
        let plan = SearchPlan { terms: vec!["invoice".into()], ..normalize(&mail_plan_rules()) };
        let mut rows = vec![
            json!({ "subject": "Hello", "from": "a@b.c", "timestamp": 2000 }),
            json!({ "subject": "Invoice 12", "from": "a@b.c", "timestamp": 1000 }),
        ];
        rank(&mut rows, &plan);
        assert_eq!(rows[0]["subject"], "Invoice 12");
    }

    fn mail_plan_rules() -> SearchPlan {
        SearchPlan {
            terms: vec![],
            from: String::new(),
            subject: String::new(),
            after: String::new(),
            before: String::new(),
            unread: None,
            source: "other".into(),
        }
    }

    #[test]
    fn normalizing_trims_and_limits() {
        let plan = SearchPlan { terms: (0..10).map(|n| format!(" t{n} ")).collect(), ..mail_plan_rules() };
        let normalized = normalize(&plan);
        assert_eq!(normalized.terms.len(), 8);
        assert_eq!(normalized.terms[0], "t0");
        assert_eq!(normalized.source, "rules");
    }
}
