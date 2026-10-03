// Adapted from cube-computer: src/windows/app/src/items/agent/AgentRendering.test.tsx
// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { AgentMarkdown, highlightAgentCode } from "../../../src/web/agent/AgentMarkdown";
import { AgentContent } from "../../../src/web/agent/AgentContent";
import { PermissionCard } from "../../../src/web/agent/PermissionCard";
import { ToolCallView } from "../../../src/web/agent/ToolCallView";
import { TurnView } from "../../../src/web/agent/TurnView";
import { ConversationChrome } from "../../../src/web/agent/ConversationChrome";
import { ConversationToolbar } from "../../../src/web/agent/ConversationToolbar";
import type { PendingPermission, ToolCallState, Turn } from "../../../src/web/agent/transcript";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container.remove();
  document.documentElement.classList.remove("dark");
});


async function render(node: ReactNode): Promise<void> {
  root = createRoot(container);
  await act(async () => root!.render(node));
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function toolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolCallId: "tool-1",
    title: "Update parser",
    kind: "edit",
    status: "completed",
    content: [],
    locations: [],
    ...overrides,
  };
}

describe("AgentMarkdown", () => {
  test("inline file references open paths without linking code examples or nesting links", async () => {
    const opened: string[] = [];
    await render(<AgentMarkdown content={[
      "See `src/main/instructions.ts`, `agent-instructions.ts`, `~/.cube/persona.md`, and `/repo/file.ts:127`.",
      "Keep `PERSONA_AGENT_INSTRUCTION`, `git status`, and `<dataDir>/persona.md` as code.",
      "[`README.md`](./README.md)",
      "```\nsrc/example.ts\n```",
    ].join("\n\n")} onOpenPath={path => opened.push(path)} />);
    const links = [...container.querySelectorAll(".agent-markdown-path-link")];
    expect(links.map(link => link.textContent)).toEqual([
      "src/main/instructions.ts", "agent-instructions.ts", "~/.cube/persona.md", "/repo/file.ts:127", "README.md",
    ]);
    expect(container.querySelector("a a")).toBeNull();
    expect(container.querySelector(".agent-code-pre .agent-markdown-path-link")).toBeNull();
    for (const link of links) await click(link);
    expect(opened).toEqual([
      "src/main/instructions.ts", "agent-instructions.ts", "~/.cube/persona.md", "/repo/file.ts:127", "./README.md",
    ]);
  });

  test("renders GFM and only routes safe external links through the supplied opener", async () => {
    const opened: string[] = [];
    const openedPaths: string[] = [];
    await render(
      <AgentMarkdown
        content={[
          "~~old~~",
          "",
          "| file | result |",
          "| --- | --- |",
          "| a.ts | pass |",
          "",
          "[Docs](https://example.com/docs) [File](file:///repo/parser.ts) [Unsafe](javascript:alert(1))",
        ].join("\n")}
        onOpenExternal={(url) => opened.push(url)}
        onOpenPath={(path) => openedPaths.push(path)}
      />,
    );

    expect(container.querySelector("del")?.textContent).toBe("old");
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(1);
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.querySelector(".agent-markdown-link-disabled")?.textContent).toBe("Unsafe");
    expect(container.querySelector(".agent-markdown-path-link")?.textContent).toBe("File");
    await click(links[0]!);
    await click(container.querySelector(".agent-markdown-path-link")!);
    await click(container.querySelector(".agent-markdown-link-disabled")!);
    expect(opened).toEqual(["https://example.com/docs"]);
    expect(openedPaths).toEqual(["file:///repo/parser.ts"]);
  });

  test("labels fenced code and copies its source without disturbing transcript scrolling", async () => {
    const copied: string[] = [];
    document.documentElement.classList.add("dark");
    await render(
      <AgentMarkdown
        content={"```ts\nconst answer = 42;\n```"}
        onCopy={(text) => void copied.push(text)}
      />,
    );

    expect(container.querySelector(".agent-code-language")?.textContent).toBe("TypeScript");
    const button = container.querySelector<HTMLButtonElement>(".agent-code-copy")!;
    expect(button.getAttribute("aria-label")).toBe("Copy TypeScript code");
    const highlighted = container.querySelector(".agent-code-highlighted");
    expect(highlighted?.getAttribute("data-theme")).toBe("dark");
    expect(highlighted?.innerHTML).toContain("agent-syntax-keyword");
    expect(highlightAgentCode("<script>const unsafe = true</script>", "typescript")).toContain("&lt;script&gt;");
    expect(highlightAgentCode("<script>const unsafe = true</script>", "typescript")).not.toContain("<script>");
    await click(button);
    expect(copied).toEqual(["const answer = 42;\n"]);
  });
});

describe("AgentContent", () => {
  test("renders future content types as an unsupported placeholder instead of throwing", async () => {
    await render(<AgentContent content={{ type: "video", uri: "future://clip" } as unknown as ContentBlock} />);
    expect(container.querySelector(".agent-content-unsupported")?.textContent).toContain("video");
  });

  test("renders a malformed known content type as an unsupported placeholder", async () => {
    await render(<AgentContent content={{ type: "resource" } as unknown as ContentBlock} />);
    expect(container.querySelector(".agent-content-unsupported")?.textContent).toContain("resource");
  });

  test("keeps image, audio, linked resource and embedded text content visible", async () => {
    const openedPaths: string[] = [];
    const blocks: ContentBlock[] = [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      { type: "resource_link", name: "parser.ts", uri: "file:///repo/parser.ts", title: "Parser" },
      {
        type: "resource",
        resource: { uri: "file:///repo/notes.md", mimeType: "text/markdown", text: "**Embedded**" },
      },
    ];
    await render(
      <div>
        {blocks.map((content, index) => (
          <AgentContent key={index} content={content} onOpenPath={(path) => openedPaths.push(path)} />
        ))}
      </div>,
    );

    expect(container.querySelector("img.agent-content-image")?.getAttribute("src")).toContain("data:image/png;base64,");
    expect(container.querySelector("audio")?.getAttribute("src")).toContain("data:audio/wav;base64,");
    expect(container.querySelector(".agent-resource-title")?.textContent).toBe("Parser");
    expect(container.querySelector(".agent-embedded-resource strong")?.textContent).toBe("Embedded");
    await click(container.querySelector(".agent-resource-open")!);
    expect(openedPaths).toEqual(["file:///repo/parser.ts"]);
  });
});

describe("ToolCallView", () => {
  test("renders future tool content as an unsupported placeholder", async () => {
    await render(
      <ToolCallView call={toolCall({ content: [{ type: "chart" }] as unknown as ToolCallState["content"] })} />,
    );
    expect(container.querySelector(".agent-content-unsupported")?.textContent).toContain("chart");
  });

  test("shows locations, bounded raw details and a numbered diff summary", async () => {
    const opened: Array<[string, number | undefined]> = [];
    await render(
      <ToolCallView
        call={toolCall({
          rawInput: { path: "/repo/parser.ts" },
          rawOutput: { ok: true },
          locations: [{ path: "/repo/parser.ts", line: 12 }],
          content: [
            { type: "diff", path: "/repo/parser.ts", oldText: "one\ntwo", newText: "one\nchanged\nthree" },
          ],
        })}
        onOpenPath={(path, line) => opened.push([path, line])}
      />,
    );

    expect(container.querySelector(".agent-diff-counts")?.textContent).toContain("+2");
    expect(container.querySelector(".agent-diff-counts")?.textContent).toContain("−1");
    expect(container.querySelectorAll(".agent-diff-line-number")[0]?.textContent).toBe("1");
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("Output");
    await click(container.querySelector(".agent-tool-location")!);
    expect(opened).toEqual([["/repo/parser.ts", 12]]);
  });

  test("a terminal tool call shows its text output, never a live terminal", async () => {
    await render(
      <ToolCallView
        call={toolCall({ kind: "execute", content: [{ type: "terminal", terminalId: "term-1" }], rawOutput: "built in 2s" })}
      />,
    );
    expect(container.querySelector(".agent-tool-terminal")).toBeNull();
    expect(container.querySelector(".agent-tool-raw[open] .agent-tool-raw-value")?.textContent).toBe("built in 2s");
  });

  test("renders resolved screenshot previews after result content", async () => {
    const originalObserver = globalThis.IntersectionObserver;
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    await render(<ToolCallView
      call={toolCall({ content: [{ type: "content", content: { type: "text", text: "[Screenshot](file:///native/shot.png)" } }] })}
      resolveScreenshot={(path) => ({ nativePath: path, rendererPath: "/renderer/shot.png" })}
      loadScreenshot={async () => ({ url: "blob:shot", width: 100, height: 80 })}
      onOpenPath={() => {}}
    />);
    expect(container.querySelector(".agent-tool-content + .agent-tool-screenshots img")?.getAttribute("src")).toBe("blob:shot");
    globalThis.IntersectionObserver = originalObserver;
  });
});

describe("PermissionCard", () => {
  test("unlocks after a send rejection so the choice can be retried", async () => {
    let attempts = 0;
    const pending: PendingPermission = {
      requestId: "permission-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Run release",
        rawInput: { command: "bun run build" },
        content: [
          { type: "content", content: { type: "text", text: "The command changes build output." } },
          { type: "diff", path: "/repo/package.json", oldText: "old", newText: "new" },
          { type: "terminal", terminalId: "approval-terminal" },
        ],
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    await render(
      <PermissionCard
        pending={pending}
        onChoose={async () => {
          attempts += 1;
          throw new Error("Transport disconnected");
        }}
      />,
    );

    const allow = container.querySelector<HTMLButtonElement>(".agent-permission-allow")!;
    expect(container.textContent).toContain("The command changes build output.");
    expect(container.querySelector(".agent-diff-counts")?.textContent).toContain("+1");
    expect(container.querySelector(".agent-tool-terminal-disclosure")).toBeNull();
    expect(allow.getAttribute("aria-label")).toContain("once");
    await click(allow);
    expect(attempts).toBe(1);
    expect(allow.disabled).toBe(false);
    expect(container.querySelector(".agent-permission-error")?.textContent).toContain("Transport disconnected");
    await click(allow);
    expect(attempts).toBe(2);
  });
});

describe("Conversation header", () => {
  test("shares pane chrome, preserves header drag, and keeps actions out of the drag gesture", async () => {
    let dragged = 0;
    let searched = 0;
    const view = (narrow: boolean) => <ConversationChrome onPointerDown={() => { dragged++; }}>
      {(headerRef) => <>
        {!narrow && <header ref={headerRef} />}
        <div className="test-conversation"><ConversationToolbar name="OpenCode" harness="opencode" title="Fix search" status="Ready" state="idle"
          query="" searchOpen={false} matches={0} matchIndex={0} onSearch={() => {}} onNavigate={() => {}}
          onToggleSearch={() => { searched++; }} onCopy={async () => {}} onExport={() => {}} /></div>
      </>}
    </ConversationChrome>;
    await render(view(false));
    expect(container.querySelector("header .agent-toolbar")).not.toBeNull();
    expect(container.querySelector(".test-conversation .agent-toolbar")).toBeNull();
    await act(async () => { container.querySelector(".agent-conversation-title")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(dragged).toBe(1);
    const search = container.querySelector("[aria-label='Search conversation']")!;
    const actions = container.querySelector<HTMLDetailsElement>(".agent-more")!;
    actions.open = true;
    await act(async () => { search.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(actions.open).toBe(false);
    await click(search);
    expect(dragged).toBe(1);
    expect(searched).toBe(1);
    await act(async () => root!.render(view(true)));
    expect(container.querySelectorAll(".agent-toolbar")).toHaveLength(1);
    expect(container.querySelector(".test-conversation .agent-toolbar")).not.toBeNull();
    await act(async () => { container.querySelector(".agent-conversation-title")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(dragged).toBe(1);
  });
});

describe("TurnView", () => {
  test("does not discover or load screenshots while an activity group is collapsed", async () => {
    let resolves = 0;
    let loads = 0;
    const turn = { id: "screenshots", user: [], blocks: [{ kind: "tool", call: toolCall({
      content: [{ type: "content", content: { type: "text", text: "[Screenshot](file:///native/shot.png)" } }],
    }) }], end: "end_turn" } as Turn;
    await render(<TurnView turn={turn} activity="unconfirmed"
      resolveScreenshot={() => { resolves += 1; return { nativePath: "/native/shot.png", rendererPath: "/renderer/shot.png" }; }}
      loadScreenshot={async () => { loads += 1; return { url: "blob:shot", width: 1, height: 1 }; }}
      onOpenPath={() => {}}
    />);
    expect(container.querySelector(".agent-activity-detail")).toBeNull();
    expect(resolves).toBe(0);
    expect(loads).toBe(0);
  });
  test("a cancelled turn says who stopped it: the person, or Personas stopping", async () => {
    await render(<TurnView turn={{ id: "a", user: [], blocks: [], end: "cancelled" }} activity="interrupted" />);
    expect(container.querySelector(".agent-turn-state")?.textContent).toBe("Stopped by user.");
    await render(<TurnView turn={{ id: "b", user: [], blocks: [], end: "cancelled", interrupted: true }} activity="interrupted" />);
    expect(container.querySelector(".agent-turn-state")?.textContent).toBe("Interrupted: Personas stopped during this turn.");
  });
  test("an interrupted plan retains its progress without a live spinner", async () => {
    await render(<TurnView activity="interrupted" turn={{ id: "plan", user: [], end: "cancelled", blocks: [{ kind: "plan", entries: [
      { content: "Read files", priority: "high", status: "completed" },
      { content: "Run checks", priority: "high", status: "in_progress" },
    ] }] }} />);
    expect(container.querySelector(".agent-plan-spinner") === null).toBe(true);
    expect(container.querySelector(".agent-plan-progress-label")?.textContent).toBe("1/2");
    expect(container.textContent).toContain("Run checks");
  });
  test("keeps an approval-only response inside the bubble and announces waiting instead of working", async () => {
    await render(<TurnView turn={{ id: "approval", user: [], blocks: [], end: null }} activity="live"
      approvals={<button>Allow once</button>} />);
    expect(container.querySelector(".agent-assistant button")?.textContent).toBe("Allow once");
    expect(container.querySelector(".agent-assistant [role='status']")?.textContent).toContain("Waiting for you");
    expect(container.textContent).not.toContain("Working…");
  });
  test("opens folded work when search matches tool output", async () => {
    const turn = {
      id: "turn-search",
      user: [],
      blocks: [{
        kind: "tool",
        call: toolCall({
          rawOutput: `${"x".repeat(30_000)} hidden needle`,
          content: [{ type: "diff", path: "/repo/parser.ts", oldText: "before", newText: "hidden needle" }],
        }),
      }],
      end: "end_turn",
    } as Turn;
    await render(<TurnView turn={turn} activity="unconfirmed" searchQuery="needle" />);
    expect(container.querySelector(".agent-activity-detail")).not.toBeNull();
    expect(container.querySelector(".agent-tool-raw[open]")).not.toBeNull();
    expect(container.querySelector(".agent-tool-raw-value")?.textContent).toContain("needle");
  });

  test("attributes both speakers, renders structured assistant content and states a refusal clearly", async () => {
    const copied: string[] = [];
    const turn = {
      id: "turn-1",
      user: [{ type: "text", text: "Please delete it" }],
      blocks: [
        { kind: "text", text: "I **cannot** do that." },
        { kind: "content", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
        { kind: "content", content: { type: "resource" } as unknown as ContentBlock },
      ],
      end: "refusal",
    } as Turn;
    await render(<TurnView turn={turn} activity="unconfirmed" onCopy={(text) => void copied.push(text)} />);

    expect(container.querySelector("[aria-label='User message']")?.textContent).toContain("Please delete it");
    expect(container.querySelector("[aria-label='Assistant message'] strong")?.textContent).toBe("cannot");
    expect(container.querySelector(".agent-assistant .agent-turn-state")?.textContent).toContain("declined");
    expect(container.querySelector(".agent-assistant .agent-content-image")).not.toBeNull();
    expect(container.querySelector(".agent-assistant .agent-content-unsupported")?.textContent).toContain("resource");
    await click(container.querySelector(".agent-message-copy-assistant")!);
    expect(copied[0]).toContain("I **cannot** do that.");
  });
});
