import type {
  AdapterPostableMessage,
  Attachment,
  EmojiValue,
  FileUpload,
  Logger,
} from "chat";
import {
  isCardElement,
  markdownToPlainText,
  stringifyMarkdown,
} from "chat";
import { marked } from "marked";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors";
import { MsgType, RelationType } from "matrix-js-sdk";
import type {
  RoomMessageEventContent,
  RoomMessageTextEventContent,
} from "matrix-js-sdk/lib/@types/events";
import type { MediaEventContent } from "matrix-js-sdk/lib/@types/media";
import {
  escapeHTML,
  escapeMarkdownLinkText,
  escapeMarkdownText,
  isRecord,
  matrixLocalpart,
  normalizeOptionalString,
} from "../shared/utils";

const DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES = 12_000;

export type MatrixTextMessageContent = RoomMessageTextEventContent & {
  "com.beeper.dont_render_edited"?: boolean;
};

export type MatrixRoomMessageContent = RoomMessageEventContent & {
  "com.beeper.dont_render_edited"?: boolean;
  "m.new_content"?: RoomMessageEventContent & {
    "com.beeper.dont_render_edited"?: boolean;
  };
};

export type MatrixOutboundMessageContent = MatrixRoomMessageContent | MediaEventContent;

export type MatrixMediaMsgType =
  | MsgType.Audio
  | MsgType.File
  | MsgType.Image
  | MsgType.Video;

type RenderedMatrixMessage = {
  body: string;
  formattedBody?: string;
  mentions?: {
    room?: boolean;
    user_ids?: string[];
  };
};

export type OutboundUpload = {
  data: Blob;
  fileName: string;
  info?: {
    h?: number;
    mimetype?: string;
    size?: number;
    w?: number;
  };
  msgtype: MatrixMediaMsgType;
  type?: string;
};

export function extractReplyEventID(
  message: AdapterPostableMessage
): string | undefined {
  if (typeof message !== "object" || message === null || isCardElement(message)) {
    return undefined;
  }

  const replyEventID = (message as { matrixReplyToEventId?: unknown }).matrixReplyToEventId;
  return typeof replyEventID === "string" && replyEventID.length > 0
    ? replyEventID
    : undefined;
}

export function applyThreadReplyMetadata(
  content: MatrixOutboundMessageContent,
  rootEventID: string | undefined,
  replyEventID: string | undefined
): MatrixOutboundMessageContent {
  const threadableContent = content as MatrixOutboundMessageContent & {
    "m.relates_to"?: {
      rel_type?: string;
      "m.in_reply_to"?: { event_id: string };
      [key: string]: unknown;
    };
  };

  if (!rootEventID || threadableContent["m.relates_to"]?.rel_type) {
    return threadableContent;
  }

  return {
    ...threadableContent,
    "m.relates_to": {
      ...threadableContent["m.relates_to"],
      "m.in_reply_to": {
        event_id: replyEventID ?? rootEventID,
      },
    },
  } as MatrixOutboundMessageContent;
}

export function isTooLargeMatrixError(error: unknown): error is MatrixError {
  return (
    error instanceof MatrixError &&
    (error.errcode === "M_TOO_LARGE" || error.httpStatus === 413)
  );
}

export function splitOversizedTextContent(
  content: MatrixOutboundMessageContent
): MatrixTextMessageContent[] {
  if (!isSplittableTextContent(content)) {
    return [];
  }

  const body = content.body;
  if (Buffer.byteLength(body, "utf8") <= DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES) {
    return [];
  }

  const parts = splitTextByUtf8Bytes(body, DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES);
  if (parts.length <= 1) {
    return [];
  }

  return parts.map((part) => ({
    body: part,
    msgtype: content.msgtype,
  }));
}

export function toRoomMessageContent(
  message: AdapterPostableMessage
): MatrixTextMessageContent {
  const rendered = renderTextMessage(message);
  const content: MatrixTextMessageContent = {
    body: rendered.body,
    msgtype: MsgType.Text,
  };
  if (rendered.formattedBody) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = rendered.formattedBody;
  }
  if (rendered.mentions) {
    content["m.mentions"] = rendered.mentions;
  }

  return content;
}

export function mergeTextAndLinks(
  content: MatrixTextMessageContent,
  linkLines: string[]
): MatrixTextMessageContent {
  if (linkLines.length === 0) {
    return content;
  }

  const suffix = linkLines.join("\n");
  const body = content.body ?? "";
  const mergedBody = body ? `${body}\n\n${suffix}` : suffix;
  if (!content.formatted_body) {
    return {
      ...content,
      body: mergedBody,
    };
  }

  const formattedSuffix = linkLines
    .map((line) => `<p>${escapeHTML(line)}</p>`)
    .join("");

  return {
    ...content,
    body: mergedBody,
    formatted_body: `${content.formatted_body}${formattedSuffix}`,
  };
}

export function collectLinkOnlyAttachmentLines(attachments: Attachment[]): string[] {
  const lines: string[] = [];
  for (const attachment of attachments) {
    const hasLocalData =
      Boolean(attachment.data) || typeof attachment.fetchData === "function";
    if (hasLocalData) {
      continue;
    }
    if (!attachment.url) {
      continue;
    }
    const label = attachment.name ?? attachment.type;
    lines.push(`${label}: ${attachment.url}`);
  }
  return lines;
}

export function extractFilesFromMessage(
  message: AdapterPostableMessage,
  logger?: Logger
): FileUpload[] {
  if (typeof message !== "object" || message === null) {
    return [];
  }
  if (!("files" in message) || !Array.isArray(message.files)) {
    return [];
  }
  return message.files.flatMap((file): FileUpload[] => {
    const normalized = normalizeFileUpload(file, logger);
    return normalized ? [normalized] : [];
  });
}

export function normalizeFileUpload(
  file: unknown,
  logger?: Logger
): FileUpload | null {
  if (!isRecord(file)) {
    return null;
  }

  const filename = normalizeOptionalString(
    typeof file.filename === "string" ? file.filename : undefined
  );
  if (!filename) {
    return null;
  }

  const data = normalizeFileUploadData(file.data);
  if (!data) {
    logger?.warn("Skipping invalid Matrix file upload", { filename });
    return null;
  }

  return {
    filename,
    data,
    mimeType:
      typeof file.mimeType === "string" ? normalizeOptionalString(file.mimeType) : undefined,
  };
}

export function normalizeFileUploadData(
  data: unknown
): Buffer | Blob | ArrayBuffer | null {
  if (Buffer.isBuffer(data) || data instanceof Blob || data instanceof ArrayBuffer) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  return null;
}

export function extractAttachmentsFromMessage(
  message: AdapterPostableMessage
): Attachment[] {
  if (typeof message !== "object" || message === null) {
    return [];
  }
  if (!("attachments" in message) || !Array.isArray(message.attachments)) {
    return [];
  }
  return message.attachments.filter((a): a is Attachment => isRecord(a));
}

export async function readAttachmentData(
  attachment: Attachment
): Promise<Buffer | Blob | ArrayBuffer | null> {
  if (typeof attachment.fetchData === "function") {
    return attachment.fetchData();
  }
  return attachment.data ?? null;
}

export function normalizeUploadData(data: Buffer | Blob | ArrayBuffer): Blob {
  if (data instanceof Blob) {
    return data;
  }
  if (isNodeBuffer(data)) {
    return new Blob([new Uint8Array(data)]);
  }
  return new Blob([data]);
}

export function binarySize(data: Buffer | Blob | ArrayBuffer): number {
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (isNodeBuffer(data)) {
    return data.length;
  }
  return data.size;
}

export function messageTypeForAttachment(
  attachment: Attachment
): MatrixMediaMsgType {
  switch (attachment.type) {
    case "image":
      return MsgType.Image;
    case "video":
      return MsgType.Video;
    case "audio":
      return MsgType.Audio;
    default:
      return messageTypeForMimeType(normalizeOptionalString(attachment.mimeType));
  }
}

export function messageTypeForMimeType(mimeType?: string): MatrixMediaMsgType {
  if (!mimeType) {
    return MsgType.File;
  }
  if (mimeType.startsWith("image/")) {
    return MsgType.Image;
  }
  if (mimeType.startsWith("video/")) {
    return MsgType.Video;
  }
  if (mimeType.startsWith("audio/")) {
    return MsgType.Audio;
  }
  return MsgType.File;
}

export function defaultAttachmentName(attachment: Attachment): string {
  switch (attachment.type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "file";
  }
}

function renderTextMessage(message: AdapterPostableMessage): RenderedMatrixMessage {
  if (typeof message === "string") {
    return renderPlainTextMessage(message);
  }

  if (isCardElement(message)) {
    return renderPlainTextMessage("[Card message]");
  }

  if (typeof message === "object" && message !== null) {
    if ("raw" in message && typeof message.raw === "string") {
      return renderPlainTextMessage(message.raw);
    }
    if ("markdown" in message && typeof message.markdown === "string") {
      return renderMarkdownMessage(message.markdown);
    }
    if ("ast" in message) {
      return renderMarkdownMessage(stringifyMarkdown(message.ast));
    }
    if ("card" in message) {
      return renderPlainTextMessage(message.fallbackText ?? "[Card message]");
    }
  }

  return { body: "" };
}

function renderPlainTextMessage(text: string): RenderedMatrixMessage {
  const rendered = replaceMentionPlaceholdersInPlainText(text);
  if (rendered.mentionedUserIDs.size === 0) {
    return {
      body: rendered.body,
    };
  }

  return {
    body: rendered.body,
    formattedBody: renderMarkdownToMatrixHTML(rendered.markdown),
    mentions: buildMentionsContent(rendered.mentionedUserIDs),
  };
}

function renderMarkdownMessage(markdown: string): RenderedMatrixMessage {
  const rendered = replaceMentionPlaceholdersInMarkdown(markdown);
  return {
    body: markdownToPlainText(rendered.markdown),
    formattedBody: renderMarkdownToMatrixHTML(rendered.markdown),
    mentions: buildMentionsContent(rendered.mentionedUserIDs),
  };
}

function replaceMentionPlaceholdersInPlainText(text: string): {
  body: string;
  markdown: string;
  mentionedUserIDs: Set<string>;
} {
  const mentionedUserIDs = new Set<string>();
  const pattern = /<@(@[^>\s]+:[^>\s]+)>/gu;
  let body = "";
  let markdown = "";
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const [token, userID] = match;
    const index = match.index ?? 0;
    const plainSegment = text.slice(lastIndex, index);
    body += plainSegment;
    markdown += escapeMarkdownText(plainSegment);

    const mentionText = matrixMentionDisplayText(userID);
    body += mentionText;
    markdown += `[${escapeMarkdownLinkText(mentionText)}](${matrixToUserLink(userID)})`;
    mentionedUserIDs.add(userID);
    lastIndex = index + token.length;
  }

  const trailing = text.slice(lastIndex);
  body += trailing;
  markdown += escapeMarkdownText(trailing);

  return { body, markdown, mentionedUserIDs };
}

function replaceMentionPlaceholdersInMarkdown(markdown: string): {
  markdown: string;
  mentionedUserIDs: Set<string>;
} {
  const mentionedUserIDs = new Set<string>();
  const transformed = markdown.replace(
    /<@(@[^>\s]+:[^>\s]+)>/gu,
    (_match, userID: string) => {
      mentionedUserIDs.add(userID);
      return `[${escapeMarkdownLinkText(matrixMentionDisplayText(userID))}](${matrixToUserLink(
        userID
      )})`;
    }
  );

  return {
    markdown: transformed,
    mentionedUserIDs,
  };
}

function renderMarkdownToMatrixHTML(markdown: string): string {
  return marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  });
}

function buildMentionsContent(
  mentionedUserIDs: Set<string>
): { room?: boolean; user_ids?: string[] } | undefined {
  if (mentionedUserIDs.size === 0) {
    return undefined;
  }

  return {
    user_ids: [...mentionedUserIDs],
  };
}

function matrixToUserLink(userID: string): string {
  return `https://matrix.to/#/${encodeURIComponent(userID)}`;
}

function matrixMentionDisplayText(userID: string): string {
  return `@${matrixLocalpart(userID)}`;
}

function isSplittableTextContent(
  content: MatrixOutboundMessageContent
): content is MatrixTextMessageContent {
  if ("url" in content || "info" in content) {
    return false;
  }

  if (typeof content.body !== "string" || content.body.length <= 1) {
    return false;
  }

  if ("m.new_content" in content) {
    return false;
  }

  return (
    content.msgtype === MsgType.Text ||
    content.msgtype === MsgType.Notice ||
    content.msgtype === MsgType.Emote
  );
}

function splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  const normalizedMaxBytes = Math.max(1, Math.floor(maxBytes));
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf8") <= normalizedMaxBytes) {
      chunks.push(remaining);
      remaining = "";
      break;
    }

    const boundary = findSplitBoundary(remaining, normalizedMaxBytes);
    const head = remaining.slice(0, boundary).trimEnd();
    const tail = remaining.slice(boundary).trimStart();

    if (!head || head === remaining) {
      break;
    }

    chunks.push(head);
    remaining = tail;
  }

  if (remaining.length > 0 && chunks.at(-1) !== remaining) {
    chunks.push(remaining);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function findSplitBoundary(text: string, maxBytes: number): number {
  let low = 1;
  let high = text.length;
  let best = 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  for (let i = best - 1; i > 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      return i + 1;
    }
  }

  return best;
}

function isNodeBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}
