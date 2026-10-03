/** An http(s) or mailto link from the conversation, in a new tab that cannot reach back into this page. */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
