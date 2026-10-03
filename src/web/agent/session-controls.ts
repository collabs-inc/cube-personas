// Adapted from cube-computer: src/windows/app/src/items/agent/session-controls.ts
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { JsonRpcRequest } from "../../shared/agent-protocol";

export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface ConfigSelectGroup {
  group: string;
  name: string;
  options: ConfigSelectOption[];
}

interface ConfigOptionBase {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
}

export type SessionConfigOption = ConfigOptionBase &
  (
    | { type: "select"; currentValue: string; options: ConfigSelectOption[] | ConfigSelectGroup[] }
    | { type: "boolean"; currentValue: boolean }
  );

export interface LegacyModel {
  id: string;
  name: string;
  description?: string | null;
}

export interface LegacyModelState {
  current: string | null;
  available: LegacyModel[];
}

export interface SessionUsageState {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
}

export interface SessionInfoState {
  title: string | null;
  updatedAt: string | null;
}

export interface SessionCompactionState {
  compactionId: string;
  status: string;
  summary: ContentBlock[];
  error: string | null;
}

export type SessionControlMethod = "session/set_config_option" | "session/set_mode" | "session/set_model";

export interface SessionControlRequest {
  requestId: string;
  method: SessionControlMethod;
  configId: string | null;
  value: string | boolean;
}

export interface SessionControlError extends SessionControlRequest {
  message: string;
}

export function setConfigOptionRequest(
  id: string,
  sessionId: string,
  configId: string,
  value: string | boolean,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_config_option",
    params:
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value },
  };
}

export function setModelRequest(id: string, sessionId: string, modelId: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "session/set_model", params: { sessionId, modelId } };
}

export function normalizeSessionConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  const options: SessionConfigOption[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string") continue;
    const common = configOptionBase(record);
    if (record.type === "boolean" && typeof record.currentValue === "boolean") {
      options.push({ ...common, type: "boolean", currentValue: record.currentValue });
      continue;
    }
    if (record.type !== "select" || typeof record.currentValue !== "string" || !Array.isArray(record.options)) {
      continue;
    }
    const normalized = normalizeSelectOptions(record.options);
    options.push({ ...common, type: "select", currentValue: record.currentValue, options: normalized });
  }
  return options;
}

function configOptionBase(record: Record<string, unknown>): ConfigOptionBase {
  return {
    id: record.id as string,
    name: record.name as string,
    ...(record.description === null || typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(record.category === null || typeof record.category === "string" ? { category: record.category } : {}),
  };
}

function normalizeSelectOptions(value: unknown[]): ConfigSelectOption[] | ConfigSelectGroup[] {
  const firstKind = value.find((item) => selectOptionKind(item) !== null);
  const kind = firstKind ? selectOptionKind(firstKind) : "option";
  if (kind === "group") {
    const groups: ConfigSelectGroup[] = [];
    for (const candidate of value) {
      const record = asRecord(candidate);
      if (
        !record ||
        typeof record.group !== "string" ||
        typeof record.name !== "string" ||
        !Array.isArray(record.options)
      ) {
        continue;
      }
      groups.push({ group: record.group, name: record.name, options: normalizeFlatOptions(record.options) });
    }
    return groups;
  }
  return normalizeFlatOptions(value);
}

function normalizeFlatOptions(value: unknown[]): ConfigSelectOption[] {
  const options: ConfigSelectOption[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record || typeof record.value !== "string" || typeof record.name !== "string") continue;
    options.push({
      value: record.value,
      name: record.name,
      ...(record.description === null || typeof record.description === "string"
        ? { description: record.description }
        : {}),
    });
  }
  return options;
}

function selectOptionKind(value: unknown): "option" | "group" | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.value === "string" && typeof record.name === "string") return "option";
  if (typeof record.group === "string" && typeof record.name === "string" && Array.isArray(record.options)) {
    return "group";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
