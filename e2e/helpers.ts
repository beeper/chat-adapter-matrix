import { randomBytes } from "node:crypto";
import { Chat, type Message, type ReactionEvent, type StateAdapter } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import { EventType } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { MatrixAdapter } from "../src/index";

export const env = {
  get baseURL(): string {
    return process.env.E2E_BASE_URL!;
  },
  get botLoginToken(): string {
    return process.env.E2E_BOT_LOGIN_TOKEN!;
  },
  get botRecoveryKey(): string | undefined {
    return process.env.E2E_BOT_RECOVERY_KEY || undefined;
  },
  get senderLoginToken(): string {
    return process.env.E2E_SENDER_LOGIN_TOKEN!;
  },
  get senderRecoveryKey(): string | undefined {
    return process.env.E2E_SENDER_RECOVERY_KEY || undefined;
  },
  get roomID(): string | undefined {
    return process.env.E2E_ROOM_ID || undefined;
  },
  get redisURL(): string | undefined {
    return process.env.E2E_REDIS_URL || undefined;
  },
};

export interface E2EParticipant {
  adapter: MatrixAdapter;
  chat: Chat;
  matrixClient: MatrixClient;
  session: MatrixLoginResponse;
  state: StateAdapter;
  userID: string;
  onMessage: (cb: ((threadID: string, message: Message<MatrixEvent>) => void) | null) => void;
  onReaction: (cb: ((data: ReactionEvent<MatrixEvent>) => void) | null) => void;
}

export async function createParticipant(opts: {
  loginToken: string;
  name: string;
  recoveryKey?: string;
}): Promise<E2EParticipant> {
  const login = await loginToMatrix(opts.loginToken, opts.name);
  return createParticipantFromSession({
    name: opts.name,
    recoveryKey: opts.recoveryKey,
    session: login,
  });
}

export async function createParticipantFromSession(opts: {
  name: string;
  recoveryKey?: string;
  session: MatrixLoginResponse;
  state?: StateAdapter;
}): Promise<E2EParticipant> {
  const state = opts.state ?? createE2EState(opts.name);
  const adapter = new MatrixAdapter({
    baseURL: env.baseURL,
    auth: {
      type: "accessToken",
      accessToken: opts.session.accessToken,
      userID: opts.session.userID,
    },
    deviceID: opts.session.deviceID,
    inviteAutoJoin: { enabled: true },
    e2ee: {
      enabled: true,
      useIndexedDB: false,
    },
    matrixStore: {
      enabled: true,
    },
    recoveryKey: opts.recoveryKey,
  });

  let messageCallback: ((threadID: string, message: Message<MatrixEvent>) => void) | null = null;
  let reactionCallback: ((data: ReactionEvent<MatrixEvent>) => void) | null = null;

  const chat = new Chat({
    userName: opts.name,
    state,
    adapters: { matrix: adapter },
  });

  chat.onNewMessage(/[\s\S]*/u, async (thread, message, context) => {
    messageCallback?.(context?.threadId ?? thread.id, message);
  });

  chat.onSubscribedMessage(async (thread, message, context) => {
    messageCallback?.(context?.threadId ?? thread.id, message);
  });

  chat.onReaction(async (event: ReactionEvent<MatrixEvent>) => {
    reactionCallback?.(event);
  });

  await chat.initialize();

  const matrixClient = getInitializedClient(adapter);

  return {
    adapter,
    chat,
    matrixClient,
    session: opts.session,
    state,
    userID: opts.session.userID,
    onMessage: (cb) => { messageCallback = cb; },
    onReaction: (cb) => { reactionCallback = cb; },
  };
}

function createE2EState(name: string): StateAdapter {
  if (env.redisURL) {
    return createRedisState({
      url: env.redisURL,
      keyPrefix: `matrix-chat-adapter-e2e:${name}`,
    });
  }

  return createMemoryState();
}

export async function shutdownParticipant(participant: E2EParticipant): Promise<void> {
  participant.onMessage(null);
  participant.onReaction(null);
  await participant.adapter.shutdown();
}

type MatrixLoginResponse = {
  accessToken: string;
  deviceID: string;
  userID: string;
};

function generateDeviceID(): string {
  return `E2E_${randomBytes(8).toString("hex").toUpperCase()}`;
}

async function loginToMatrix(
  loginToken: string,
  participantName: string
): Promise<MatrixLoginResponse> {
  const requestedDeviceID = generateDeviceID();
  const response = await fetch(`${env.baseURL}/_matrix/client/v3/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "org.matrix.login.jwt",
      token: loginToken,
      device_id: requestedDeviceID,
      initial_device_display_name: `matrix-chat-adapter-${participantName}`,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Matrix login failed with ${response.status}: ${await response.text()}`
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    device_id?: unknown;
    user_id?: unknown;
  };
  const accessToken = readStringProperty(payload.access_token, "access_token");
  const userID = readStringProperty(payload.user_id, "user_id");
  const deviceID =
    typeof payload.device_id === "string" && payload.device_id.length > 0
      ? payload.device_id
      : requestedDeviceID;

  return { accessToken, deviceID, userID };
}

function readStringProperty(value: unknown, key: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Matrix login response is missing ${key}`);
}

export async function getOrCreateRoom(
  botClient: MatrixClient,
  senderUserID: string,
): Promise<string> {
  if (env.roomID) {
    return env.roomID;
  }

  return createEncryptedRoom(botClient, senderUserID);
}

export async function createIsolatedRoom(
  botClient: MatrixClient,
  senderClient: MatrixClient,
  senderUserID: string,
  roomName = `matrix-chat-adapter-e2e-${nonce()}`,
  timeoutMs = 30_000
): Promise<string> {
  const roomID = await createEncryptedRoom(botClient, senderUserID, roomName);

  await Promise.all([
    waitForEncryptedRoom(botClient, roomID, timeoutMs),
    waitForEncryptedRoom(senderClient, roomID, timeoutMs),
    waitForJoinedMemberCount(botClient, roomID, 2, timeoutMs),
    waitForJoinedMemberCount(senderClient, roomID, 2, timeoutMs),
  ]);

  return roomID;
}

async function createEncryptedRoom(
  botClient: MatrixClient,
  senderUserID: string,
  roomName?: string
): Promise<string> {
  const { room_id } = await botClient.createRoom({
    name: roomName,
    preset: "private_chat",
    invite: [senderUserID],
    initial_state: [
      {
        type: EventType.RoomEncryption,
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ],
  });

  if (typeof room_id !== "string" || room_id.length === 0) {
    throw new Error("Matrix createRoom did not return room_id");
  }

  return room_id;
}

export function waitForEvent<T>(
  subscribe: (callback: (value: T) => void) => (() => void) | void,
  timeoutMs = 10_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cleanup: (() => void) | void;
    let settled = false;
    let shouldCleanupAfterSubscribe = false;

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (cleanup) {
        cleanup();
      } else {
        shouldCleanupAfterSubscribe = true;
      }
      finish();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    try {
      cleanup = subscribe((value) => {
        settle(() => resolve(value));
      });
      if (shouldCleanupAfterSubscribe) {
        cleanup?.();
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 250
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    if (condition()) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }

    await sleep(intervalMs);
  }
}

export async function waitForRoom(
  client: MatrixClient,
  roomID: string,
  timeoutMs = 10_000
): Promise<Room> {
  await waitForCondition(() => Boolean(client.getRoom(roomID)), timeoutMs);
  const room = client.getRoom(roomID);
  if (!room) {
    throw new Error(`Room ${roomID} was not found after waiting`);
  }
  return room;
}

export async function waitForEncryptedRoom(
  client: MatrixClient,
  roomID: string,
  timeoutMs = 20_000
): Promise<Room> {
  const room = await waitForRoom(client, roomID, timeoutMs);
  await waitForCondition(() => client.isRoomEncrypted(roomID), timeoutMs);
  return room;
}

export async function waitForJoinedMemberCount(
  client: MatrixClient,
  roomID: string,
  expectedCount: number,
  timeoutMs = 20_000
): Promise<Room> {
  const room = await waitForRoom(client, roomID, timeoutMs);
  await waitForCondition(
    () => (client.getRoom(roomID)?.getJoinedMembers().length ?? 0) >= expectedCount,
    timeoutMs
  );
  return room;
}

export async function waitForFetchedMessage(
  adapter: MatrixAdapter,
  threadId: string,
  messageId: string,
  predicate: (message: Message<MatrixEvent>) => boolean = () => true,
  timeoutMs = 30_000,
  intervalMs = 1_000
): Promise<Message<MatrixEvent>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let message: Message<MatrixEvent> | null = null;
    try {
      message = await adapter.fetchMessage(threadId, messageId);
    } catch (error) {
      if (!isTransientMatrixError(error)) {
        throw error;
      }
    }

    if (message && isDecryptedMessage(message) && predicate(message)) {
      return message;
    }
    await sleep(intervalMs);
  }

  throw new Error(`waitForFetchedMessage timed out after ${timeoutMs}ms`);
}

export async function waitForMatchingMessage(
  adapter: MatrixAdapter,
  threadId: string,
  predicate: (message: Message<MatrixEvent>) => boolean,
  timeoutMs = 30_000,
  intervalMs = 1_000,
  limit = 20
): Promise<Message<MatrixEvent>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let page:
      | Awaited<ReturnType<MatrixAdapter["fetchMessages"]>>
      | null = null;
    try {
      page = await adapter.fetchMessages(threadId, {
        direction: "backward",
        limit,
      });
    } catch (error) {
      if (!isTransientMatrixError(error)) {
        throw error;
      }
    }

    if (!page) {
      await sleep(intervalMs);
      continue;
    }

    const match = page.messages.find(
      (message) => isDecryptedMessage(message) && predicate(message)
    );
    if (match) {
      return match;
    }
    await sleep(intervalMs);
  }

  throw new Error(`waitForMatchingMessage timed out after ${timeoutMs}ms`);
}

function getInitializedClient(adapter: MatrixAdapter): MatrixClient {
  const candidate: unknown = Reflect.get(adapter, "client");
  if (!isMatrixClient(candidate)) {
    throw new Error("Matrix client was not initialized");
  }
  return candidate;
}

function isMatrixClient(value: unknown): value is MatrixClient {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "startClient") === "function" &&
    typeof Reflect.get(value, "stopClient") === "function"
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isDecryptedMessage(message: Message<MatrixEvent>): boolean {
  return !message.text.startsWith("** Unable to decrypt:");
}

function isTransientMatrixError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("429") ||
    error.message.includes("503") ||
    error.message.includes("M_LIMIT_EXCEEDED") ||
    error.message.includes("Server returned 503 error")
  );
}
