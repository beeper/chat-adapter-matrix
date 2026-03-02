import { randomBytes } from "node:crypto";
import { Chat, type Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { MatrixAdapter } from "../src/index";

export const env = {
  get baseURL(): string {
    return process.env.E2E_BASE_URL!;
  },
  get botAccessToken(): string {
    return process.env.E2E_BOT_ACCESS_TOKEN!;
  },
  get botUserID(): string {
    return process.env.E2E_BOT_USER_ID!;
  },
  get botRecoveryKey(): string | undefined {
    return process.env.E2E_BOT_RECOVERY_KEY || undefined;
  },
  get senderAccessToken(): string {
    return process.env.E2E_SENDER_ACCESS_TOKEN!;
  },
  get senderUserID(): string {
    return process.env.E2E_SENDER_USER_ID!;
  },
  get senderRecoveryKey(): string | undefined {
    return process.env.E2E_SENDER_RECOVERY_KEY || undefined;
  },
  get roomID(): string | undefined {
    return process.env.E2E_ROOM_ID || undefined;
  },
};

export function generateDeviceID(): string {
  return `E2E_${randomBytes(8).toString("hex").toUpperCase()}`;
}

export interface E2EParticipant {
  adapter: MatrixAdapter;
  chat: Chat;
  matrixClient: MatrixClient;
  onMessage: (cb: ((threadID: string, message: Message<MatrixEvent>) => void) | null) => void;
  onReaction: (cb: ((data: {
    threadId: string;
    messageId: string;
    emoji: unknown;
    rawEmoji: string;
    added: boolean;
    user: unknown;
  }) => void) | null) => void;
}

export async function createParticipant(opts: {
  name: string;
  accessToken: string;
  userID: string;
  recoveryKey?: string;
}): Promise<E2EParticipant> {
  const adapter = new MatrixAdapter({
    baseURL: env.baseURL,
    auth: {
      type: "accessToken",
      accessToken: opts.accessToken,
      userID: opts.userID,
    },
    deviceID: generateDeviceID(),
    inviteAutoJoin: { enabled: true },
    e2ee: { enabled: true },
    recoveryKey: opts.recoveryKey,
  });

  let messageCallback: ((threadID: string, message: Message<MatrixEvent>) => void) | null = null;
  let reactionCallback: ((data: {
    threadId: string;
    messageId: string;
    emoji: unknown;
    rawEmoji: string;
    added: boolean;
    user: unknown;
  }) => void) | null = null;

  const chat = new Chat({
    userName: opts.name,
    state: createMemoryState(),
    adapters: { matrix: adapter },
  });

  chat.onNewMessage(async (_thread, message, { threadId }) => {
    messageCallback?.(threadId, message);
  });

  chat.onSubscribedMessage(async (_thread, message, { threadId }) => {
    messageCallback?.(threadId, message);
  });

  chat.onReaction(async (event) => {
    reactionCallback?.(event as any);
  });

  await chat.initialize();

  const matrixClient = (adapter as any).client as MatrixClient;

  return {
    adapter,
    chat,
    matrixClient,
    onMessage: (cb) => { messageCallback = cb; },
    onReaction: (cb) => { reactionCallback = cb; },
  };
}

export async function getOrCreateRoom(
  botClient: MatrixClient,
  senderUserID: string,
): Promise<string> {
  if (env.roomID) {
    return env.roomID;
  }

  const { room_id } = await botClient.createRoom({
    invite: [senderUserID],
  });

  // sender auto-joins via inviteAutoJoin; give sync time to propagate
  await sleep(2_000);

  return room_id;
}

export function waitForEvent<T>(
  subscribe: (callback: (value: T) => void) => (() => void) | void,
  timeoutMs = 10_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup?.();
      reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nonce(): string {
  return Math.random().toString(36).slice(2, 10);
}
