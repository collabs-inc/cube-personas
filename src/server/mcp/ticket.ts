// Adapted from cube-computer: src/main/cubed/mcp/ticket.ts
//
// A persona's bearer credential for POST /mcp. Derived rather than stored,
// from the app's state `secret`. Bound to the persona's current launch as
// well as its id, so respawning a persona revokes the ticket its previous
// adapter held. JSON array encoding keeps field boundaries unambiguous.
import { createHmac, timingSafeEqual } from "node:crypto";

const LABEL = "cube-personas.mcp.v1";

export function deriveTicket(secret: Buffer, personaId: string, launchId: string): string {
  return createHmac("sha256", secret)
    .update(`${LABEL}\n${JSON.stringify([personaId, launchId])}`)
    .digest("hex");
}

export function verifyTicket(secret: Buffer, personaId: string, launchId: string, ticket: string): boolean {
  const expected = Buffer.from(deriveTicket(secret, personaId, launchId), "utf8");
  const given = Buffer.from(ticket, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
