//! Read-only adapter for the local Codex and Claude Code transcript stores.
//! This module owns their on-disk formats; Habibi only consumes its
//! normalized session and transcript contracts. It deliberately never writes
//! either store. Ported from `src/plugins/agent-sessions/index.js`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};

use crate::util::{collapse_whitespace, iso_from_system_time, js_date_parse, utf16_slice};

const MAX_SESSIONS: usize = 160;
const MAX_TRANSCRIPT_LINES: usize = 700;

pub fn safe_id(value: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"(?i)^[0-9a-f-]{16,80}$").expect("valid pattern"))
        .is_match(value)
}

fn trim(value: &str, max: usize) -> String {
    utf16_slice(collapse_whitespace(value).trim(), max)
}

fn string(value: Option<&Value>) -> String {
    habibi_core::api::text(value)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub updated_at: String,
    #[serde(skip)]
    file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptEntry {
    pub role: String,
    pub text: String,
    pub at: String,
}

fn walk(directory: &Path, include: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    fn visit(folder: &Path, include: &dyn Fn(&Path) -> bool, found: &mut Vec<PathBuf>) {
        if found.len() >= MAX_SESSIONS {
            return;
        }
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if found.len() >= MAX_SESSIONS {
                break;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let file = entry.path();
            if kind.is_dir() {
                visit(&file, include, found);
            } else if kind.is_file() && include(&file) {
                found.push(file);
            }
        }
    }
    let mut found = Vec::new();
    visit(directory, include, &mut found);
    found
}

fn json_lines(file: &Path, max: usize) -> Vec<Value> {
    let Ok(raw) = std::fs::read(file) else {
        return Vec::new();
    };
    let raw = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = raw.split('\n').collect();
    let skip = lines.len().saturating_sub(max);
    lines
        .into_iter()
        .skip(skip)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn first_json_line(file: &Path) -> Value {
    std::fs::read(file)
        .ok()
        .and_then(|raw| {
            String::from_utf8_lossy(&raw)
                .split('\n')
                .next()
                .and_then(|line| serde_json::from_str(line).ok())
        })
        .unwrap_or_else(|| json!({}))
}

fn text_from_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => trim(text, 900),
        Some(Value::Array(items)) => {
            let parts: Vec<String> = items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    _ => {
                        let text = string(item.get("text"));
                        if text.is_empty() {
                            string(item.get("content"))
                        } else {
                            text
                        }
                    }
                })
                .filter(|text| !text.is_empty())
                .collect();
            trim(&parts.join("\n"), 900)
        }
        _ => String::new(),
    }
}

fn readable(prompt: &str) -> String {
    static IMAGE: OnceLock<Regex> = OnceLock::new();
    let image =
        IMAGE.get_or_init(|| Regex::new(r"(?i)^(?:<image|\[image)").expect("valid pattern"));
    if image.is_match(prompt) {
        String::new()
    } else {
        prompt.to_string()
    }
}

fn modified(file: &Path) -> Option<String> {
    std::fs::metadata(file)
        .ok()?
        .modified()
        .ok()
        .map(iso_from_system_time)
}

fn codex_session(file: &Path) -> Option<Session> {
    static UUID: OnceLock<Regex> = OnceLock::new();
    let lines = json_lines(file, 90);
    let meta = lines
        .iter()
        .find(|line| line.get("type").and_then(Value::as_str) == Some("session_meta"))
        .and_then(|line| line.get("payload"))
        .filter(|payload| !payload.is_null())
        .cloned()
        .or_else(|| first_json_line(file).get("payload").cloned())
        .unwrap_or_else(|| json!({}));
    let mut id = string(meta.get("id"));
    if id.is_empty() {
        let uuid = UUID.get_or_init(|| {
            Regex::new(r"(?i)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})").expect("valid pattern")
        });
        id = uuid
            .captures(&crate::util::base_name(file))
            .map(|c| c[1].to_string())
            .unwrap_or_default();
    }
    if !safe_id(&id) {
        return None;
    }
    let prompts: Vec<String> = lines
        .iter()
        .filter(|line| {
            line.get("type").and_then(Value::as_str) == Some("response_item")
                && line.pointer("/payload/type").and_then(Value::as_str) == Some("message")
                && line.pointer("/payload/role").and_then(Value::as_str) == Some("user")
        })
        .map(|line| text_from_content(line.pointer("/payload/content")))
        .filter(|text| !text.is_empty())
        .collect();
    let prompt = readable(prompts.last().map(String::as_str).unwrap_or(""));
    Some(Session {
        id,
        kind: "codex",
        title: if prompt.is_empty() {
            "Codex session".into()
        } else {
            prompt.clone()
        },
        preview: if prompt.is_empty() {
            "Local Codex transcript".into()
        } else {
            prompt
        },
        cwd: string(meta.get("cwd")),
        updated_at: modified(file)?,
        file: file.to_path_buf(),
    })
}

fn claude_session(file: &Path) -> Option<Session> {
    let lines: Vec<Value> = json_lines(file, 90)
        .into_iter()
        .filter(|line| !line.get("isSidechain").is_some_and(truthy))
        .collect();
    let first = lines
        .iter()
        .map(|line| string(line.get("sessionId")))
        .find(|id| safe_id(id));
    let id = first.unwrap_or_else(|| {
        file.file_name()
            .map(|n| n.to_string_lossy().trim_end_matches(".jsonl").to_string())
            .unwrap_or_default()
    });
    if !safe_id(&id) {
        return None;
    }
    let prompts: Vec<String> = lines
        .iter()
        .filter(|line| line.get("type").and_then(Value::as_str) == Some("user"))
        .map(|line| text_from_content(line.pointer("/message/content")))
        .filter(|text| !text.is_empty())
        .collect();
    let cwd = lines
        .iter()
        .rev()
        .map(|line| string(line.get("cwd")))
        .find(|cwd| !cwd.is_empty())
        .unwrap_or_default();
    let prompt = readable(prompts.last().map(String::as_str).unwrap_or(""));
    Some(Session {
        id,
        kind: "claude",
        title: if prompt.is_empty() {
            "Claude Code session".into()
        } else {
            prompt.clone()
        },
        preview: if prompt.is_empty() {
            "Local Claude transcript".into()
        } else {
            prompt
        },
        cwd,
        updated_at: modified(file)?,
        file: file.to_path_buf(),
    })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn transcript(session: &Session) -> Vec<TranscriptEntry> {
    let at = |line: &Value| string(line.get("timestamp"));
    let entries: Vec<TranscriptEntry> = json_lines(&session.file, MAX_TRANSCRIPT_LINES)
        .iter()
        .filter_map(|line| {
            let kind = line.get("type").and_then(Value::as_str);
            if session.kind == "codex" {
                let payload_type = line.pointer("/payload/type").and_then(Value::as_str);
                if kind == Some("response_item") && payload_type == Some("message") {
                    let role = line
                        .pointer("/payload/role")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if role == "user" || role == "assistant" {
                        let text = text_from_content(line.pointer("/payload/content"));
                        if !text.is_empty() {
                            return Some(TranscriptEntry {
                                role: role.into(),
                                text,
                                at: at(line),
                            });
                        }
                    }
                }
                if kind == Some("response_item") && payload_type == Some("function_call") {
                    let name = string(line.pointer("/payload/name"));
                    let arguments = trim(&string(line.pointer("/payload/arguments")), 240);
                    let name = if name.is_empty() {
                        "Tool".to_string()
                    } else {
                        name
                    };
                    return Some(TranscriptEntry {
                        role: "tool".into(),
                        text: format!("{name} {arguments}"),
                        at: at(line),
                    });
                }
                return None;
            }
            if line.get("isSidechain").is_some_and(truthy)
                || !matches!(kind, Some("user" | "assistant"))
            {
                return None;
            }
            let text = text_from_content(line.pointer("/message/content"));
            (!text.is_empty()).then(|| TranscriptEntry {
                role: kind.unwrap_or_default().into(),
                text,
                at: at(line),
            })
        })
        .collect();
    let skip = entries.len().saturating_sub(MAX_TRANSCRIPT_LINES);
    entries.into_iter().skip(skip).collect()
}

pub struct AgentSessions {
    home: PathBuf,
}

impl AgentSessions {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
        }
    }

    fn all(&self) -> Vec<Session> {
        let jsonl = |file: &Path| file.to_string_lossy().ends_with(".jsonl");
        let codex = walk(&self.home.join(".codex").join("sessions"), &jsonl)
            .into_iter()
            .filter_map(|file| codex_session(&file));
        let claude = walk(
            &self.home.join(".claude").join("projects"),
            &|file: &Path| {
                jsonl(file)
                    && !file
                        .components()
                        .any(|part| part.as_os_str() == "subagents")
            },
        )
        .into_iter()
        .filter_map(|file| claude_session(&file));
        let mut sessions: Vec<Session> = codex.chain(claude).collect();
        sessions.sort_by_key(|session| {
            std::cmp::Reverse(js_date_parse(&session.updated_at).unwrap_or(0))
        });
        sessions.truncate(MAX_SESSIONS);
        sessions
    }

    /// `{ ok: true, sessions }` filtered by kind and a text query.
    pub fn list(&self, kind: &str, query: &str) -> Value {
        let kind = if kind == "codex" || kind == "claude" {
            kind
        } else {
            ""
        };
        let needle = trim(query, 180).to_lowercase();
        let sessions: Vec<Session> = self
            .all()
            .into_iter()
            .filter(|session| {
                (kind.is_empty() || session.kind == kind)
                    && (needle.is_empty()
                        || format!("{} {} {}", session.title, session.preview, session.cwd)
                            .to_lowercase()
                            .contains(&needle))
            })
            .collect();
        json!({ "ok": true, "sessions": sessions })
    }

    pub fn detail(&self, id: &str, kind: &str) -> Value {
        if !safe_id(id) || !["codex", "claude"].contains(&kind) {
            return json!({ "ok": false, "error": "That local agent session is not available." });
        }
        let Some(session) = self
            .all()
            .into_iter()
            .find(|item| item.id == id && item.kind == kind)
        else {
            return json!({ "ok": false, "error": "That session is no longer available locally." });
        };
        json!({ "ok": true, "session": session, "transcript": transcript(&session) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_read_only_normalized_and_filtered() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex/sessions/2026/11/12");
        std::fs::create_dir_all(&codex).unwrap();
        let codex_id = "0199aaaa-bbbb-cccc-dddd-eeeeffff0000";
        std::fs::write(
            codex.join(format!("rollout-{codex_id}.jsonl")),
            [
                json!({ "type": "session_meta", "payload": { "id": codex_id, "cwd": "/work/app" } }).to_string(),
                json!({ "type": "response_item", "timestamp": "t1", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Fix   the build" }] } }).to_string(),
                json!({ "type": "response_item", "timestamp": "t2", "payload": { "type": "function_call", "name": "shell", "arguments": "{\"cmd\":\"ls\"}" } }).to_string(),
                "not json".into(),
            ]
            .join("\n"),
        )
        .unwrap();
        let claude = home.path().join(".claude/projects/-work-site");
        std::fs::create_dir_all(claude.join("subagents")).unwrap();
        let claude_id = "11111111-2222-3333-4444-555555555555";
        std::fs::write(
            claude.join(format!("{claude_id}.jsonl")),
            [
                json!({ "type": "user", "sessionId": claude_id, "cwd": "/work/site", "message": { "content": "Write docs" } }).to_string(),
                json!({ "type": "assistant", "sessionId": claude_id, "message": { "content": [{ "type": "text", "text": "Done" }] } }).to_string(),
                json!({ "type": "user", "isSidechain": true, "message": { "content": "hidden" } }).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        std::fs::write(
            claude.join("subagents/22222222-2222-3333-4444-555555555555.jsonl"),
            "{}",
        )
        .unwrap();
        let sessions = AgentSessions::new(home.path());
        let all = sessions.list("", "");
        assert_eq!(all["sessions"].as_array().unwrap().len(), 2);
        let codex_only = sessions.list("codex", "build");
        assert_eq!(codex_only["sessions"][0]["title"], "Fix the build");
        assert_eq!(codex_only["sessions"][0]["cwd"], "/work/app");
        assert!(codex_only["sessions"][0].get("file").is_none());
        assert_eq!(
            sessions.list("claude", "docs")["sessions"][0]["cwd"],
            "/work/site"
        );
        let detail = sessions.detail(codex_id, "codex");
        assert_eq!(
            detail["transcript"][1],
            json!({ "role": "tool", "text": "shell {\"cmd\":\"ls\"}", "at": "t2" })
        );
        let detail = sessions.detail(claude_id, "claude");
        assert_eq!(detail["transcript"].as_array().unwrap().len(), 2);
        assert_eq!(sessions.detail("../etc", "codex")["ok"], false);
        assert_eq!(
            sessions.detail(claude_id, "codex")["error"],
            "That session is no longer available locally."
        );
    }
}
