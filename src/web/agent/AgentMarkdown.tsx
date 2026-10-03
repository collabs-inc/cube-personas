// Adapted from cube-computer: src/windows/app/src/items/agent/AgentMarkdown.tsx
import { cloneElement, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "@phosphor-icons/react";
import { useDocumentTheme } from "../use-theme";
import { openExternal } from "./open-external";
import "./AgentTranscript.css";

export interface AgentMarkdownProps {
  content: string;
  className?: string | undefined;
  /** Opens browser-safe links (http, https, mailto) outside the app. */
  onOpenExternal?: ((url: string) => void) | undefined;
  /** Receives relative, absolute and file:// Markdown references without translating them. */
  onOpenPath?: ((path: string) => void) | undefined;
  onCopy?: ((text: string) => void | Promise<void>) | undefined;
}

const LANGUAGE_NAMES: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  rust: "Rust",
  yaml: "YAML",
  yml: "YAML",
};

const HIGHLIGHT_LANGUAGES: Record<string, string> = {
  bash: "shell",
  sh: "shell",
  shell: "shell",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  json: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  rs: "rust",
  rust: "rust",
  yaml: "yaml",
  yml: "yaml",
};

const HIGHLIGHT_MAX_CHARACTERS = 50_000;
const HIGHLIGHT_CACHE_LIMIT = 48;
const highlightCache = new Map<string, string>();

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Small transcript highlighter with stable semantic classes. It avoids mutating
 * Monaco's global editor theme and stays legible with the application's tokens. */
export function highlightAgentCode(source: string, language: string): string {
  const key = `${language}\0${source}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;
  const hashComment = /^(?:python|ruby|shell|yaml)$/.test(language) ? "|#[^\\n]*" : "";
  const token = new RegExp(
    `(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/${hashComment}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|\\b(?:async|await|break|case|catch|class|const|continue|def|default|do|elif|else|enum|export|extends|false|finally|fn|for|from|function|if|import|in|interface|let|match|new|nil|none|null|pub|return|self|static|struct|switch|throw|true|try|type|undefined|var|while)\\b|\\b\\d+(?:\\.\\d+)?\\b)`,
    "gi",
  );
  let html = "";
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0;
    html += `<span class="agent-syntax-plain">${escapeHtml(source.slice(cursor, index))}</span>`;
    const value = match[0];
    const className = /^(?:\/\/|\/\*|#)/.test(value)
      ? "agent-syntax-comment"
      : /^(?:["'`])/.test(value)
        ? "agent-syntax-string"
        : /^\d/.test(value)
          ? "agent-syntax-number"
          : "agent-syntax-keyword";
    html += `<span class="${className}">${escapeHtml(value)}</span>`;
    cursor = index + value.length;
  }
  const result = `${html}<span class="agent-syntax-plain">${escapeHtml(source.slice(cursor))}</span>`;
  highlightCache.set(key, result);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value as string | undefined;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return result;
}

export type AgentLink =
  | { kind: "external"; value: string }
  | { kind: "path"; value: string }
  | { kind: "unsafe"; value: string };

/** Classify before rendering so unsafe schemes never reach an href attribute. */
export function classifyAgentLink(value: string): AgentLink {
  const trimmed = value.trim();
  if (trimmed === "") return { kind: "unsafe", value: trimmed };
  if (/^(?:https?|mailto):/i.test(trimmed)) return { kind: "external", value: trimmed };
  if (/^(?:file):/i.test(trimmed)) return { kind: "path", value: trimmed };
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return { kind: "unsafe", value: trimmed };
  if (trimmed.startsWith("#")) return { kind: "unsafe", value: trimmed };
  return { kind: "path", value: trimmed };
}

const safeUrlTransform: UrlTransform = (url) => {
  const link = classifyAgentLink(url);
  return link.kind === "unsafe" ? "" : link.value;
};

/** Link path-shaped inline code, leaving fenced examples and existing links alone. */
function rehypeFileReferences() {
  return (tree: { type: string; children: unknown[] }): void => {
    const visit = (parent: { children: unknown[] }): void => {
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index] as ExtraProps["node"];
        if (node?.type !== "element" || node.tagName === "pre" || node.tagName === "a") continue;
        const text = node.children.length === 1 && node.children[0]?.type === "text" ? node.children[0].value : "";
        const path = text.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
        const file = !/[\s<>`{}|;=!?*]/.test(path) && classifyAgentLink(path).kind === "path"
          && /(?:^|[/\\])(?:[\w@()+-][\w.@()+-]*\.[a-zA-Z\d]{1,12}|\.[\w.-]+)$/.test(path);
        if (node.tagName === "code" && file) {
          parent.children[index] = { type: "element", tagName: "a", properties: { href: text }, children: [node] };
        } else visit(node);
      }
    };
    visit(tree);
  };
}

function codeSource(node: ReactNode): string {
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  const children = node.props.children;
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((child) => String(child ?? "")).join("");
  return String(children ?? "");
}

function codeLanguage(node: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(node)) return null;
  const match = /(?:^|\s)language-([^\s]+)/.exec(node.props.className ?? "");
  return match?.[1] ?? null;
}

function CodeBlock(props: { children: ReactNode; onCopy?: AgentMarkdownProps["onCopy"] }) {
  const [copied, setCopied] = useState(false);
  const theme = useDocumentTheme();
  const source = codeSource(props.children);
  const language = codeLanguage(props.children);
  const languageLabel = language === null ? "Code" : (LANGUAGE_NAMES[language.toLowerCase()] ?? language);
  const highlightLanguage = language === null ? null : HIGHLIGHT_LANGUAGES[language.toLowerCase()] ?? null;
  const highlighted = useMemo(
    () => highlightLanguage === null || source.length > HIGHLIGHT_MAX_CHARACTERS
      ? null
      : highlightAgentCode(source, highlightLanguage),
    [highlightLanguage, source],
  );
  const code = isValidElement<{ className?: string }>(props.children)
    ? cloneElement(props.children, {
        className: `${props.children.props.className ?? ""} agent-code-block-code`.trim(),
      })
    : props.children;

  const copy = async (): Promise<void> => {
    try {
      if (props.onCopy) await props.onCopy(source);
      else await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="agent-code-block">
      <div className="agent-code-header">
        <span className="agent-code-language">{languageLabel}</span>
        <button
          type="button"
          className="agent-code-copy"
          aria-label={`Copy ${languageLabel} code`}
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span className="agent-code-copy-label">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="agent-code-pre">
        {highlighted === null
          ? code
          : <code className="agent-code-block-code agent-code-highlighted" data-theme={theme} dangerouslySetInnerHTML={{ __html: highlighted }} />}
      </pre>
    </div>
  );
}

function componentsFor(props: AgentMarkdownProps): Components {
  return {
    a: ({ href, children }) => {
      const link = classifyAgentLink(href ?? "");
      const enabled = link.kind === "external" || (link.kind === "path" && props.onOpenPath !== undefined);
      if (!enabled) return <span className="agent-markdown-link-disabled">{children}</span>;
      if (link.kind === "path") {
        return (
          <a
            href={link.value}
            className="agent-markdown-link agent-markdown-path-link"
            onClick={(event) => {
              event.preventDefault();
              props.onOpenPath?.(link.value);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          className="agent-markdown-link"
          href={link.value}
          onClick={(event) => {
            event.preventDefault();
            (props.onOpenExternal ?? openExternal)(link.value);
          }}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => <blockquote className="agent-markdown-quote">{children}</blockquote>,
    code: ({ children, className }) => <code className={className ? `agent-markdown-code ${className}` : "agent-markdown-code"}>{children}</code>,
    h1: ({ children }) => <h1 className="agent-markdown-heading agent-markdown-h1">{children}</h1>,
    h2: ({ children }) => <h2 className="agent-markdown-heading agent-markdown-h2">{children}</h2>,
    h3: ({ children }) => <h3 className="agent-markdown-heading agent-markdown-h3">{children}</h3>,
    hr: () => <hr className="agent-markdown-rule" />,
    img: ({ src, alt }) => src ? <img className="agent-markdown-image" src={src} alt={alt ?? ""} loading="lazy" /> : null,
    li: ({ children, className }) => <li className={className ? `agent-markdown-list-item ${className}` : "agent-markdown-list-item"}>{children}</li>,
    ol: ({ children, start }) => <ol className="agent-markdown-list agent-markdown-ordered" start={start}>{children}</ol>,
    p: ({ children }) => <p className="agent-markdown-paragraph">{children}</p>,
    pre: ({ children }) => <CodeBlock onCopy={props.onCopy}>{children}</CodeBlock>,
    table: ({ children }) => <div className="agent-markdown-table-wrap"><table className="agent-markdown-table">{children}</table></div>,
    tbody: ({ children }) => <tbody className="agent-markdown-tbody">{children}</tbody>,
    td: ({ children }) => <td className="agent-markdown-cell">{children}</td>,
    th: ({ children }) => <th className="agent-markdown-head-cell">{children}</th>,
    thead: ({ children }) => <thead className="agent-markdown-thead">{children}</thead>,
    tr: ({ children }) => <tr className="agent-markdown-row">{children}</tr>,
    ul: ({ children, className }) => <ul className={className ? `agent-markdown-list ${className}` : "agent-markdown-list"}>{children}</ul>,
  };
}

function AgentMarkdownImpl(props: AgentMarkdownProps) {
  const className = props.className ? `agent-markdown ${props.className}` : "agent-markdown";
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={props.onOpenPath ? [rehypeFileReferences] : []}
        components={componentsFor(props)}
        urlTransform={safeUrlTransform}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  );
}

export const AgentMarkdown = memo(AgentMarkdownImpl);

export default AgentMarkdown;
