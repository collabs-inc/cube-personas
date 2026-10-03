import { expect, test } from "vitest";
import { ARTIFACT_INSTRUCTION, PERSONA_INSTRUCTION, WORKER_PROMPT_PREFIX, personaArtifactInstruction } from "../../src/server/instructions";

test("the persona instruction names the six tools and none of Cube's removed ones", () => {
  for (const tool of ["list_repos", "spawn_agent", "list_agents", "check_agent", "send_to_agent", "stop_agent"]) {
    expect(PERSONA_INSTRUCTION).toContain(tool);
  }
  for (const gone of ["operationId", "list_pending_permissions", "answer_permission", "claim_artifact", "add_repo", "clone_repo", "create_worktree", "events", "checks in"]) {
    expect(PERSONA_INSTRUCTION).not.toContain(gone);
  }
  expect(PERSONA_INSTRUCTION).toContain("A retried spawn_agent can start a second worker");
});

test("the worker prompt prefix is Cube's, verbatim", () => {
  expect(WORKER_PROMPT_PREFIX).toBe(
    "You are a Cube worker. Commits and pushes on your own branch are yours to make. Worktree creation and removal, merges, pull requests and deploys belong to the persona that owns you: report the need instead of doing it yourself.",
  );
});

test("workers put artifacts at the checkout root; a persona at its context folder", () => {
  expect(ARTIFACT_INSTRUCTION).toContain("at the root of the checkout you are working in");
  const persona = personaArtifactInstruction("/home/u/.cube/personas/p-1");
  expect(persona).toContain("at the root of your context folder, /home/u/.cube/personas/p-1");
  expect(persona).not.toContain("checkout you are working in");
});
