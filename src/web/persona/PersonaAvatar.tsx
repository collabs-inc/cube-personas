// Adapted from cube-computer: src/windows/app/src/persona/PersonaAvatar.tsx
//
// Changes: the working and unread states are classes (`persona-avatar-working`,
// `persona-avatar-unread`) rather than data attributes; the seed is the
// persona's id (this app has no separate colour seed).
import type { CSSProperties, ReactNode } from "react";
import "./PersonaAvatar.css";

// Deliberately different color families, rather than rotating the same rainbow.
const PALETTES = [
  ["#df975c", "#527cc2", "#596692", "#bc638b"], // apricot / blue / rose
  ["#4bb8a5", "#9a64bc", "#6263a0", "#df8272"], // teal / violet / coral
  ["#ae7bce", "#4aa596", "#657e91", "#d4ab55"], // orchid / sea glass / ochre
  ["#a4b655", "#a964ab", "#747199", "#559fc2"], // chartreuse / plum / blue
  ["#589fce", "#d18b55", "#997a92", "#b86eac"], // azure / copper / orchid
  ["#d26f91", "#58a89c", "#698c87", "#c3ac53"], // rose / jade / gold
  ["#cba04c", "#746ac1", "#7875a0", "#53ada4"], // amber / indigo / teal
  ["#55b9b0", "#d2779c", "#8772ac", "#8d80cc"], // turquoise / pink / iris
] as const;

/** A stable palette from the persona's id. */
export function personaGradient(seed: string): CSSProperties {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const value = hash >>> 0;
  const [first, second, base, accent] = PALETTES[value % PALETTES.length]!;
  const x = 10 + ((value >>> 8) % 35);
  const y = 10 + ((value >>> 16) % 35);
  const angle = (value >>> 20) % 360;
  return {
    backgroundImage: [
      `radial-gradient(ellipse at ${x}% ${y}%, ${first} 12%, transparent 62%)`,
      `radial-gradient(ellipse at ${100 - x}% ${y}%, ${accent} 10%, transparent 60%)`,
      `radial-gradient(ellipse at ${100 - y}% ${100 - x}%, ${second} 15%, transparent 65%)`,
      `linear-gradient(${angle}deg, ${second}, ${base})`,
    ].join(", "),
  };
}

export function PersonaAvatar({ seed, working, unread = false, badge }: {
  seed: string; working: boolean; unread?: boolean; badge?: ReactNode;
}) {
  const className = `persona-avatar${working ? " persona-avatar-working" : ""}${unread ? " persona-avatar-unread" : ""}`;
  return <span className={className} aria-hidden="true">
    <span className="persona-avatar-gradient" style={personaGradient(seed)} />
    {badge && <span className="persona-avatar-badge">{badge}</span>}
  </span>;
}
