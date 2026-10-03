import "./theme.css";
import { useTheme } from "./use-theme";
import { PersonaApp } from "./persona/PersonaApp";

/** The page: the theme applies to every screen, the empty state included. */
export function App() {
  useTheme();
  return <PersonaApp />;
}
