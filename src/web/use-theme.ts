// The page's light/dark theme. Cube's `theme.css` keys its dark tokens on a
// `dark` class on <html>; this hook is the one place that sets it.
//
// `?theme=light|dark` in the page's URL wins (Cube passes its own theme when it
// shows the app in a pane); without it the page follows the browser's
// `prefers-color-scheme`, live.
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const QUERY = "(prefers-color-scheme: dark)";

function requestedTheme(): Theme | null {
  const value = new URLSearchParams(window.location.search).get("theme");
  return value === "light" || value === "dark" ? value : null;
}

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  return requestedTheme() ?? systemTheme();
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    const update = (): void => setTheme(currentTheme());
    update();
    if (requestedTheme() !== null || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(QUERY);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => apply(theme), [theme]);

  return theme;
}

/**
 * The theme the page is showing, read back from the `dark` class `useTheme`
 * maintains — for a component that needs to know the theme without being the
 * one that decides it (Cube's `useAppTheme`).
 */
export function useDocumentTheme(): Theme {
  const read = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setTheme(read());
    return () => observer.disconnect();
  }, []);
  return theme;
}
