// Adapted from cube-computer: src/windows/app/src/items/agent/file-attachments.test.ts
import { expect, test } from "vitest";
import { uploadAttachment } from "../../../src/web/agent/file-attachments";

test("uploads arbitrary binary bytes and uses the returned machine-native path", async () => {
  const file = new File([new Uint8Array([0, 255, 128])], "my data.bin");
  const block = await uploadAttachment(file, async payload => {
    expect(payload).toEqual({ contentBase64: "AP+A", mime: "application/octet-stream", filename: "my data.bin" });
    return { path: "/projects/.cube/drops/unique/my data.bin" };
  });
  expect(block.type).toBe("resource_link");
  expect(block.uri).toBe("file:///projects/.cube/drops/unique/my%20data.bin");
  expect(block.name).toBe("my data.bin");
});

test("refuses oversized files before reading or uploading", async () => {
  const file = new File([], "huge.zip");
  Object.defineProperty(file, "size", { value: 51 * 1024 * 1024 });
  await expect(uploadAttachment(file, async () => { throw new Error("should not upload"); })).rejects.toThrow("50 MB");
});
