export interface ToolCall {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  /**
   * Redeems the approval for this tool call, returning true only when a real
   * single-use approval was spent. This is a function rather than a token
   * string on purpose: a bare string would let any non-empty value pass the
   * gate, so the caller must prove the approval was actually verified.
   */
  redeemApproval?: (name: string) => boolean;
}

export type ToolPolicyDecision =
  { decision: 'allow' } | { decision: 'require_confirmation'; reason: string };

/**
 * The policy decision is deterministic and independent from the model. An MCP
 * tool cannot bypass confirmation by describing an action as a read.
 */
export function evaluateToolCall({
  name,
  redeemApproval,
}: ToolCall): ToolPolicyDecision {
  if (!redeemApproval?.(name))
    return {
      decision: 'require_confirmation',
      reason: `${name} needs an explicit Habibi approval.`,
    };
  return { decision: 'allow' };
}

export function asHabibiToolName(serverId: string, toolName: string): string {
  return `mcp__${String(serverId).replace(/[^a-z0-9_]/gi, '_')}__${String(toolName).replace(/[^a-z0-9_]/gi, '_')}`;
}
