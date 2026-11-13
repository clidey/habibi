//! Habibi's tool policy. Every built-in and MCP tool call the agent loop makes
//! is evaluated here before it executes.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPolicyDecision {
    Allow,
    RequireConfirmation { reason: String },
}

impl ToolPolicyDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// The decision is deterministic and independent from the model. A tool —
/// including an MCP tool that describes itself as read-only — cannot bypass
/// confirmation, so tool annotations are deliberately not an input here.
///
/// `redeem_approval` redeems the approval for this call and returns true only
/// when a real single-use approval was spent. It is a verifier rather than a
/// token string on purpose: a bare string would let any non-empty value pass
/// the gate, so the caller must prove the approval was actually checked.
pub fn evaluate_tool_call(name: &str, redeem_approval: Option<&(dyn Fn(&str) -> bool + Sync)>) -> ToolPolicyDecision {
    match redeem_approval {
        Some(redeem) if redeem(name) => ToolPolicyDecision::Allow,
        _ => ToolPolicyDecision::RequireConfirmation { reason: format!("{name} needs an explicit Habibi approval.") },
    }
}

fn namespace_part(value: &str) -> String {
    // `/[^a-z0-9_]/gi` replaced each UTF-16 unit, so a character outside the
    // basic plane became two underscores; keep names identical.
    value
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || c == '_';
            let count = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, count)
        })
        .collect()
}

/// MCP tool names are namespaced before registration so they never collide
/// with built-in skills: `mcp__<server>__<tool>`.
pub fn as_habibi_tool_name(server_id: &str, tool_name: &str) -> String {
    format!("mcp__{}__{}", namespace_part(server_id), namespace_part(tool_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_requires_real_user_approval_for_every_tool_including_reads_and_compression() {
        let approve = |_: &str| true;
        let refuse = |_: &str| false;
        for name in ["whatsapp_search_chats", "compress", "pdf_merge", "open_folder", "unknown_tool"] {
            // Annotations are not an input: a read-only hint never allows a call.
            assert!(!evaluate_tool_call(name, None).is_allowed());
            assert!(!evaluate_tool_call(name, Some(&refuse)).is_allowed());
            assert_eq!(evaluate_tool_call(name, Some(&approve)), ToolPolicyDecision::Allow);
        }
        assert!(!evaluate_tool_call("whatsapp_send_message", None).is_allowed());
        assert!(evaluate_tool_call("calendar_create_event", Some(&approve)).is_allowed());
        // A write is only allowed when the approval was actually redeemed.
        assert_eq!(
            evaluate_tool_call("calendar_create_event", Some(&refuse)),
            ToolPolicyDecision::RequireConfirmation {
                reason: "calendar_create_event needs an explicit Habibi approval.".into()
            }
        );
    }

    #[test]
    fn the_verifier_sees_the_tool_name() {
        let only_reads = |name: &str| name == "search";
        assert!(evaluate_tool_call("search", Some(&only_reads)).is_allowed());
        assert!(!evaluate_tool_call("send", Some(&only_reads)).is_allowed());
    }

    #[test]
    fn mcp_tools_receive_a_stable_namespaced_habibi_name() {
        assert_eq!(as_habibi_tool_name("Google Calendar", "create-event"), "mcp__Google_Calendar__create_event");
        assert_eq!(as_habibi_tool_name("a😀", "é"), "mcp__a_____");
    }
}
