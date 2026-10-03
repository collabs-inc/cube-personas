// Adapted from cube-computer: src/windows/app/src/items/agent/Composer.tsx
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, FileText, Plus, ListPlus, SlidersHorizontal, Square, X } from "@phosphor-icons/react";
import { carriesFiles } from "./file-drag";
import { dropContents } from "./file-drop";
import type { AvailableCommand, ContentBlock, SessionMode } from "@agentclientprotocol/sdk";
import {
  commandArgumentHint,
  composerBlocks,
  filterCommands,
  insertMentionPath,
  isSupportedImageFile,
  mentionQuery,
  promptSizeMessage,
  resourceLinkForCandidate,
  type ComposerImage,
  type ComposerAttachment,
  type FileCandidate,
  type MentionQuery,
} from "./composer-logic";
import {
  clearSentComposerDraft,
  getComposerDraft,
  subscribeComposerDraft,
  updateComposerDraft,
  type ComposerDraft,
} from "./composer-state";
import "./Composer.css";
import type { SessionUsageState } from "./session-controls";

const IMAGE_MAX_EDGE_PX = 1600;
const IMAGE_JPEG_QUALITY = 0.85;
const COMPLETION_LIMIT = 12;

export interface ComposerProps {
  compact?: boolean;
  disabled: boolean;
  running: boolean;
  modes: { current: string | null; available: SessionMode[] };
  commands: AvailableCommand[];
  onSend: (blocks: ContentBlock[]) => void | Promise<void>;
  onStop: () => void;
  onSetMode: (modeId: string) => void;
  itemId?: string | undefined;
  onQueue?: ((blocks: ContentBlock[]) => void | Promise<void>) | undefined;
  resourceRoot?: string | undefined;
  resourceCwd?: string | undefined;
  onFindFiles?: ((query: string) => FileCandidate[] | Promise<FileCandidate[]>) | undefined;
  imageSupported?: boolean | undefined;
  onAttachFile?: ((file: File) => Promise<ComposerAttachment>) | undefined;
  dropSurfaceRef?: RefObject<HTMLDivElement | null> | undefined;
  children?: ReactNode | undefined;
  narrow?: boolean | undefined;
  placeholder?: string | undefined;
  usage?: SessionUsageState | null | undefined;
}

type Completion =
  | { kind: "command"; command: AvailableCommand }
  | { kind: "file"; candidate: FileCandidate; mention: MentionQuery };

/**
 * Resize only images that need it. Keeping small originals preserves PNG
 * alpha and animated GIF/WebP data; large transparent sources use PNG on
 * canvas while camera-style images use JPEG.
 */
async function downscaleImage(file: File): Promise<ComposerImage | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= IMAGE_MAX_EDGE_PX) return null;
    const scale = IMAGE_MAX_EDGE_PX / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preserveAlpha = file.type === "image/png" || file.type === "image/webp";
    const mimeType = preserveAlpha ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mimeType, preserveAlpha ? undefined : IMAGE_JPEG_QUALITY);
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    return { data: url.slice(comma + 1), mimeType, name: file.name };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

function readImage(file: File): Promise<ComposerImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma < 0 ? null : {
        data: result.slice(comma + 1),
        mimeType: file.type || "image/png",
        name: file.name,
      });
    };
    reader.readAsDataURL(file);
  });
}

function imageBlock(image: ComposerImage): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
    _meta: { "cube.dev/filename": image.name },
  };
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return value !== undefined && typeof (value as Promise<void>).then === "function";
}

const compactNumber = (value: number): string => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function Composer(props: ComposerProps) {
  const used = props.usage;
  const fraction = used && used.size > 0 ? Math.min(1, used.used / used.size) : 0;
  const localId = useId();
  const draftKey = props.itemId ?? `composer:${localId}`;
  const draft = useSyncExternalStore(
    useCallback((listener) => subscribeComposerDraft(draftKey, listener), [draftKey]),
    useCallback(() => getComposerDraft(draftKey), [draftKey]),
    useCallback(() => getComposerDraft(draftKey), [draftKey]),
  );
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [fileResults, setFileResults] = useState<{ key: string | null; matches: FileCandidate[] }>({ key: null, matches: [] });
  const [selected, setSelected] = useState(0);
  const [caret, setCaret] = useState(draft.text.length);
  const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const lastFocusRevision = useRef(0);

  const blocks = useMemo(
    () => composerBlocks(draft.text, draft.attachments),
    [draft.attachments, draft.text],
  );
  const sizeError = promptSizeMessage(blocks);
  const slashMatches = filterCommands(draft.text, props.commands);
  const mention = mentionQuery(draft.text, caret);
  const completionKey = mention
    ? `file:${mention.start}:${mention.query}`
    : slashMatches.length > 0 ? `command:${draft.text}` : null;
  const fileMatches = fileResults.key === completionKey ? fileResults.matches : [];
  const completions: Completion[] = mention
    ? fileMatches.slice(0, COMPLETION_LIMIT).map((candidate) => ({ kind: "file", candidate, mention }))
    : slashMatches.slice(0, COMPLETION_LIMIT).map((command) => ({ kind: "command", command }));
  const completionActive = completionKey !== null && dismissedCompletion !== completionKey;
  const completionOpen = completionActive && completions.length > 0;
  const argumentHint = commandArgumentHint(draft.text, props.commands);
  const hasPrompt = blocks.length > 0;
  const canSend = !props.disabled && !props.running && !sending && uploads === 0 && hasPrompt && sizeError === null;
  const canQueue = !props.disabled && props.running && !sending && uploads === 0 && props.onQueue !== undefined
    && hasPrompt && sizeError === null;

  const setDraft = useCallback((update: (current: ComposerDraft) => ComposerDraft) => {
    updateComposerDraft(draftKey, update);
  }, [draftKey]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "0px";
      // scrollHeight includes a wrapped placeholder, even with no draft.
      const contentHeight = textarea.value ? textarea.scrollHeight : 30;
      textarea.style.height = `${Math.min(200, Math.max(30, contentHeight))}px`;
      textarea.style.overflowY = contentHeight > 200 ? "auto" : "hidden";
    };
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      // Height changes are our own writes; only width changes affect wrapping.
      if (nextWidth === width) return;
      width = nextWidth;
      if (width > 0) resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft.text]);

  useEffect(() => {
    if (draft.focusRevision <= lastFocusRevision.current) return;
    lastFocusRevision.current = draft.focusRevision;
    textareaRef.current?.focus();
  }, [draft.focusRevision]);

  useEffect(() => {
    setSelected(0);
    setFileResults({ key: completionKey, matches: [] });
    if (!mention || !props.onFindFiles) {
      return;
    }
    let current = true;
    let result: FileCandidate[] | Promise<FileCandidate[]>;
    try {
      result = props.onFindFiles(mention.query);
    } catch {
      return;
    }
    Promise.resolve(result).then(
      (matches) => { if (current) setFileResults({ key: completionKey, matches: matches.slice(0, 40) }); },
      () => { if (current) setFileResults({ key: completionKey, matches: [] }); },
    );
    return () => { current = false; };
  }, [completionKey, mention?.query, props.onFindFiles]);

  const complete = (completion: Completion): void => {
    if (completion.kind === "command") {
      const text = `/${completion.command.name} `;
      setDraft((current) => ({ ...current, text }));
      setCaret(text.length);
    } else {
      const text = insertMentionPath(draft.text, completion.mention, completion.candidate.path);
      const resource = resourceLinkForCandidate(completion.candidate, props);
      setDraft((current) => ({
        ...current,
        text,
        attachments: resource ? [...current.attachments, resource] : current.attachments,
      }));
      const nextCaret = completion.mention.start + completion.candidate.path.length;
      setCaret(nextCaret);
      queueMicrotask(() => textareaRef.current?.setSelectionRange(nextCaret, nextCaret));
    }
    setDismissedCompletion(null);
    textareaRef.current?.focus();
  };

  const submit = (callback: (prompt: ContentBlock[]) => void | Promise<void>): void => {
    if (sending || uploads > 0 || !hasPrompt || sizeError !== null) return;
    const sent = draft;
    let result: void | Promise<void>;
    try {
      result = callback(blocks);
    } catch {
      return;
    }
    if (!isPromiseLike(result)) {
      clearSentComposerDraft(draftKey, sent);
      return;
    }
    setSending(true);
    void result.then(
      () => clearSentComposerDraft(draftKey, sent),
      () => {},
    ).finally(() => setSending(false));
  };

  const attach = async (files: File[], folderNames: string[] = []): Promise<void> => {
    const errors = folderNames.map((name) => `${name} is a folder. Attach individual files instead.`);
    setAttachError(null);
    setUploads((count) => count + 1);
    try {
      for (const file of files) {
        try {
          let block: ComposerAttachment;
          if (props.imageSupported === true && isSupportedImageFile(file)) {
            const image = (await downscaleImage(file)) ?? (await readImage(file));
            if (!image) throw new Error(`${file.name} could not be read.`);
            block = imageBlock(image);
          } else {
            if (!props.onAttachFile) throw new Error(`${file.name} cannot be attached here.`);
            block = await props.onAttachFile(file);
          }
          // This closure retains the initiating item's draft key during upload.
          setDraft((current) => {
            const attachments = [...current.attachments, block];
            if (promptSizeMessage(composerBlocks(current.text, attachments)) !== null) {
              errors.push(`${file.name} would make the prompt too large. Try a smaller file.`);
              return current;
            }
            return { ...current, attachments };
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `${file.name} could not be uploaded.`);
        }
      }
      setAttachError(errors.length > 0 ? errors.join(" ") : null);
    } finally {
      setUploads((count) => count - 1);
    }
  };

  const removeAttachment = (index: number): void => {
    setDraft((current) => ({
      ...current,
      attachments: current.attachments.filter((_, attachmentIndex) => attachmentIndex !== index),
    }));
  };

  const attachFromEvent = (files: File[]): boolean => {
    if (files.length === 0 || (!props.onAttachFile && (props.imageSupported !== true || !files.some(isSupportedImageFile)))) return false;
    void attach(files);
    return true;
  };

  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    const root = props.dropSurfaceRef?.current ?? composerRef.current;
    const surface = root?.closest<HTMLElement>(".pane-chrome") ?? root;
    if (!surface) return;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !surface.contains(event.relatedTarget)) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      setDragging(false);
      if (!carriesFiles(event.dataTransfer) && !event.dataTransfer?.files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const { files, folderNames } = dropContents(event.dataTransfer);
      void attachRef.current(files, folderNames);
    };
    const end = () => setDragging(false);
    surface.addEventListener("dragover", over);
    surface.addEventListener("dragleave", leave);
    surface.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      surface.removeEventListener("dragover", over);
      surface.removeEventListener("dragleave", leave);
      surface.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
    };
  }, [props.dropSurfaceRef]);

  const attachmentButton = <button
    type="button"
    className="agent-composer-attach"
    aria-label="Attach files"
    data-tooltip="Attach files"
    onPointerDown={props.narrow === true ? (event) => event.preventDefault() : undefined}
    onPointerUp={props.narrow === true
      ? (event) => { if (event.button === 0) filesRef.current?.click(); }
      : undefined}
    onClick={(event) => {
      if (props.narrow !== true || event.detail === 0) filesRef.current?.click();
    }}
  >
    <Plus size={17} aria-hidden="true" />
  </button>;

  const submitControls = <>
        {props.running && props.onQueue && (
          <button
            type="button"
            className="agent-composer-queue"
            disabled={!canQueue}
            onClick={() => submit(props.onQueue!)}
          >
            <ListPlus size={15} aria-hidden="true" />
            Queue
          </button>
        )}
        {props.running ? (
          <button type="button" className="agent-composer-stop" onClick={props.onStop}>
            <Square size={13} weight="fill" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="agent-composer-send"
            aria-label="Send"
            data-tooltip="Send"
            data-shortcut={props.narrow ? undefined : "Enter"}
            disabled={!canSend}
            onClick={() => submit(props.onSend)}
          >
            <ArrowUp size={16} weight="bold" aria-hidden="true" />
          </button>
        )}
  </>;

  return (
    <div
      ref={composerRef}
      className={`agent-composer${props.running ? " agent-composer-running" : ""}`}
    >
      <div className="agent-composer-input-area">
      {dragging && <div className="agent-composer-drop-hint">Drop files to attach</div>}
      {uploads > 0 && <div className="agent-composer-hint" role="status">Attaching files…</div>}
      {completionOpen && (
        <div
          id={`${localId}-completions`}
          className="agent-composer-popover"
          role="listbox"
          aria-label={mention ? "Files" : "Commands"}
        >
          {completions.map((completion, index) => {
            const isSelected = index === selected;
            const id = `${localId}-completion-${index}`;
            return (
              <button
                id={id}
                key={completion.kind === "command" ? completion.command.name : `${completion.candidate.path}:${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`agent-composer-option${isSelected ? " agent-composer-option-selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSelected(index)}
                onClick={() => complete(completion)}
              >
                {completion.kind === "command" ? (
                  <>
                    <span className="agent-composer-option-name">/{completion.command.name}</span>
                    <span className="agent-composer-option-description">{completion.command.description}</span>
                  </>
                ) : (
                  <>
                    <FileText size={15} aria-hidden="true" />
                    <span className="agent-composer-option-name">{completion.candidate.name}</span>
                    <span className="agent-composer-option-path">{completion.candidate.path}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}

      {(attachError || sizeError) && (
        <div className="agent-composer-error" role="alert">{attachError ?? sizeError}</div>
      )}

      {draft.attachments.length > 0 && (
        <div className="agent-composer-attachments" aria-label="Attachments">
          {draft.attachments.map((attachment, index) => {
            const imageName = attachment.type === "image"
              ? String(attachment._meta?.["cube.dev/filename"] ?? "image")
              : null;
            const label = attachment.type === "resource_link"
              ? attachment.title ?? attachment.name
              : imageName ?? attachment.type;
            return (
              <div className="agent-composer-attachment" key={`${attachment.type}:${index}`}>
                {attachment.type === "image" ? (
                  <img
                    className="agent-composer-thumb-image"
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt=""
                  />
                ) : <FileText size={18} aria-hidden="true" />}
                <span className="agent-composer-attachment-name">{label}</span>
                <button
                  type="button"
                  className="agent-composer-remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => removeAttachment(index)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="agent-composer-input"
        value={draft.text}
        rows={1}
        placeholder={props.placeholder ?? "Message the agent…"}
        aria-label="Message the agent"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={completionOpen}
        aria-controls={completionOpen ? `${localId}-completions` : undefined}
        aria-activedescendant={completionOpen ? `${localId}-completion-${selected}` : undefined}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setDraft((current) => ({ ...current, text }));
          setCaret(event.currentTarget.selectionStart);
          setDismissedCompletion(null);
          setAttachError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (completionOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setSelected((current) => (current + delta + completions.length) % completions.length);
            return;
          }
          if (completionActive && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            const choice = completions[selected];
            if (choice) complete(choice);
            return;
          }
          if (completionActive && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissedCompletion(completionKey);
            return;
          }
          if (event.key === "Escape" && props.running) {
            event.preventDefault();
            event.stopPropagation();
            props.onStop();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || props.narrow === true) return;
          event.preventDefault();
          if (props.running) {
            if (canQueue && props.onQueue) submit(props.onQueue);
          } else if (canSend) submit(props.onSend);
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (attachFromEvent(files)) event.preventDefault();
        }}
      />

      {argumentHint && <div className="agent-composer-hint">{argumentHint}</div>}

      {props.compact && <div className="agent-composer-submit-actions">
        {attachmentButton}
        <span className="agent-composer-spacer" />
        {submitControls}
      </div>}
      </div>

      <div className="agent-composer-actions">
        <div className="agent-composer-controls">{props.compact ? <details className="persona-composer-inspector"
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary className="agent-icon-button" aria-label="Conversation settings" title="Conversation settings"><SlidersHorizontal size={16} /></summary>
          <div className="persona-composer-settings"><div className="persona-inspector-title">Conversation settings</div>{props.children}</div>
        </details> : props.children}</div>
        {props.modes.available.length > 1 && (
          <select
            className="agent-mode-picker"
            aria-label="Mode"
            value={props.modes.current ?? ""}
            onChange={(event) => props.onSetMode(event.currentTarget.value)}
          >
            {props.modes.available.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.name}</option>
            ))}
          </select>
        )}
        {!props.compact && attachmentButton}
        <input
          ref={filesRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void attach(files);
          }}
        />
        <span className="agent-composer-spacer" />
        {used && (
          <div className="agent-context" title={`${used.used.toLocaleString()} of ${used.size.toLocaleString()} context tokens${used.cost ? ` · ${used.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${used.cost.currency}` : ""}`}>
            <svg className="agent-context-ring" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={`${Math.round(fraction * 100)}% of context used`}>
              <circle className="agent-context-track" cx="8" cy="8" r="6" />
              <circle className="agent-context-fill" cx="8" cy="8" r="6" pathLength="100" strokeDasharray={`${fraction * 100} 100`} />
            </svg>
            <span className="agent-context-count">{compactNumber(used.used)} / {compactNumber(used.size)}</span>
          </div>
        )}
        {!props.compact && submitControls}
      </div>
    </div>
  );
}

export default Composer;
