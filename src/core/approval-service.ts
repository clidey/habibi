import crypto from 'node:crypto';

export interface Approval {
  token: string;
  action: string;
  expiresAt: number;
}

export interface ApprovalRequest {
  token?: string;
  action: string;
}

export interface ApprovalService {
  issue(action: string): Approval;
  consume(request: ApprovalRequest): boolean;
}

/** Local, single-use approvals. A token is bound to one action and expires quickly. */
export function createApprovalService({ ttlMs = 2 * 60_000 }: { ttlMs?: number } = {}): ApprovalService {
  const pending = new Map<string, Approval>();
  const issue = (action: string): Approval => {
    const token = crypto.randomUUID();
    const approval = Object.freeze({ token, action, expiresAt:Date.now() + ttlMs });
    pending.set(token, approval);
    return approval;
  };
  const consume = ({ token, action }: ApprovalRequest): boolean => {
    if (!token) return false;
    const approval = pending.get(token);
    // A token is spent on every attempt: callers cannot brute-force an action
    // against a still-valid token after a mismatched request.
    pending.delete(token);
    return Boolean(approval && approval.action === action && approval.expiresAt >= Date.now());
  };
  return { issue, consume };
}
