/**
 * An HTML artifact in the pick column, served by the app's own
 * `/artifact` route, which refuses any path outside the persona's
 * checkouts and context folder. The URL is relative, so the page works at
 * whatever address it is opened from.
 */
export function artifactUrl(personaId: string, path: string): string {
  return `/artifact?${new URLSearchParams({ persona: personaId, path }).toString()}`;
}

export function ArtifactFrame({ personaId, path, name }: { personaId: string; path: string; name: string }) {
  return <iframe className="artifact-frame" title={name} src={artifactUrl(personaId, path)}
    sandbox="allow-scripts allow-forms allow-popups allow-modals" />;
}
