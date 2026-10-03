// Adapted from cube-computer: src/windows/app/src/items/agent/AgentContent.tsx
import { File, FileText, LinkSimple, SpeakerHigh } from "@phosphor-icons/react";
import { memo } from "react";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { openExternal } from "./open-external";
import { AgentMarkdown, classifyAgentLink, type AgentMarkdownProps } from "./AgentMarkdown";
import "./AgentTranscript.css";

export interface AgentContentProps {
  content: ContentBlock;
  className?: string | undefined;
  compact?: boolean | undefined;
  onOpenExternal?: AgentMarkdownProps["onOpenExternal"] | undefined;
  onOpenPath?: ((path: string) => void) | undefined;
  onCopy?: AgentMarkdownProps["onCopy"] | undefined;
}

function filePathFromUri(uri: string): string {
  if (!/^file:/i.test(uri)) return uri;
  try {
    const path = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return uri;
  }
}

function formatBytes(size: number | null | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unsupportedContent(className: string, type: unknown) {
  return (
    <div className={`${className} agent-content-unsupported`}>
      Unsupported content{typeof type === "string" ? ` (${type})` : ""}
    </div>
  );
}

function ResourceLink(props: AgentContentProps & { content: Extract<ContentBlock, { type: "resource_link" }> }) {
  const resource = props.content;
  const title = typeof resource.title === "string" ? resource.title : resource.name;
  const description = typeof resource.description === "string" ? resource.description : null;
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : null;
  const link = classifyAgentLink(resource.uri);
  const canOpen = link.kind === "external" || (link.kind === "path" && props.onOpenPath !== undefined);
  const open = (): void => {
    if (link.kind === "external") (props.onOpenExternal ?? openExternal)(link.value);
    else if (link.kind === "path") props.onOpenPath?.(link.value);
  };
  const body = (
    <>
      <File size={16} aria-hidden="true" />
      <span className="agent-resource-copy">
        <span className="agent-resource-title">{title}</span>
        <span className="agent-resource-meta">
          {description ?? mimeType ?? resource.uri}
          {formatBytes(resource.size) ? ` · ${formatBytes(resource.size)}` : ""}
        </span>
      </span>
      <LinkSimple size={14} aria-hidden="true" />
    </>
  );
  if (!canOpen) return <div className="agent-resource">{body}</div>;
  return <button type="button" className="agent-resource agent-resource-open" onClick={open}>{body}</button>;
}

function EmbeddedResource(props: AgentContentProps & { content: Extract<ContentBlock, { type: "resource" }> }) {
  const resource = props.content.resource;
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "";
  const isText = "text" in resource && typeof resource.text === "string";
  const isMarkdown = isText && /(?:markdown|mdx)/i.test(mimeType);
  const isImage = "blob" in resource && typeof resource.blob === "string" && /^image\//i.test(mimeType);
  const label = filePathFromUri(resource.uri).split(/[\\/]/).filter(Boolean).at(-1) ?? resource.uri;
  return (
    <section className="agent-embedded-resource" aria-label={`Embedded resource ${label}`}>
      <div className="agent-embedded-resource-head">
        <FileText size={15} aria-hidden="true" />
        <span className="agent-embedded-resource-name">{label}</span>
        {mimeType !== "" && <span className="agent-embedded-resource-type">{mimeType}</span>}
      </div>
      {isText && isMarkdown && (
        <AgentMarkdown
          content={resource.text}
          onOpenExternal={props.onOpenExternal}
          onOpenPath={props.onOpenPath}
          onCopy={props.onCopy}
        />
      )}
      {isText && !isMarkdown && <pre className="agent-embedded-resource-text">{resource.text}</pre>}
      {isImage && <img className="agent-content-image" src={`data:${mimeType};base64,${resource.blob}`} alt={label} loading="lazy" />}
      {!isText && !isImage && <div className="agent-embedded-resource-binary">Binary resource</div>}
    </section>
  );
}

function AgentContentImpl(props: AgentContentProps) {
  const { content } = props;
  const className = props.className ? `agent-content ${props.className}` : "agent-content";
  if (!isRecord(content) || typeof content.type !== "string") return unsupportedContent(className, undefined);
  if (content.type === "text" && typeof content.text === "string") {
    return (
      <AgentMarkdown
        className={className}
        content={content.text}
        onOpenExternal={props.onOpenExternal}
        onOpenPath={props.onOpenPath}
        onCopy={props.onCopy}
      />
    );
  }
  if (content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string") {
    return <div className={className}><img className="agent-content-image" src={`data:${content.mimeType};base64,${content.data}`} alt="Attached image" loading="lazy" /></div>;
  }
  if (content.type === "audio" && typeof content.mimeType === "string" && typeof content.data === "string") {
    return (
      <div className={`${className} agent-content-audio`}>
        <SpeakerHigh size={16} aria-hidden="true" />
        <audio className="agent-content-audio-player" controls preload="metadata" src={`data:${content.mimeType};base64,${content.data}`}>
          Audio content
        </audio>
      </div>
    );
  }
  if (content.type === "resource_link" && typeof content.name === "string" && typeof content.uri === "string") {
    return <ResourceLink {...props} content={content as Extract<ContentBlock, { type: "resource_link" }>} />;
  }
  if (content.type === "resource" && isRecord(content.resource) && typeof content.resource.uri === "string") {
    const resource = content.resource as unknown as Record<string, unknown>;
    const hasText = typeof resource.text === "string";
    const hasBlob = typeof resource.blob === "string";
    if (hasText || hasBlob) {
      return <EmbeddedResource {...props} content={content as Extract<ContentBlock, { type: "resource" }>} />;
    }
  }
  return unsupportedContent(className, content.type);
}

export const AgentContent = memo(AgentContentImpl);

export default AgentContent;
