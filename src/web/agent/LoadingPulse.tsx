// Adapted from cube-computer: packages/components/src/LoadingPulse/LoadingPulse.tsx
import "./LoadingPulse.css";

export interface LoadingPulseProps {
  /** Extra hook for the surface whose existing geometry this pulse fills. */
  className?: string;
  /** Shared visible status and accessible name. */
  label?: string;
}

/** A geometry-neutral loading surface shared by tile content. */
export function LoadingPulse({ className, label = "Loading…" }: LoadingPulseProps) {
  return (
    <div
      className={`loading-pulse${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
    >
      <span className="loading-pulse-label" aria-hidden="true">{label}</span>
    </div>
  );
}
