// Adapted from cube-computer: src/windows/app/src/items/agent/file-attachments.ts
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { bytesToBase64 } from "./image-paste";
import { resourceLinkForCandidate } from "./composer-logic";
import type { AgentFilePayload } from "../../shared/agent-protocol";

/** The largest file one attachment may carry. */
const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

/** Stash bytes on the owning machine; never send a client-local path to a cloud agent. */
export async function uploadAttachment(
  file: File,
  upload: (payload: AgentFilePayload) => Promise<{ path: string }>,
): Promise<Extract<ContentBlock, { type: "resource_link" }>> {
  if (file.size > MAX_TRANSFER_BYTES) throw new Error(`${file.name} is over the 50 MB upload limit.`);
  const { path } = await upload({
    contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    mime: file.type || "application/octet-stream",
    filename: file.name,
  });
  const resource = resourceLinkForCandidate({ name: file.name, path });
  if (!resource) throw new Error("The upload did not return a usable file path.");
  return { ...resource, title: file.name, mimeType: file.type || "application/octet-stream" };
}
