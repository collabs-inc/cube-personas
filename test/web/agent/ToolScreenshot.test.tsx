// Adapted from cube-computer: src/windows/app/src/items/agent/ToolScreenshot.test.tsx
// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolScreenshot } from "../../../src/web/agent/ToolScreenshot";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null;
beforeEach(() => {
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  container = document.createElement("div"); document.body.appendChild(container);
});
afterEach(() => { act(() => root?.unmount()); root = null; container.remove(); });

async function mount(load: (path: string) => Promise<{ url: string; width: number; height: number }>, open: (path: string) => void) {
  root = createRoot(container);
  await act(async () => {
    root!.render(<ToolScreenshot reference={{ nativePath: "/native/shot.png", rendererPath: "/renderer/shot.png" }} load={load} onOpenPath={open} />);
    await Promise.resolve(); await Promise.resolve();
  });
}

test("loads lazily, opens the native path, and remounting obtains a fresh URL", async () => {
  const loaded: string[] = [];
  const opened: string[] = [];
  let ticket = 0;
  const load = async (path: string) => { loaded.push(path); return { url: `blob:ticket-${++ticket}`, width: 1280, height: 800 }; };
  await mount(load, path => opened.push(path));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:ticket-1");
  await act(async () => { container.querySelector("button")!.click(); });
  expect(opened).toEqual(["/native/shot.png"]);
  act(() => root!.unmount()); root = null;
  await mount(load, path => opened.push(path));
  expect(loaded).toEqual(["/renderer/shot.png", "/renderer/shot.png"]);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:ticket-2");
});

test("keeps a missing screenshot retryable", async () => {
  let attempts = 0;
  await mount(async () => { attempts += 1; throw new Error("missing"); }, () => {});
  expect(container.textContent).toContain("Screenshot no longer available");
  expect(container.textContent).toContain("shot.png");
  await act(async () => { container.querySelector<HTMLButtonElement>(".agent-tool-screenshot-retry")!.click(); await Promise.resolve(); });
  expect(attempts).toBe(2);
  expect(container.querySelector(".agent-tool-screenshot" )).not.toBeNull();
});

test("an expired image URL shows Retry and mints a new ticket", async () => {
  let tickets = 0;
  await mount(async () => ({ url: `https://machine.test/file?token=${++tickets}`, width: 0, height: 0 }), () => {});
  await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
  expect(container.textContent).toContain("Screenshot no longer available");
  await act(async () => { container.querySelector<HTMLButtonElement>(".agent-tool-screenshot-retry")!.click(); });
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://machine.test/file?token=2");
});
