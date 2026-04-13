import { Direction } from "matrix-js-sdk";
import type { MatrixThreadID } from "../types";
import { isRecord } from "../shared/utils";

export const MATRIX_PREFIX = "matrix";
export const MATRIX_CURSOR_PREFIX = "mxv1:";

export type CursorKind = "room_messages" | "thread_relations" | "thread_list";

export type CursorDirection = "forward" | "backward";

export type CursorV1Payload = {
  dir: CursorDirection;
  kind: CursorKind;
  roomID: string;
  rootEventID?: string;
  token: string;
};

export function encodeThreadId(platformData: MatrixThreadID): string {
  const room = encodeURIComponent(platformData.roomID);
  if (platformData.rootEventID) {
    return `${MATRIX_PREFIX}:${room}:${encodeURIComponent(platformData.rootEventID)}`;
  }
  return `${MATRIX_PREFIX}:${room}`;
}

export function decodeThreadId(threadId: string): MatrixThreadID {
  const parts = threadId.split(":");
  if (parts.length < 2 || parts[0] !== MATRIX_PREFIX) {
    throw new Error(`Invalid Matrix thread ID: ${threadId}`);
  }

  const roomID = decodeURIComponent(parts[1]);
  if (!roomID) {
    throw new Error(`Invalid Matrix thread ID: ${threadId}`);
  }
  const rootEventID = parts[2] ? decodeURIComponent(parts[2]) : undefined;

  return { roomID, rootEventID };
}

export function channelIdFromThreadId(threadId: string): string {
  const { roomID } = decodeThreadId(threadId);
  return encodeThreadId({ roomID });
}

export function encodeCursorV1(payload: CursorV1Payload): string {
  return `${MATRIX_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url")}`;
}

export function decodeCursorV1(
  cursor: string,
  expectedKind: CursorKind,
  expectedRoomID: string,
  expectedRootEventID?: string,
  expectedDirection?: CursorDirection
): CursorV1Payload {
  if (!cursor.startsWith(MATRIX_CURSOR_PREFIX)) {
    throw new Error("Invalid cursor format. Expected mxv1 cursor.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor.slice(MATRIX_CURSOR_PREFIX.length), "base64url").toString("utf8")
    );
  } catch (error) {
    throw new Error(`Invalid cursor format. ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid cursor format. Cursor payload must be an object.");
  }

  if (parsed.kind !== expectedKind) {
    throw new Error(`Invalid cursor kind. Expected ${expectedKind}.`);
  }
  if (parsed.roomID !== expectedRoomID) {
    throw new Error("Invalid cursor context. Room mismatch.");
  }
  if (parsed.dir !== "forward" && parsed.dir !== "backward") {
    throw new Error("Invalid cursor format. Invalid direction.");
  }
  if (expectedDirection && parsed.dir !== expectedDirection) {
    throw new Error(`Invalid cursor direction. Expected ${expectedDirection}.`);
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("Invalid cursor format. Missing token.");
  }

  const rootEventID =
    typeof parsed.rootEventID === "string" ? parsed.rootEventID : undefined;
  if (expectedRootEventID) {
    if (rootEventID !== expectedRootEventID) {
      throw new Error("Invalid cursor context. Thread mismatch.");
    }
  } else if (rootEventID) {
    throw new Error("Invalid cursor context. Unexpected thread scope.");
  }

  return {
    dir: parsed.dir,
    kind: expectedKind,
    roomID: expectedRoomID,
    rootEventID,
    token: parsed.token,
  };
}

export function toSDKDirection(dir: CursorDirection): Direction {
  return dir === "forward" ? Direction.Forward : Direction.Backward;
}
