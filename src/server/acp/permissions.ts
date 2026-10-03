// Adapted from cube-computer: src/main/cubed/acp/permissions.ts
//
// First-answer-wins, in one place: every answer to a question the adapter
// asked claims its request id here before it is written to the adapter.
export type AnswerOutcome = "answered" | "lost-race" | "stale";

export interface PermissionClaimView {
  answered: Set<string | number>;
  pending: Set<string | number>;
}

export function claimPermission(view: PermissionClaimView, requestId: string | number): AnswerOutcome {
  if (view.answered.has(requestId)) return "lost-race";
  if (!view.pending.has(requestId)) return "stale";
  view.answered.add(requestId);
  return "answered";
}
