//! Local, single-use approvals.
//!
//! A token is bound to one action AND to the exact payload it was issued for,
//! so a token minted for one request cannot authorize a different one. Tokens
//! expire quickly and are spent on every attempt, matched or not, so a caller
//! cannot probe a still-valid token with different payloads.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// Actions the UI may request a token for. Anything else is refused at issue.
pub const APPROVABLE_ACTIONS: &[&str] = &[
    "file-tools.preview",
    "file-tools.apply",
    "file-tools.undo",
    "browser.open",
    "whatsapp.send",
    "mail.send",
    "calendar.create",
    "calendar.update",
    "reminders.create",
    "reminders.complete",
    "agent-skill.execute",
    "running-app.quit",
    "running-app.force",
    "system.sleep",
    "system.restart",
    "system.shutdown",
    "system.lock",
    "system.darkMode",
    "system.emptyTrash",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub token: String,
    pub action: String,
    /// Milliseconds since the Unix epoch, as the UI expects.
    pub expires_at: u64,
}

struct Pending {
    action: String,
    expires_at: u64,
    payload: Value,
}

pub struct ApprovalService {
    ttl: Duration,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Default for ApprovalService {
    fn default() -> Self {
        Self::new(Duration::from_secs(120))
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl ApprovalService {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, pending: Mutex::new(HashMap::new()) }
    }

    pub fn is_approvable(action: &str) -> bool {
        APPROVABLE_ACTIONS.contains(&action)
    }

    /// Mint a token for `action` bound to `payload` (`Value::Null` when absent).
    pub fn issue(&self, action: &str, payload: Value) -> Approval {
        let now = now_ms();
        let expires_at = now + self.ttl.as_millis() as u64;
        let token = uuid::Uuid::new_v4().to_string();
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.retain(|_, approval| approval.expires_at >= now);
        pending.insert(token.clone(), Pending { action: action.into(), expires_at, payload });
        Approval { token, action: action.into(), expires_at }
    }

    /// Spend `token`. True only for the same action and an equal payload.
    /// The payload is always re-derived by the consuming route from its own
    /// request body; the caller never supplies the value it is checked against.
    pub fn consume(&self, token: Option<&str>, action: &str, payload: &Value) -> bool {
        let Some(token) = token.filter(|token| !token.is_empty()) else { return false };
        let approval = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(token);
        match approval {
            Some(approval) => {
                approval.action == action && approval.expires_at >= now_ms() && approval.payload == *payload
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_token_authorizes_exactly_its_action_and_payload_once() {
        let approvals = ApprovalService::default();
        let approval = approvals.issue("mail.send", json!({ "to": "a", "n": [1, 2] }));
        // Key order does not matter.
        assert!(approvals.consume(Some(&approval.token), "mail.send", &json!({ "n": [1, 2], "to": "a" })));
        assert!(!approvals.consume(Some(&approval.token), "mail.send", &json!({ "to": "a", "n": [1, 2] })));
    }

    #[test]
    fn a_mismatched_attempt_spends_the_token() {
        let approvals = ApprovalService::default();
        let approval = approvals.issue("mail.send", json!({ "to": "a" }));
        assert!(!approvals.consume(Some(&approval.token), "mail.send", &json!({ "to": "b" })));
        assert!(!approvals.consume(Some(&approval.token), "mail.send", &json!({ "to": "a" })));
    }

    #[test]
    fn wrong_action_missing_token_and_expiry_are_refused() {
        let approvals = ApprovalService::default();
        let approval = approvals.issue("system.lock", json!({ "action": "lock" }));
        assert!(!approvals.consume(Some(&approval.token), "system.sleep", &json!({ "action": "lock" })));
        assert!(!approvals.consume(None, "system.lock", &json!({ "action": "lock" })));
        let short = ApprovalService::new(Duration::from_millis(0));
        let approval = short.issue("system.lock", Value::Null);
        std::thread::sleep(Duration::from_millis(5));
        assert!(!short.consume(Some(&approval.token), "system.lock", &Value::Null));
    }

    #[test]
    fn only_known_actions_are_approvable() {
        assert!(ApprovalService::is_approvable("whatsapp.send"));
        assert!(!ApprovalService::is_approvable("shell.exec"));
    }
}
