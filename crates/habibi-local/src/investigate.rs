//! The local file investigation agent (`/api/agent/files/investigate`):
//! plan filename searches, search the index, then rank candidates. Prompts
//! and parsing are ported from `planFileInvestigation` / `rankFileCandidates`
//! in `src/server/services/llm-service.js`.
//!
//! Personal filenames and conversation context are only sent to a model
//! running on this computer (Ollama, LM Studio). A hosted provider never
//! receives them; without a local model a keyword fallback plans the search.

use std::collections::HashSet;
use std::sync::OnceLock;

use habibi_core::services::{ChatMessage, CompletionRequest, Llm};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::files::FileResult;
use crate::util::utf16_slice;

const PLANNER_PROMPT: &str = r#"You are Habibi's private local file-investigation agent. Decide from the conversation whether the user wants Habibi to find local files. Return JSON only: {"phase":"not_applicable"|"clarify"|"search","question":"...","queries":["..."]}. Return not_applicable for ordinary questions or tasks that are not about finding local files. For a vague local-file request, ask exactly one focused clarification in the user's language. A broad category alone is not enough to search: when the user has supplied no discriminating detail such as a date, issuer, country, person, project, document phrase, or filename fragment, return clarify. Once you have enough context, return search with 1-3 short filename/topic queries. Do not use conversational filler in queries, do not invent names, and never claim you found a file. The next agent step will search filenames locally."#;

const RANKER_PROMPT: &str = r#"You are Habibi's local file-investigation reviewer. Rank the provided local filename candidates against the user's request. Return JSON only: {"ids":["exact candidate id",...],"summary":"short factual sentence"}. Rank only supplied ids. Do not invent file contents or claim certainty. If none looks relevant, return an empty ids list and ask for one useful refinement in summary."#;

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    NotApplicable,
    Clarify(String),
    Search(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Ranking {
    pub ids: Vec<String>,
    /// `None` when the ranker did not run (no local model or it failed).
    pub summary: Option<String>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// The conversation as the route accepts it: user/assistant turns with text,
/// the last 8, each at most 1200 characters.
pub fn history(value: Option<&Value>) -> Vec<ChatMessage> {
    let Some(Value::Array(turns)) = value else {
        return Vec::new();
    };
    let valid: Vec<ChatMessage> = turns
        .iter()
        .filter_map(|turn| {
            let role = turn.get("role")?.as_str()?;
            let text = turn.get("text")?.as_str()?;
            ["user", "assistant"].contains(&role).then(|| ChatMessage {
                role: role.into(),
                text: utf16_slice(text, 1200),
            })
        })
        .collect();
    let skip = valid.len().saturating_sub(8);
    valid.into_iter().skip(skip).collect()
}

pub fn latest_user_text(history: &[ChatMessage]) -> String {
    history
        .iter()
        .rev()
        .find(|turn| turn.role == "user")
        .map(|turn| turn.text.clone())
        .unwrap_or_default()
}

async fn local_model(llm: &dyn Llm) -> bool {
    let state = llm.state().await;
    state.configured && matches!(state.provider.as_deref(), Some("ollama" | "lmstudio"))
}

/// `JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim())`.
fn parse_model_json(text: &str) -> Option<Value> {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    let cleaned = regex(&FENCE, r"^```json\s*|\s*```$").replace_all(text, "");
    serde_json::from_str(cleaned.trim()).ok()
}

/// Keyword plan from the most recent user turn that has usable words.
fn contextual_fallback(history: &[ChatMessage]) -> Option<Plan> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    static ASKS: OnceLock<Regex> = OnceLock::new();
    const STOP: &[&str] = &[
        "give",
        "show",
        "find",
        "search",
        "locate",
        "open",
        "me",
        "my",
        "the",
        "a",
        "an",
        "ones",
        "one",
        "from",
        "last",
        "night",
        "yesterday",
        "today",
        "latest",
        "recent",
        "newest",
        "did",
        "i",
        "please",
        "file",
        "files",
        "folder",
        "folders",
    ];
    let turns: Vec<&str> = history
        .iter()
        .filter(|turn| turn.role == "user")
        .map(|turn| turn.text.as_str())
        .collect();
    let token = regex(&TOKEN, r"[a-z0-9][a-z0-9_-]+");
    let query = turns.iter().rev().find_map(|text| {
        let lower = text.to_lowercase();
        let words: Vec<String> = token
            .find_iter(&lower)
            .map(|m| m.as_str())
            .filter(|token| !STOP.contains(token))
            .map(|token| {
                if token.len() > 4 && token.ends_with('s') {
                    token[..token.len() - 1].to_string()
                } else {
                    token.to_string()
                }
            })
            .filter(|token| token.len() >= 3)
            .collect();
        (!words.is_empty()).then(|| words.join(" "))
    });
    let asks = regex(&ASKS, r"(?i)\b(?:find|search|show|give|locate|open|latest|recent|yesterday|last night|files?|folders?)\b").is_match(&turns.join(" "));
    match (asks, query) {
        (true, Some(query)) => Some(Plan::Search(vec![query])),
        _ => None,
    }
}

pub async fn plan_file_investigation(llm: &dyn Llm, history: &[ChatMessage]) -> Plan {
    static EXPLICIT: OnceLock<Regex> = OnceLock::new();
    static OTHER: OnceLock<Regex> = OnceLock::new();
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    static YEAR: OnceLock<Regex> = OnceLock::new();
    static LITERAL: OnceLock<Regex> = OnceLock::new();
    let latest = latest_user_text(history);
    let explicit_file = regex(
        &EXPLICIT,
        r"(?i)\b(?:local|downloaded|saved|files?|documents?|attachments?|pdfs?|photos?|images?|screenshots?)\b|\.(?:pdf|docx?|xlsx?|pptx?|csv|md|txt|png|jpe?g)\b",
    )
    .is_match(&latest);
    if regex(&OTHER, r"(?i)\b(?:websites?|webpage|homepage|urls?|https?|airbnb|whatsapp|inbox|emails?|calendar)\b").is_match(&latest) && !explicit_file {
        return Plan::NotApplicable;
    }
    let fallback = || contextual_fallback(history).unwrap_or(Plan::NotApplicable);
    if !local_model(llm).await {
        return fallback();
    }
    let result = llm
        .complete(CompletionRequest {
            system_prompt: Some(PLANNER_PROMPT.into()),
            messages: history.to_vec(),
            ..Default::default()
        })
        .await;
    if !result.ok {
        return fallback();
    }
    let Some(plan) = parse_model_json(result.text.as_deref().unwrap_or("")) else {
        return fallback();
    };
    if plan.is_null() {
        return fallback();
    }
    let phase = plan.get("phase").and_then(Value::as_str);
    if phase == Some("not_applicable") {
        return Plan::NotApplicable;
    }
    if phase == Some("search")
        && let Some(queries) = plan.get("queries").and_then(Value::as_array)
    {
        let planned: Vec<String> = queries
            .iter()
            .map(|query| {
                let query = habibi_core::api::text(Some(query));
                let query = regex(&UNSAFE, r"[^a-zA-Z0-9 ._\-]")
                    .replace_all(&query, "")
                    .trim()
                    .to_string();
                // A planner may never create a year/date that was not supplied
                // by the user. Preserve ordinary query expansion, but strip
                // invented four-digit years from its tool input.
                let query = regex(&YEAR, r"\b(?:19|20)\d{2}\b").replace_all(
                    &query,
                    |captures: &regex::Captures| {
                        let year = &captures[0];
                        if latest.contains(year) {
                            year.to_string()
                        } else {
                            String::new()
                        }
                    },
                );
                query.split_whitespace().collect::<Vec<_>>().join(" ")
            })
            .filter(|query| query.chars().count() >= 2)
            .collect();
        // Acronyms and compact identifiers are strong filename evidence. The
        // runner probes them verbatim alongside the agent's semantic queries.
        let literal = regex(&LITERAL, r"\b[A-Z][A-Z0-9_-]+\b")
            .find_iter(&latest)
            .map(|m| m.as_str().trim().to_string());
        let mut seen = HashSet::new();
        let combined: Vec<String> = literal
            .chain(planned)
            .filter(|query| seen.insert(query.to_lowercase()))
            .take(3)
            .collect();
        if !combined.is_empty() {
            return Plan::Search(combined);
        }
    }
    let question = utf16_slice(habibi_core::api::text(plan.get("question")).trim(), 320);
    if question.is_empty() {
        fallback()
    } else {
        Plan::Clarify(question)
    }
}

#[derive(Serialize)]
struct CandidatePrompt<'a> {
    id: &'a str,
    name: &'a str,
    folder: &'a str,
    directory: &'a str,
}

pub async fn rank_file_candidates(
    llm: &dyn Llm,
    history: &[ChatMessage],
    candidates: &[FileResult],
) -> Ranking {
    if candidates.is_empty() {
        return Ranking {
            ids: Vec::new(),
            summary: Some(String::new()),
        };
    }
    let unranked = || Ranking {
        ids: candidates.iter().map(|file| file.path.clone()).collect(),
        summary: None,
    };
    if !local_model(llm).await {
        return unranked();
    }
    let prompt: Vec<CandidatePrompt> = candidates
        .iter()
        .take(18)
        .map(|file| CandidatePrompt {
            id: &file.path,
            name: &file.name,
            folder: &file.folder,
            directory: &file.directory,
        })
        .collect();
    let mut messages = history.to_vec();
    messages.push(ChatMessage {
        role: "user".into(),
        text: format!(
            "Candidates to review locally:\n{}",
            serde_json::to_string(&prompt).unwrap_or_else(|_| "[]".into())
        ),
    });
    let result = llm
        .complete(CompletionRequest {
            system_prompt: Some(RANKER_PROMPT.into()),
            messages,
            ..Default::default()
        })
        .await;
    if !result.ok {
        return unranked();
    }
    let Some(ranked) =
        parse_model_json(result.text.as_deref().unwrap_or("")).filter(|value| !value.is_null())
    else {
        return unranked();
    };
    let allowed: HashSet<&str> = candidates.iter().map(|file| file.path.as_str()).collect();
    let ids = match ranked.get("ids") {
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| habibi_core::api::text(Some(id)))
            .filter(|id| allowed.contains(id.as_str()))
            .take(8)
            .collect(),
        _ => Vec::new(),
    };
    let summary = utf16_slice(habibi_core::api::text(ranked.get("summary")).trim(), 300);
    Ranking {
        ids,
        summary: Some(summary),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use async_trait::async_trait;
    use habibi_core::services::{CompletionResult, LlmState};
    use std::sync::Mutex;

    /// A model that answers from a queue and records prompts.
    pub struct FakeLlm {
        pub provider: Option<&'static str>,
        pub answers: Mutex<Vec<String>>,
        pub prompts: Mutex<Vec<CompletionRequest>>,
    }

    impl FakeLlm {
        pub fn new(provider: Option<&'static str>, answers: &[&str]) -> Self {
            Self {
                provider,
                answers: Mutex::new(answers.iter().rev().map(|a| a.to_string()).collect()),
                prompts: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl Llm for FakeLlm {
        async fn state(&self) -> LlmState {
            LlmState {
                configured: self.provider.is_some(),
                provider: self.provider.map(str::to_string),
            }
        }

        async fn complete(&self, request: CompletionRequest) -> CompletionResult {
            self.prompts.lock().unwrap().push(request);
            match self.answers.lock().unwrap().pop() {
                Some(text) => CompletionResult {
                    ok: true,
                    text: Some(text),
                    ..Default::default()
                },
                None => CompletionResult {
                    ok: false,
                    error: Some("no answer".into()),
                    ..Default::default()
                },
            }
        }
    }

    fn user(text: &str) -> Vec<ChatMessage> {
        vec![ChatMessage {
            role: "user".into(),
            text: text.into(),
        }]
    }

    #[tokio::test]
    async fn hosted_models_never_see_filenames_and_the_fallback_plans_keywords() {
        let llm = FakeLlm::new(Some("openai"), &["{}"]);
        assert_eq!(
            plan_file_investigation(&llm, &user("find my passport scans")).await,
            Plan::Search(vec!["passport scan".into()])
        );
        assert!(llm.prompts.lock().unwrap().is_empty());
        assert_eq!(
            plan_file_investigation(&llm, &user("open the airbnb website")).await,
            Plan::NotApplicable
        );
        assert_eq!(
            plan_file_investigation(&llm, &user("what is the capital of peru")).await,
            Plan::NotApplicable
        );
    }

    #[tokio::test]
    async fn local_plans_strip_invented_years_and_probe_acronyms() {
        let llm = FakeLlm::new(
            Some("ollama"),
            &[
                "```json\n{\"phase\":\"search\",\"queries\":[\"tax return 2023\",\"w2 form!\"]}\n```",
            ],
        );
        let plan = plan_file_investigation(&llm, &user("find my IRS documents")).await;
        assert_eq!(
            plan,
            Plan::Search(vec!["IRS".into(), "tax return".into(), "w2 form".into()])
        );
        let llm = FakeLlm::new(
            Some("lmstudio"),
            &[r#"{"phase":"clarify","question":"Which year?"}"#],
        );
        assert_eq!(
            plan_file_investigation(&llm, &user("find my tax files")).await,
            Plan::Clarify("Which year?".into())
        );
    }

    #[tokio::test]
    async fn rankings_only_keep_supplied_ids() {
        let file = |path: &str| FileResult {
            path: path.into(),
            name: "n".into(),
            folder: "Home".into(),
            directory: "~".into(),
            score: 1,
            file_timestamp: 0,
        };
        let candidates = [file("/a"), file("/b")];
        let llm = FakeLlm::new(
            Some("ollama"),
            &[r#"{"ids":["/b","/etc/passwd"],"summary":" Found it. "}"#],
        );
        let ranking = rank_file_candidates(&llm, &user("find b"), &candidates).await;
        assert_eq!(
            ranking,
            Ranking {
                ids: vec!["/b".into()],
                summary: Some("Found it.".into())
            }
        );
        let prompt = llm.prompts.lock().unwrap()[0]
            .messages
            .last()
            .unwrap()
            .text
            .clone();
        assert!(prompt.contains(r#"[{"id":"/a","name":"n","folder":"Home","directory":"~"}"#));
        let hosted = FakeLlm::new(None, &[]);
        assert_eq!(
            rank_file_candidates(&hosted, &[], &candidates).await.ids,
            ["/a", "/b"]
        );
    }

    #[test]
    fn history_is_bounded_and_typed() {
        let turns: Vec<Value> = (0..10)
            .map(|i| serde_json::json!({ "role": "user", "text": format!("t{i}") }))
            .collect();
        let mut turns = turns;
        turns.push(serde_json::json!({ "role": "system", "text": "x" }));
        turns.push(serde_json::json!({ "role": "user", "text": 5 }));
        let history = history(Some(&Value::Array(turns)));
        assert_eq!(history.len(), 8);
        assert_eq!(history[0].text, "t2");
    }
}
