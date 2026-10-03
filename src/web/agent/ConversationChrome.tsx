// Adapted from cube-computer: src/windows/app/src/items/agent/ConversationChrome.tsx
import { createContext, useState, type PointerEventHandler, type ReactNode, type RefCallback } from "react";

/** The pane owns the header's position; the conversation owns its contents.
 * Canvas supplies its existing DOM host through the same context. */
export const ConversationHeaderContext = createContext<{
  host: HTMLElement | null;
  onPointerDown?: PointerEventHandler | undefined;
} | null>(null);

export function ConversationChrome({ children, onPointerDown }: {
  children: (headerRef: RefCallback<HTMLDivElement>) => ReactNode;
  onPointerDown?: PointerEventHandler | undefined;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <ConversationHeaderContext.Provider value={{ host, onPointerDown }}>{children(setHost)}</ConversationHeaderContext.Provider>;
}
