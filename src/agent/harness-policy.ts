const WRITE_VERBS = /(?:send|create|update|delete|write|schedule|modify|archive|invite|pay|purchase)/i;

export interface ToolCall {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  approvalToken?: string;
}

export type ToolPolicyDecision =
  | { decision:'allow' }
  | { decision:'require_confirmation'; reason:string };

/**
 * The policy decision is deterministic and independent from the model. An MCP
 * tool cannot bypass the gate by describing a write as a read.
 */
export function evaluateToolCall({ name, annotations = {}, approvalToken }: ToolCall): ToolPolicyDecision {
  const isWrite = annotations.readOnlyHint === false || WRITE_VERBS.test(name);
  if (!isWrite) return { decision:'allow' };
  if (!approvalToken) return { decision:'require_confirmation', reason:`${name} needs an explicit Habibi approval.` };
  return { decision:'allow' };
}

export function asHabibiToolName(serverId: string, toolName: string): string {
  return `mcp__${String(serverId).replace(/[^a-z0-9_]/gi, '_')}__${String(toolName).replace(/[^a-z0-9_]/gi, '_')}`;
}
