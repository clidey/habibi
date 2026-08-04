import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export interface Approval {
  token: string;
  action: string;
  expiresAt: number;
}

export interface ApprovalRequest {
  token?: string;
  action: string;
  payload?: unknown;
}

export interface ApprovalService {
  issue(action: string, payload?: unknown): Approval;
  consume(request: ApprovalRequest): boolean;
}

/**
 * Local, single-use approvals. A token is bound to one action AND to the exact
 * payload it was issued for, so a token minted for one request cannot authorize
 * a different one. Tokens expire quickly.
 *
 * Token generation uses `crypto.randomUUID` and payload comparison uses
 * `util.isDeepStrictEqual`, which is key-order independent and type-strict.
 * Neither the randomness nor the comparison is implemented here.
 */
export function createApprovalService({ ttlMs = 2 * 60_000 }: { ttlMs?: number } = {}): ApprovalService {
  const pending = new Map<string, Approval & { payload: unknown }>();
  const sweep = (now: number): void => {
    for (const [token, approval] of pending) if (approval.expiresAt < now) pending.delete(token);
  };
  const issue = (action: string, payload?: unknown): Approval => {
    const now = Date.now();
    sweep(now);
    const token = crypto.randomUUID();
    const record = Object.freeze({ token, action, expiresAt:now + ttlMs, payload });
    pending.set(token, record);
    return { token, action, expiresAt:record.expiresAt };
  };
  const consume = ({ token, action, payload }: ApprovalRequest): boolean => {
    if (!token) return false;
    const approval = pending.get(token);
    // A token is spent on every attempt: callers cannot brute-force an action
    // or a payload against a still-valid token after a mismatched request.
    pending.delete(token);
    if (!approval || approval.action !== action || approval.expiresAt < Date.now()) return false;
    // Always compared against the consuming request's own body. The caller
    // never supplies the value this is checked against.
    return isDeepStrictEqual(approval.payload, payload);
  };
  return { issue, consume };
}
