// Adapted from cube-computer: src/main/cubed/acp/prompt-admission.ts
//
// One reservation for every prompt on a session, whatever its origin: a
// human's from the page, or the server's own wake. A wake that passes an
// idle check microseconds before a human's prompt must not send both, or a
// response would clear state belonging to a turn still outstanding.
export type AdmissionState = "ready" | "handshaking" | "busy" | "dead";
export type Admission = { ok: true } | { ok: false; reason: Exclude<AdmissionState, "ready"> };
export interface AdmissionView { state: AdmissionState }

export function admitPrompt(view: AdmissionView): Admission {
  return view.state === "ready" ? { ok: true } : { ok: false, reason: view.state };
}
