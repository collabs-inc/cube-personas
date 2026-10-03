/**
 * A failure whose message is one plain sentence fit to show the person or the
 * persona: no path inside the state directory, no ticket, no secret. Any
 * other error reaching a user-facing boundary is logged and replaced with
 * GENERIC_FAILURE.
 */
export class UserFacingError extends Error {
  override name = "UserFacingError";
}

export const GENERIC_FAILURE = "That did not work. Try again.";
export const NO_SUCH_PERSONA = "No such persona.";
export const SHUTTING_DOWN = "Personas is shutting down.";
