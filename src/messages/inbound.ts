import { markdownToPlainText } from "chat";
import { MsgType } from "matrix-js-sdk";
import {
  HTMLElement,
  NodeType,
  parse as parseHTML,
  type Node as HTMLNode,
} from "node-html-parser";
import {
  escapeMarkdownText,
  isRecord,
  matrixMentionDisplayText,
  normalizeOptionalString,
} from "../shared/utils";

export type MatrixMessageContent = {
  body?: string;
  format?: string;
  formatted_body?: string;
  msgtype?: string;
  "m.mentions"?: {
    room?: boolean;
    user_ids?: string[];
  };
  [key: string]: unknown;
};

export type ParsedMatrixContent = {
  markdown: string;
  mentionsRoom: boolean;
  mentionedUserIDs: Set<string>;
  text: string;
};

export function parseMatrixContent(content: MatrixMessageContent): ParsedMatrixContent {
  const mentionedUserIDs = extractMentionedUserIDs(content);
  const mentionsRoom = extractRoomMention(content);
  const formattedBody = normalizeOptionalString(content.formatted_body);
  if (formattedBody) {
    const htmlMarkdown = parseMatrixHTML(formattedBody);
    for (const mentionedUserID of htmlMarkdown.mentionedUserIDs) {
      mentionedUserIDs.add(mentionedUserID);
    }

    if (htmlMarkdown.markdown.length > 0) {
      return {
        text: markdownToPlainText(htmlMarkdown.markdown),
        markdown: htmlMarkdown.markdown,
        mentionedUserIDs,
        mentionsRoom,
      };
    }
  }

  const body = stripReplyFallbackFromBody(
    normalizeOptionalString(content.body) ?? ""
  );
  return {
    text: body,
    markdown: markdownForPlainText(body, content.msgtype),
    mentionedUserIDs,
    mentionsRoom,
  };
}

export function isMentioned(args: {
  content: MatrixMessageContent;
  parsed: ParsedMatrixContent;
  userID: string;
  userName: string;
}): boolean {
  const { content, parsed, userID, userName } = args;
  if (parsed.mentionsRoom) {
    return true;
  }
  if (userID && parsed.mentionedUserIDs.has(userID)) {
    return true;
  }

  const formatted =
    typeof content.formatted_body === "string" ? content.formatted_body : "";

  const hasUserID = userID
    ? parsed.text.includes(userID) || formatted.includes(userID)
    : false;
  const hasMatrixTo = userID
    ? formatted.includes(`matrix.to/#/${encodeURIComponent(userID)}`)
    : false;
  const normalizedUserName = userName.trim();
  const hasUserName = normalizedUserName
    ? (() => {
        const usernameMention = normalizedUserName.startsWith("@")
          ? normalizedUserName
          : `@${normalizedUserName}`;
        return (
          parsed.text.includes(usernameMention) ||
          formatted.includes(usernameMention)
        );
      })()
    : false;

  return hasUserID || hasMatrixTo || hasUserName;
}

function parseMatrixHTML(
  html: string
): { markdown: string; mentionedUserIDs: Set<string> } {
  const root = parseHTML(html);
  for (const child of [...root.childNodes]) {
    if (child instanceof HTMLElement && child.tagName.toLowerCase() === "mx-reply") {
      child.remove();
    }
  }
  const mentionedUserIDs = new Set<string>();
  const markdown = normalizeMarkdownSpacing(
    renderHTMLNodesToMarkdown(root.childNodes, mentionedUserIDs)
  );
  return {
    markdown,
    mentionedUserIDs,
  };
}

function renderHTMLNodesToMarkdown(
  nodes: HTMLNode[],
  mentionedUserIDs: Set<string>
): string {
  return nodes
    .map((node) => renderHTMLNodeToMarkdown(node, mentionedUserIDs))
    .join("");
}

function renderHTMLNodeToMarkdown(
  node: HTMLNode,
  mentionedUserIDs: Set<string>
): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return node.text;
  }

  if (!(node instanceof HTMLElement)) {
    return "";
  }

  const tagName = node.tagName.toLowerCase();
  const children = renderHTMLNodesToMarkdown(node.childNodes, mentionedUserIDs);

  switch (tagName) {
    case "mx-reply":
      return "";
    case "html":
    case "body":
    case "span":
      return children;
    case "br":
      return "\n";
    case "p":
    case "div":
      return children.trim() ? `${children.trim()}\n\n` : "";
    case "strong":
    case "b":
      return children ? `**${children}**` : "";
    case "em":
    case "i":
      return children ? `*${children}*` : "";
    case "del":
    case "s":
      return children ? `~~${children}~~` : "";
    case "code":
      return node.parentNode instanceof HTMLElement &&
        node.parentNode.tagName.toLowerCase() === "pre"
        ? children
        : `\`${children}\``;
    case "pre": {
      const codeContent = children.replace(/\n+$/u, "");
      return codeContent ? `\n\`\`\`\n${codeContent}\n\`\`\`\n\n` : "";
    }
    case "blockquote": {
      const quoted = children.trim();
      if (!quoted) {
        return "";
      }
      return `${quoted
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    }
    case "ul":
      return `${node.childNodes
        .map((child) => renderListItemToMarkdown(child, mentionedUserIDs, null))
        .filter(Boolean)
        .join("\n")}\n\n`;
    case "ol":
      return `${node.childNodes
        .map((child, index) =>
          renderListItemToMarkdown(child, mentionedUserIDs, index + 1)
        )
        .filter(Boolean)
        .join("\n")}\n\n`;
    case "a":
      return renderHTMLLinkToMarkdown(node, children, mentionedUserIDs);
    case "img":
      return normalizeOptionalString(node.getAttribute("alt")) ?? "image";
    default:
      return children;
  }
}

function renderListItemToMarkdown(
  node: HTMLNode,
  mentionedUserIDs: Set<string>,
  ordinal: number | null
): string {
  if (!(node instanceof HTMLElement) || node.tagName.toLowerCase() !== "li") {
    return "";
  }
  const content = normalizeMarkdownSpacing(
    renderHTMLNodesToMarkdown(node.childNodes, mentionedUserIDs)
  );
  if (!content) {
    return "";
  }
  return `${ordinal === null ? "-" : `${ordinal}.`} ${content}`;
}

function renderHTMLLinkToMarkdown(
  node: HTMLElement,
  children: string,
  mentionedUserIDs: Set<string>
): string {
  const href = normalizeOptionalString(node.getAttribute("href"));
  const text = children || node.text;
  if (!href) {
    return text;
  }

  const mentionedUserID = parseMatrixToUserID(href);
  if (mentionedUserID) {
    mentionedUserIDs.add(mentionedUserID);
    return text || matrixMentionDisplayText(mentionedUserID);
  }

  return `[${text || href}](${href})`;
}

function parseMatrixToUserID(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.hostname !== "matrix.to") {
    return null;
  }

  const rawPath = url.hash.startsWith("#/") ? url.hash.slice(2) : url.hash;
  const firstSegment = rawPath.split("/")[0];
  if (!firstSegment) {
    return null;
  }

  const identifier = decodeURIComponent(firstSegment);
  return identifier.startsWith("@") ? identifier : null;
}

function extractMentionedUserIDs(content: MatrixMessageContent): Set<string> {
  const mentions = new Set<string>();
  const matrixMentions = content["m.mentions"];
  if (!isRecord(matrixMentions) || !Array.isArray(matrixMentions.user_ids)) {
    return mentions;
  }

  for (const userID of matrixMentions.user_ids) {
    if (typeof userID === "string" && userID.length > 0) {
      mentions.add(userID);
    }
  }

  return mentions;
}

function extractRoomMention(content: MatrixMessageContent): boolean {
  const matrixMentions = content["m.mentions"];
  return isRecord(matrixMentions) && matrixMentions.room === true;
}

function stripReplyFallbackFromBody(body: string): string {
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]?.startsWith(">")) {
    index += 1;
  }

  if (index === 0 || index >= lines.length || lines[index] !== "") {
    return body;
  }

  return lines.slice(index + 1).join("\n");
}


function markdownForPlainText(text: string, msgtype?: string): string {
  const escaped = escapeMarkdownText(text);
  if (msgtype === MsgType.Emote && escaped.length > 0) {
    return `*${escaped}*`;
  }
  return escaped;
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown.replace(/\n{3,}/gu, "\n\n").trim();
}
