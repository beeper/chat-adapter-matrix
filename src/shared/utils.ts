import { randomBytes } from "node:crypto";

export function generateDeviceID(length = 8): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "chatsdk_";

  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out;
}

export function normalizeOptionalString(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

export function matrixLocalpart(userID: string): string {
  return userID.startsWith("@") ? userID.slice(1).split(":")[0] ?? userID : userID;
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1");
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\\]])/gu, "\\$1");
}

export function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return values
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value));
}

export function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== "undefined" && globalThis.indexedDB !== null;
}

export function evictOldestEntries(
  collection: { size: number; keys(): Iterable<string>; delete(key: string): unknown },
  maxSize = 10_000,
  targetSize = 5_000
): void {
  if (collection.size <= maxSize) return;
  const toDelete = collection.size - targetSize;
  let deleted = 0;
  for (const key of collection.keys()) {
    if (deleted >= toDelete) break;
    collection.delete(key);
    deleted++;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
