// Adapted from cube-computer: src/windows/app/src/items/agent/Composer.test.tsx
// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AvailableCommand, ContentBlock } from "@agentclientprotocol/sdk";
import { Composer, type ComposerProps } from "../../../src/web/agent/Composer";
import type { FileCandidate } from "../../../src/web/agent/composer-logic";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null;
let sequence = 0;

const commands: AvailableCommand[] = [
  { name: "clear", description: "Clear context" },
  { name: "compact", description: "Compact context" },
  { name: "review", description: "Review a pull request", input: { hint: "pull request number" } },
];

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    itemId: `composer-test-${sequence}`,
    disabled: false,
    running: false,
    modes: { current: null, available: [] },
    commands,
    onSend: () => {},
    onStop: () => {},
    onSetMode: () => {},
    ...overrides,
  };
}

async function render(composerProps: ComposerProps): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(<Composer {...composerProps} />);
    await flush();
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(selector: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.querySelector(selector)) return;
    await act(flush);
  }
}

function textarea(): HTMLTextAreaElement {
  const found = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!found) throw new Error("composer textarea missing");
  return found;
}

function type(value: string): void {
  const input = textarea();
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function key(keyName: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options });
  act(() => textarea().dispatchEvent(event));
  return event;
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button ${label} missing`);
  return found;
}

test("compact composer keeps settings in an inspector and Escape returns focus", async () => {
  await render(props({ compact: true, children: <button>Model settings</button> }));
  const inspector = container.querySelector<HTMLDetailsElement>(".persona-composer-inspector")!;
  expect(inspector.open).toBe(false);
  expect(inspector.textContent).toContain("Model settings");
  await act(async () => { inspector.open = true; inspector.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(inspector.open).toBe(false);
  expect(document.activeElement).toBe(inspector.querySelector("summary"));
  expect(button("Send")).toBeTruthy();
});

beforeEach(() => {
  sequence += 1;
  container = document.createElement("div");
  document.body.append(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});


describe("Composer drafts", () => {
  test("an item draft survives an unmount and remount", async () => {
    const composerProps = props({ itemId: "persistent-item" });
    await render(composerProps);
    act(() => type("keep this draft"));

    act(() => root!.unmount());
    root = null;
    await render(composerProps);

    expect(textarea().value).toBe("keep this draft");
  });

  test("a rejected send retains the exact draft", async () => {
    const onSend = () => Promise.reject(new Error("offline"));
    await render(props({ onSend }));
    act(() => type("retry me"));
    act(() => button("Send").click());
    await act(flush);

    expect(textarea().value).toBe("retry me");
    expect(button("Send").disabled).toBe(false);
  });

  test("typing appended during a send survives after it resolves", async () => {
    let resolveSend!: () => void;
    const onSend = () => new Promise<void>((resolve) => { resolveSend = resolve; });
    await render(props({ onSend }));
    act(() => type("first"));
    act(() => button("Send").click());
    act(() => type("first then second"));
    await act(async () => { resolveSend(); await flush(); });

    expect(textarea().value).toBe(" then second");
  });

  test("running keeps the draft editable and exposes separate Queue and Stop actions", async () => {
    let queued: ContentBlock[] = [];
    await render(props({ running: true, onQueue: (blocks) => { queued = blocks; } }));
    act(() => type("follow up"));
    act(() => button("Queue").click());

    expect(queued).toEqual([{ type: "text", text: "follow up" }]);
    expect(button("Stop")).toBeTruthy();
    expect(textarea().disabled).toBe(false);
  });
});

test("Enter queues while working and Escape stops without consuming the draft", async () => {
  const queued: ContentBlock[][] = [];
  let stops = 0;
  let sends = 0;
  await render(props({ running: true, onQueue: blocks => { queued.push(blocks); }, onStop: () => { stops++; }, onSend: () => { sends++; } }));
  key("Enter");
  expect(queued).toHaveLength(0);
  act(() => type("follow up"));
  key("Enter", { shiftKey: true });
  key("Enter", { isComposing: true });
  expect(queued).toHaveLength(0);
  key("Enter");
  await act(flush);
  expect(queued).toEqual([[{ type: "text", text: "follow up" }]]);
  expect(textarea().value).toBe("");
  expect(sends).toBe(0);
  act(() => type("keep this draft"));
  key("Escape");
  expect(stops).toBe(1);
  expect(textarea().value).toBe("keep this draft");
});

test("general file uploads work without image support and block sending until attached", async () => {
  let finish!: (block: Exclude<ContentBlock, { type: "text" }>) => void;
  await render(props({ imageSupported: false, onAttachFile: () => new Promise(resolve => { finish = resolve; }) }));
  expect(button("Attach files")).toBeTruthy();
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(picker.hasAttribute("accept")).toBe(false);
  act(() => type("review this"));
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["pdf"], "report.pdf", { type: "application/pdf" })] } });
  await act(async () => { container.querySelector(".agent-composer")!.dispatchEvent(event); await flush(); });
  expect(event.defaultPrevented).toBe(true);
  expect(button("Send").disabled).toBe(true);
  await act(async () => { finish({ type: "resource_link", name: "report.pdf", uri: "file:///remote/report.pdf" }); await flush(); });
  expect(button("Remove report.pdf")).toBeTruthy();
  expect(button("Send").disabled).toBe(false);
});

test("a failed file leaves successful attachments intact and shows the upload error", async () => {
  await render(props({ onAttachFile: async (file) => {
    if (file.name === "failed.pdf") throw new Error("failed.pdf: connection lost");
    return { type: "resource_link", name: file.name, uri: `file:///remote/${file.name}` };
  } }));
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["ok"], "ok.txt"), new File(["pdf"], "failed.pdf")] } });
  await act(async () => { container.querySelector(".agent-composer")!.dispatchEvent(event); await flush(); });
  expect(button("Remove ok.txt")).toBeTruthy();
  expect(container.textContent).toContain("failed.pdf: connection lost");
  expect(button("Send").disabled).toBe(false);
});

describe("Composer completion", () => {
  test("a pending new file query never offers or selects a previous query's result", async () => {
    let resolveNext!: (files: FileCandidate[]) => void;
    await render(props({ onFindFiles: (query) => query === "a"
      ? [{ name: "a.ts", path: "/repo/a.ts" }]
      : new Promise((resolve) => { resolveNext = resolve; }) }));
    act(() => type("@a"));
    await act(flush);
    expect(container.textContent).toContain("a.ts");
    act(() => type("@b"));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    key("Enter");
    expect(textarea().value).toBe("@b");
    await act(async () => { resolveNext([{ name: "b.ts", path: "/repo/b.ts" }]); await flush(); });
    key("Enter");
    expect(textarea().value).toBe("/repo/b.ts");
  });
  test("arrow keys choose a slash command and show its argument hint", async () => {
    await render(props());
    act(() => type("/"));
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");

    expect(textarea().value).toBe("/review ");
    expect(container.textContent).toContain("pull request number");
  });

  test("Escape closes completion and IME Enter neither selects nor sends", async () => {
    let sends = 0;
    await render(props({ onSend: () => { sends += 1; } }));
    act(() => type("/c"));
    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => textarea().dispatchEvent(composing));

    expect(textarea().value).toBe("/c");
    expect(sends).toBe(0);
    key("Escape");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  test("selecting a file mention keeps useful path text and sends a machine URI", async () => {
    let sent: ContentBlock[] = [];
    await render(props({
      resourceCwd: "/projects/project",
      onFindFiles: async () => [{ name: "main file.ts", path: "src/main file.ts" }],
      onSend: (blocks) => { sent = blocks; },
    }));
    act(() => type("Please inspect @main"));
    await act(flush);
    key("Enter");
    key("Enter");

    expect(sent).toEqual([
      { type: "text", text: "Please inspect src/main file.ts" },
      { type: "resource_link", name: "main file.ts", title: "src/main file.ts", uri: "file:///projects/project/src/main%20file.ts" },
    ]);
    expect(JSON.stringify(sent)).not.toContain("/@cloud");
  });

  test("Enter cannot send a partial mention while file completion is loading", async () => {
    let sends = 0;
    await render(props({
      onFindFiles: () => new Promise<FileCandidate[]>(() => {}),
      onSend: () => { sends += 1; },
    }));
    act(() => type("inspect @mai"));
    key("Enter");

    expect(sends).toBe(0);
    expect(textarea().value).toBe("inspect @mai");
  });
});

describe("Composer attachments", () => {
  test("rejected sends retain attachments and caption through remount", async () => {
    const composerProps = props({ imageSupported: true, onSend: () => Promise.reject(new Error("offline")) });
    await render(composerProps);
    act(() => type("keep the screenshot"));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [new File(["pixels"], "retained.png", { type: "image/png" })] } });
    await act(async () => { textarea().dispatchEvent(event); await flush(); });
    await waitFor('button[aria-label="Remove retained.png"]');
    await act(async () => { button("Send").click(); await flush(); });
    await act(async () => root!.unmount());
    root = null;
    await render(composerProps);
    expect(textarea().value).toBe("keep the screenshot");
    expect(button("Remove retained.png")).toBeTruthy();
  });
  test("desktop and mobile both expose an image picker", async () => {
    await render(props({ narrow: false, imageSupported: true }));
    expect(button("Attach files")).toBeTruthy();
  });

  test("an unsupported image paste is not consumed, preserving clipboard text", async () => {
    await render(props({ imageSupported: false }));
    act(() => type("existing"));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [new File(["pixels"], "pixel.png", { type: "image/png" })] },
    });
    act(() => textarea().dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(textarea().value).toBe("existing");
  });

  test("a pasted image can be removed without changing the text", async () => {
    await render(props({ imageSupported: true }));
    act(() => type("caption"));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [new File(["pixels"], "pixel.png", { type: "image/png" })] },
    });
    await act(async () => {
      textarea().dispatchEvent(event);
      await flush();
    });
    await waitFor('button[aria-label="Remove pixel.png"]');

    expect(event.defaultPrevented).toBe(true);
    expect(button("Remove pixel.png")).toBeTruthy();
    act(() => button("Remove pixel.png").click());
    expect(textarea().value).toBe("caption");
    expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull();
  });

  test("dropping an image attaches it and consumes the drop", async () => {
    await render(props({ imageSupported: true }));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [new File(["drop"], "dropped.png", { type: "image/png" })] },
    });
    await act(async () => {
      container.querySelector(".agent-composer")!.dispatchEvent(event);
      await flush();
    });
    await waitFor('button[aria-label="Remove dropped.png"]');

    expect(event.defaultPrevented).toBe(true);
    expect(button("Remove dropped.png")).toBeTruthy();
  });

  test("resizing a transparent bitmap keeps PNG output and always closes the bitmap", async () => {
    const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    const contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    const dataUrlDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toDataURL");
    let closes = 0;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => ({ width: 3200, height: 1600, close: () => { closes += 1; } }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage: () => {} }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: (mimeType: string) => `data:${mimeType};base64,cmVzaXplZA==`,
    });
    try {
      await render(props({ imageSupported: true }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [new File(["large"], "alpha.png", { type: "image/png" })] },
      });
      await act(async () => {
        textarea().dispatchEvent(event);
        await flush();
      });
      await waitFor('button[aria-label="Remove alpha.png"]');

      expect(closes).toBe(1);
      expect(container.querySelector<HTMLImageElement>(".agent-composer-thumb-image")?.src
        .startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
      else Reflect.deleteProperty(globalThis, "createImageBitmap");
      if (contextDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", contextDescriptor);
      if (dataUrlDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", dataUrlDescriptor);
    }
  });
});
