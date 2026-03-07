import { describe, expect, it, vi } from "vitest";
import { Chat, getEmoji, stringifyMarkdown } from "chat";
import type { ChatInstance, Logger, StateAdapter } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { EventType, MsgType, RelationType, type MatrixClient } from "matrix-js-sdk";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { createMatrixAdapter, MatrixAdapter } from "./index";

type RawEventLike = {
  content?: Record<string, unknown>;
  event_id?: string;
  isThreadRoot?: boolean;
  origin_server_ts?: number;
  room_id?: string;
  sender?: string;
  threadRootId?: string;
  type?: string;
  unsigned?: Record<string, unknown>;
  [key: string]: unknown;
};

type MessagesResponseLike = {
  chunk: RawEventLike[];
  end?: string;
};

type RelationsResponseLike = {
  originalEvent: ReturnType<typeof makeEvent> | null;
  events: Array<ReturnType<typeof makeEvent>>;
  nextBatch: string | null;
  prevBatch: string | null;
};

type MemberLike = {
  name?: string;
  rawDisplayName?: string;
};

type StateEventLike = {
  getContent: <T>() => T;
};

type RoomStateLike = {
  getStateEvents: (eventType: string, stateKey: string) => StateEventLike | null;
};

type RoomLike = {
  currentState: RoomStateLike;
  getMember: (userId: string) => MemberLike | null;
  roomId: string;
  name: string;
  timeline: unknown[];
  hasEncryptionStateEvent: () => boolean;
  getJoinedMembers: () => Array<Record<string, never>>;
  getMyMembership: () => string;
  findEventById: (eventID?: string) => ReturnType<typeof makeEvent> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  const event = {
    getId: () => "$event",
    getRoomId: () => "!room:beeper.com",
    getTs: () => 1_700_000_000_000,
    getSender: () => "@alice:beeper.com",
    getStateKey: () => undefined,
    getType: () => EventType.RoomMessage,
    getContent: () => ({ body: "hello" }),
    getRelation: () => null,
    isRelation: () => false,
    getServerAggregatedRelation: () => undefined,
    threadRootId: undefined,
    isThreadRoot: false,
    isRedaction: () => false,
    getAssociatedId: () => undefined,
    ...overrides,
  };

  return event;
}

function makeStateEvent(content: Record<string, unknown>): StateEventLike {
  return {
    getContent: <T>() => content as T,
  };
}

function makeRawEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "$raw",
    room_id: "!room:beeper.com",
    origin_server_ts: 1_700_000_000_000,
    sender: "@alice:beeper.com",
    type: EventType.RoomMessage,
    content: { body: "hello" },
    unsigned: {},
    ...overrides,
  };
}

function mapRawToEvent(raw: RawEventLike) {
  const content = raw.content ?? {};
  const relatesTo = isRecord(content["m.relates_to"])
    ? content["m.relates_to"]
    : undefined;
  const relationType = readString(relatesTo?.rel_type);
  const relationEventID = readString(relatesTo?.event_id);
  const mappedThreadRootId =
    typeof raw.threadRootId === "string"
      ? raw.threadRootId
      : relationType === "m.thread" && typeof relationEventID === "string"
        ? relationEventID
        : undefined;
  const isThreadRoot = raw.isThreadRoot === true;
  const unsignedRelations = isRecord(raw.unsigned?.["m.relations"])
    ? raw.unsigned["m.relations"]
    : undefined;

  return makeEvent({
    getId: () => raw.event_id ?? "$raw",
    getRoomId: () => raw.room_id ?? "!room:beeper.com",
    getTs: () => raw.origin_server_ts ?? 1_700_000_000_000,
    getSender: () => raw.sender ?? "@alice:beeper.com",
    getType: () => raw.type ?? EventType.RoomMessage,
    getContent: () => content,
    getRelation: () =>
      relationType
        ? {
            rel_type: relationType,
          }
        : null,
    isRelation: (expectedRelType: string) => relationType === expectedRelType,
    getServerAggregatedRelation: (expectedRelType: string) =>
      unsignedRelations?.[expectedRelType],
    threadRootId: mappedThreadRootId,
    isThreadRoot,
  });
}

type AdapterInternals = {
  deviceID?: string;
  e2eeConfig?: { enabled?: boolean };
  getSecretStorageKeyFromRecoveryKey: (opts: {
    keys: Record<string, unknown>;
  }) => [string, Uint8Array] | null;
  loadPersistedSession: () => Promise<{
    accessToken: string;
    userID: string;
    deviceID?: string;
  } | null>;
  persistSession: (session: {
    accessToken: string;
    deviceID?: string;
    userID: string;
  }) => Promise<void>;
  resolveAuth: () => Promise<{
    accessToken: string;
    userID: string;
    deviceID?: string;
  }>;
  resolveDeviceID: () => Promise<void>;
  stateAdapter: StateAdapter | null;
};

function asMatrixClient(client: ReturnType<typeof makeClient>): MatrixClient {
  if (!isMatrixClient(client)) {
    throw new Error("Fake client does not satisfy the MatrixClient contract used in tests");
  }
  return client;
}

function getInternals(adapter: MatrixAdapter): AdapterInternals {
  return adapter as unknown as AdapterInternals;
}

function makeClient() {
  const handlers = new Map<string, (...args: unknown[]) => void>();

  const client = {
    on: (eventName: string, cb: (...args: unknown[]) => void) => {
      handlers.set(eventName, cb);
    },
    startClient: vi.fn(async () => undefined),
    stopClient: vi.fn(() => undefined),
    removeAllListeners: vi.fn(() => undefined),
    sendMessage: vi.fn(async () => ({ event_id: "$sent" })),
    sendEvent: vi.fn(async () => ({ event_id: "$reaction" })),
    uploadContent: vi.fn(async () => ({ content_uri: "mxc://beeper.com/uploaded" })),
    redactEvent: vi.fn(async () => ({ event_id: "$redaction" })),
    sendTyping: vi.fn(async () => ({})),
    createRoom: vi.fn(async () => ({ room_id: "!new-dm:beeper.com" })),
    joinRoom: vi.fn(async () => ({ room_id: "!joined:beeper.com" })),
    createMessagesRequest: vi.fn(
      async (): Promise<MessagesResponseLike> => ({ chunk: [], end: undefined })
    ),
    createThreadListMessagesRequest: vi.fn(
      async (): Promise<MessagesResponseLike> => ({ chunk: [], end: undefined })
    ),
    fetchRoomEvent: vi.fn(async (): Promise<RawEventLike | null> => null),
    getAccountDataFromServer: vi.fn(
      async (): Promise<Record<string, string[]> | null> => null
    ),
    getAccessToken: vi.fn(() => "token"),
    getEventMapper: vi.fn(() => (raw: Record<string, unknown>) => mapRawToEvent(raw)),
    initRustCrypto: vi.fn(async () => undefined),
    mxcUrlToHttp: vi.fn((url: string) => url),
    relations: vi.fn(
      async (): Promise<RelationsResponseLike> => ({
        originalEvent: null,
        events: [],
        nextBatch: null,
        prevBatch: null,
      })
    ),
    setAccountData: vi.fn(async (): Promise<Record<string, never>> => ({})),
    decryptEventIfNeeded: vi.fn(async () => undefined),
    getRoom: vi.fn((roomID?: string): RoomLike | null => makeRoom({
      roomId: roomID ?? "!room:beeper.com",
    })),
    __handlers: handlers,
  };

  return client;
}

function isMatrixClient(value: unknown): value is MatrixClient {
  if (!isRecord(value)) {
    return false;
  }

  return [
    "createMessagesRequest",
    "createRoom",
    "getEventMapper",
    "getRoom",
    "relations",
    "sendEvent",
    "startClient",
    "stopClient",
  ].every((key) => typeof Reflect.get(value, key) === "function");
}

function makeRoom(overrides: Partial<RoomLike> = {}): RoomLike {
  return {
    roomId: "!room:beeper.com",
    name: "Example Room",
    timeline: [],
    currentState: {
      getStateEvents: () => null,
    },
    getMember: () => null,
    hasEncryptionStateEvent: () => false,
    getJoinedMembers: () => [{}, {}],
    getMyMembership: () => "join",
    findEventById: () => makeEvent({ getId: () => "$sent" }),
    ...overrides,
  };
}

function makeRoomState(events: Record<string, Record<string, unknown>>): RoomStateLike {
  return {
    getStateEvents: (eventType: string, stateKey: string) =>
      stateKey === "" && events[eventType] ? makeStateEvent(events[eventType]) : null,
  };
}

function makeRoomMembers(
  members: Record<string, MemberLike>
): RoomLike["getMember"] {
  return (userId: string) => members[userId] ?? null;
}

function makeStateAdapter(initial: Record<string, unknown> = {}): StateAdapter {
  const base = createMemoryState();
  const ready = (async () => {
    await base.connect();
    for (const [key, value] of Object.entries(initial)) {
      await base.set(key, value);
    }
  })();
  const afterReady = async <T>(run: () => Promise<T>): Promise<T> => {
    await ready;
    return run();
  };
  const get: StateAdapter["get"] = (key) => afterReady(() => base.get(key));
  const set: StateAdapter["set"] = (key, value, ttlMs) =>
    afterReady(() => base.set(key, value, ttlMs));

  return {
    acquireLock: vi.fn((threadId, ttlMs) =>
      afterReady(() => base.acquireLock(threadId, ttlMs))
    ),
    connect: vi.fn(() => afterReady(() => base.connect())),
    delete: vi.fn((key) => afterReady(() => base.delete(key))),
    disconnect: vi.fn(() => afterReady(() => base.disconnect())),
    extendLock: vi.fn((lock, ttlMs) =>
      afterReady(() => base.extendLock(lock, ttlMs))
    ),
    get,
    isSubscribed: vi.fn((threadId) => afterReady(() => base.isSubscribed(threadId))),
    releaseLock: vi.fn((lock) => afterReady(() => base.releaseLock(lock))),
    set: vi.fn(set),
    subscribe: vi.fn((threadId) => afterReady(() => base.subscribe(threadId))),
    unsubscribe: vi.fn((threadId) => afterReady(() => base.unsubscribe(threadId))),
  };
}

function markSyncReady(client: ReturnType<typeof makeClient>) {
  const syncHandler = client.__handlers.get("sync");
  syncHandler?.("PREPARED");
}

function decodeCursorToken(cursor: string): {
  dir: "forward" | "backward";
  kind: string;
  roomID: string;
  rootEventID?: string;
  token: string;
} {
  if (!cursor.startsWith("mxv1:")) {
    throw new Error(`Expected mxv1 cursor, got: ${cursor}`);
  }
  return JSON.parse(Buffer.from(cursor.slice(5), "base64url").toString("utf8"));
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be present`);
  }
  return value;
}

function makeChatInstance(
  overrides: Partial<ChatInstance> & { state?: StateAdapter } = {}
): ChatInstance {
  const { state = makeStateAdapter(), ...chatOverrides } = overrides;
  const chat = new Chat({
    userName: "test-bot",
    adapters: {},
    state,
  });

  Object.assign(chat, chatOverrides);
  return chat;
}

function makeTestLogger() {
  const child = vi.fn<(prefix: string) => Logger>();
  const debug = vi.fn<(message: string, ...args: unknown[]) => void>();
  const info = vi.fn<(message: string, ...args: unknown[]) => void>();
  const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
  const error = vi.fn<(message: string, ...args: unknown[]) => void>();

  const logger: Logger = {
    child(prefix) {
      child(prefix);
      return logger;
    },
    debug,
    info,
    warn,
    error,
  };

  return {
    logger,
    child,
    debug,
    info,
    warn,
    error,
  };
}

async function makeInitializedAdapter(fakeClient: ReturnType<typeof makeClient>) {
  const adapter = new MatrixAdapter({
    baseURL: "https://hs.beeper.com",
    auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
    createClient: () => asMatrixClient(fakeClient),
  });
  await adapter.initialize(makeChatInstance());
  return adapter;
}

describe("MatrixAdapter", () => {
  it("encodes and decodes thread IDs", () => {
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
    });

    const encoded = adapter.encodeThreadId({
      roomID: "!room:beeper.com",
      rootEventID: "$root:beeper.com",
    });

    expect(encoded).toBe("matrix:!room%3Abeeper.com:%24root%3Abeeper.com");
    expect(adapter.decodeThreadId(encoded)).toEqual({
      roomID: "!room:beeper.com",
      rootEventID: "$root:beeper.com",
    });
  });

  it("parses slash commands from timeline messages", async () => {
    const fakeClient = makeClient();

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      createClient: () => asMatrixClient(fakeClient),
    });

    const processMessage = vi.fn();
    const processSlashCommand = vi.fn();

    await adapter.initialize(makeChatInstance({ processMessage, processSlashCommand }));

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    expect(timelineHandler).toBeTruthy();
    markSyncReady(fakeClient);

    timelineHandler?.(
      makeEvent({
        getId: () => "$cmd",
        getContent: () => ({ body: "/ping hi" }),
      }),
      { roomId: "!room:beeper.com" },
      false
    );
    await Promise.resolve();

    expect(processMessage).toHaveBeenCalledOnce();
    expect(processSlashCommand).toHaveBeenCalledOnce();
    expect(processSlashCommand.mock.calls[0][0]).toMatchObject({
      command: "/ping",
      text: "hi",
    });
  });

  it("logs and handles unexpected timeline processing failures", async () => {
    const fakeClient = makeClient();
    const logger = makeTestLogger();
    const processMessage = vi.fn(() => {
      throw new Error("boom");
    });

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      logger: logger.logger,
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance({ processMessage }));

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    expect(timelineHandler).toBeTruthy();
    markSyncReady(fakeClient);

    timelineHandler?.(makeEvent(), { roomId: "!room:beeper.com" }, false);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      "Unhandled Matrix timeline event failure",
      expect.objectContaining({
        eventId: "$event",
        eventType: EventType.RoomMessage,
        roomId: "!room:beeper.com",
        error: expect.any(Error),
      })
    );
  });

  it("auto-joins invite events from allowlisted inviters", async () => {
    const fakeClient = makeClient();
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      inviteAutoJoin: {
        enabled: true,
        inviterAllowlist: ["@alice:beeper.com"],
      },
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance());
    const timelineHandler = fakeClient.__handlers.get("Room.timeline");

    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomMember,
        getSender: () => "@alice:beeper.com",
        getStateKey: () => "@bot:beeper.com",
        getContent: () => ({ membership: "invite" }),
      }),
      { roomId: "!invited:beeper.com" },
      false
    );
    await Promise.resolve();

    expect(fakeClient.joinRoom).toHaveBeenCalledWith("!invited:beeper.com");
  });

  it("retries invite auto-join when the homeserver rate limits the join", async () => {
    const fakeClient = makeClient();
    const logger = makeTestLogger();
    fakeClient.joinRoom = vi
      .fn()
      .mockRejectedValueOnce(
        new MatrixError(
          {
            errcode: "M_LIMIT_EXCEEDED",
            error: "Too Many Requests",
            retry_after_ms: 0,
          },
          429
        )
      )
      .mockResolvedValueOnce({ room_id: "!invited:beeper.com" });
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      inviteAutoJoin: {
        enabled: true,
        inviterAllowlist: ["@alice:beeper.com"],
      },
      logger: logger.logger,
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance());
    const timelineHandler = fakeClient.__handlers.get("Room.timeline");

    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomMember,
        getSender: () => "@alice:beeper.com",
        getStateKey: () => "@bot:beeper.com",
        getContent: () => ({ membership: "invite" }),
      }),
      { roomId: "!invited:beeper.com" },
      false
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fakeClient.joinRoom).toHaveBeenCalledTimes(2);
    expect(fakeClient.joinRoom).toHaveBeenNthCalledWith(1, "!invited:beeper.com");
    expect(fakeClient.joinRoom).toHaveBeenNthCalledWith(2, "!invited:beeper.com");
    expect(logger.warn).toHaveBeenCalledWith(
      "Matrix invite auto-join rate limited, retrying",
      expect.objectContaining({
        roomId: "!invited:beeper.com",
        attempt: 1,
        maxAttempts: 3,
        retryDelayMs: 0,
        error: expect.any(MatrixError),
      })
    );
  });

  it("does not auto-join invite events from non-allowlisted inviters", async () => {
    const fakeClient = makeClient();
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      inviteAutoJoin: {
        enabled: true,
        inviterAllowlist: ["@trusted:beeper.com"],
      },
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance());
    const timelineHandler = fakeClient.__handlers.get("Room.timeline");

    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomMember,
        getSender: () => "@alice:beeper.com",
        getStateKey: () => "@bot:beeper.com",
        getContent: () => ({ membership: "invite" }),
      }),
      { roomId: "!blocked:beeper.com" },
      false
    );
    await Promise.resolve();

    expect(fakeClient.joinRoom).not.toHaveBeenCalled();
  });

  it("maps reaction add and redaction remove events", async () => {
    const fakeClient = makeClient();
    const processReaction = vi.fn();

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance({ processReaction }));

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    markSyncReady(fakeClient);

    timelineHandler?.(
      makeEvent({
        getId: () => "$reaction1",
        getType: () => EventType.Reaction,
        getContent: () => ({
          "m.relates_to": {
            rel_type: RelationType.Annotation,
            event_id: "$target",
            key: "👍",
          },
        }),
      }),
      { roomId: "!room:beeper.com" },
      false
    );

    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomRedaction,
        isRedaction: () => true,
        getAssociatedId: () => "$reaction1",
      }),
      { roomId: "!room:beeper.com" },
      false
    );
    await Promise.resolve();

    expect(processReaction).toHaveBeenCalledTimes(2);
    expect(processReaction.mock.calls[0][0]).toMatchObject({
      added: true,
      messageId: "$target",
      emoji: getEmoji("👍"),
    });
    expect(processReaction.mock.calls[1][0]).toMatchObject({
      added: false,
      messageId: "$target",
      emoji: getEmoji("👍"),
    });
  });

  it("routes reactions to thread context when target event belongs to a thread", async () => {
    const fakeClient = makeClient();
    fakeClient.getRoom.mockReturnValue(
      makeRoom({
        findEventById: (eventId?: string) =>
          eventId === "$target"
            ? makeEvent({
                getId: () => "$target",
                getRoomId: () => "!room:beeper.com",
                threadRootId: "$root",
              })
            : null,
      })
    );

    const processReaction = vi.fn();
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapter.initialize(makeChatInstance({ processReaction }));

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    markSyncReady(fakeClient);
    timelineHandler?.(
      makeEvent({
        getId: () => "$reaction2",
        getType: () => EventType.Reaction,
        getContent: () => ({
          "m.relates_to": {
            rel_type: RelationType.Annotation,
            event_id: "$target",
            key: "🔥",
          },
        }),
      }),
      { roomId: "!room:beeper.com" },
      false
    );
    await Promise.resolve();

    expect(processReaction).toHaveBeenCalledOnce();
    expect(processReaction.mock.calls[0][0]).toMatchObject({
      threadId: "matrix:!room%3Abeeper.com:%24root",
      messageId: "$target",
      emoji: getEmoji("🔥"),
      added: true,
    });
  });

  it("initializes rust crypto and decrypts encrypted events when e2ee is enabled", async () => {
    const fakeClient = makeClient();
    const processMessage = vi.fn();

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      deviceID: "DEVICE1",
      createClient: () => asMatrixClient(fakeClient),
      e2ee: { enabled: true },
    });

    await adapter.initialize(makeChatInstance({ processMessage }));

    expect(fakeClient.initRustCrypto).toHaveBeenCalledOnce();

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    markSyncReady(fakeClient);
    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomMessageEncrypted,
        getContent: () => ({ body: "secret" }),
      }),
      { roomId: "!room:beeper.com" },
      false
    );

    await Promise.resolve();
    expect(fakeClient.decryptEventIfNeeded).toHaveBeenCalledOnce();
  });

  it("enables e2ee when recovery key is provided", () => {
    const adapter = getInternals(
      createMatrixAdapter({
        baseURL: "https://hs.beeper.com",
        auth: {
          type: "accessToken",
          accessToken: "token",
          userID: "@bot:beeper.com",
        },
        recoveryKey: "s3cr3t-recovery-key",
      })
    );

    expect(adapter.e2eeConfig?.enabled).toBe(true);
  });

  it("decodes recovery key for secret storage callback", () => {
    const recoveryKey = encodeRecoveryKey(new Uint8Array(32).fill(7));
    expect(recoveryKey).toBeDefined();
    const validatedRecoveryKey = requireValue(recoveryKey, "recoveryKey");

    const adapter = getInternals(
      createMatrixAdapter({
        baseURL: "https://hs.beeper.com",
        auth: {
          type: "accessToken",
          accessToken: "token",
          userID: "@bot:beeper.com",
        },
        recoveryKey: validatedRecoveryKey,
      })
    );

    const result = adapter.getSecretStorageKeyFromRecoveryKey({
      keys: {
        key1: {},
      },
    });

    expect(result).not.toBeNull();
    expect(result?.[0]).toBe("key1");
    expect(result?.[1]).toBeInstanceOf(Uint8Array);
  });

  it("sends Matrix edit payload with dont_render_edited context", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    await adapter.editMessage(
      "matrix:!room%3Abeeper.com",
      "$original",
      "updated body"
    );

    expect(fakeClient.sendEvent).toHaveBeenCalledWith(
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        "com.beeper.dont_render_edited": true,
        "m.new_content": {
          "com.beeper.dont_render_edited": true,
          msgtype: "m.text",
          body: "updated body",
        },
        "m.relates_to": {
          rel_type: RelationType.Replace,
          event_id: "$original",
        },
      })
    );
  });

  it("parses Matrix formatted_body, strips reply fallback, and maps author metadata", async () => {
    const fakeClient = makeClient();
    fakeClient.getRoom = vi.fn(() =>
      makeRoom({
        name: "Product Sync",
        getMember: makeRoomMembers({
          "@alice:beeper.com": {
            name: "Alice Example",
            rawDisplayName: "Alice Example",
          },
        }),
      })
    );
    fakeClient.fetchRoomEvent = vi.fn(async () =>
      makeRawEvent({
        event_id: "$formatted",
        sender: "@alice:beeper.com",
        content: {
          body: "> <@alice:beeper.com> replied\n> quoted\n\nHello @bot there",
          msgtype: MsgType.Text,
          format: "org.matrix.custom.html",
          formatted_body:
            '<mx-reply><blockquote>quoted</blockquote></mx-reply><p>Hello <a href="https://matrix.to/#/%40bot%3Abeeper.com">@bot</a> <strong>there</strong></p>',
          "m.mentions": {
            user_ids: ["@bot:beeper.com"],
          },
        },
      })
    );

    const adapter = await makeInitializedAdapter(fakeClient);
    const message = await adapter.fetchMessage(
      "matrix:!room%3Abeeper.com",
      "$formatted"
    );

    expect(message).toBeTruthy();
    expect(message?.text).toBe("Hello @bot there");
    expect(
      stringifyMarkdown(requireValue(message, "formatted message").formatted).trim()
    ).toBe(
      "Hello @bot **there**"
    );
    expect(message?.isMention).toBe(true);
    expect(message?.author).toMatchObject({
      userId: "@alice:beeper.com",
      userName: "alice",
      fullName: "Alice Example",
      isBot: "unknown",
      isMe: false,
    });
  });

  it("strips Matrix reply fallback from plain body text", async () => {
    const fakeClient = makeClient();
    fakeClient.fetchRoomEvent = vi.fn(async () =>
      makeRawEvent({
        event_id: "$reply-body",
        content: {
          body: "> <@alice:beeper.com> replied\n> quoted line\n\nVisible reply body",
          msgtype: MsgType.Text,
        },
      })
    );

    const adapter = await makeInitializedAdapter(fakeClient);
    const message = await adapter.fetchMessage(
      "matrix:!room%3Abeeper.com",
      "$reply-body"
    );

    expect(message?.text).toBe("Visible reply body");
    expect(
      stringifyMarkdown(requireValue(message, "reply body message").formatted).trim()
    ).toBe(
      "Visible reply body"
    );
  });

  it("surfaces editedAt from aggregated replacement metadata", async () => {
    const fakeClient = makeClient();
    const editedAt = 1_700_000_123_000;
    fakeClient.createMessagesRequest = vi.fn(async () => ({
      chunk: [
        makeRawEvent({
          event_id: "$edited",
          content: {
            body: "Original body",
            msgtype: MsgType.Text,
          },
          unsigned: {
            "m.relations": {
              "m.replace": {
                content: {
                  "m.new_content": {
                    body: "Edited body",
                    msgtype: MsgType.Text,
                  },
                },
                origin_server_ts: editedAt,
              },
            },
          },
        }),
      ],
    }));

    const adapter = await makeInitializedAdapter(fakeClient);
    const result = await adapter.fetchMessages("matrix:!room%3Abeeper.com");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Edited body");
    expect(result.messages[0]?.metadata.edited).toBe(true);
    expect(result.messages[0]?.metadata.editedAt).toEqual(new Date(editedAt));
  });

  it("renders outbound markdown and mention placeholders as Matrix rich text", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    await adapter.postMessage("matrix:!room%3Abeeper.com", {
      markdown: "Hello **team** <@@alice:beeper.com>",
    });

    expect(fakeClient.sendEvent).toHaveBeenCalledWith(
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        body: "Hello team @alice",
        msgtype: MsgType.Text,
        format: "org.matrix.custom.html",
        formatted_body: expect.stringContaining("<strong>team</strong>"),
        "m.mentions": {
          user_ids: ["@alice:beeper.com"],
        },
      })
    );
    expect(fakeClient.sendEvent).toHaveBeenCalledWith(
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        formatted_body: expect.stringContaining(
          "https://matrix.to/#/%40alice%3Abeeper.com"
        ),
      })
    );
  });

  it("enriches thread and channel metadata from Matrix room state", async () => {
    const fakeClient = makeClient();
    fakeClient.getRoom = vi.fn(() =>
      makeRoom({
        name: "Adapter QA",
        currentState: makeRoomState({
          "m.room.avatar": { url: "mxc://beeper.com/avatar" },
          "m.room.canonical_alias": { alias: "#adapter:beeper.com" },
          "m.room.encryption": { algorithm: "m.megolm.v1.aes-sha2" },
          "m.room.topic": { topic: "Adapter verification" },
        }),
        hasEncryptionStateEvent: () => true,
      })
    );

    const adapter = await makeInitializedAdapter(fakeClient);
    const thread = await adapter.fetchThread(
      adapter.encodeThreadId({
        roomID: "!room:beeper.com",
        rootEventID: "$root",
      })
    );
    const channel = await adapter.fetchChannelInfo("matrix:!room%3Abeeper.com");

    expect(thread.channelName).toBe("Adapter QA");
    expect(thread.metadata).toMatchObject({
      roomID: "!room:beeper.com",
      canonicalAlias: "#adapter:beeper.com",
      topic: "Adapter verification",
      avatarURL: "mxc://beeper.com/avatar",
      encrypted: true,
      encryptionAlgorithm: "m.megolm.v1.aes-sha2",
      isDM: false,
      name: "Adapter QA",
    });
    expect(channel.name).toBe("Adapter QA");
    expect(channel.metadata).toMatchObject(thread.metadata ?? {});
  });

  it("uploads file payloads and posts Matrix media events", async () => {
    const fakeClient = makeClient();
    fakeClient.sendEvent = vi
      .fn()
      .mockResolvedValueOnce({ event_id: "$text" })
      .mockResolvedValueOnce({ event_id: "$file" });
    fakeClient.uploadContent = vi
      .fn()
      .mockResolvedValueOnce({ content_uri: "mxc://beeper.com/file-1" });

    const adapter = await makeInitializedAdapter(fakeClient);

    await adapter.postMessage("matrix:!room%3Abeeper.com", {
      markdown: "File incoming",
      files: [
        {
          data: new Uint8Array([1, 2, 3]).buffer,
          filename: "report.png",
          mimeType: "image/png",
        },
      ],
    });

    expect(fakeClient.uploadContent).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({
        name: "report.png",
        type: "image/png",
      })
    );
    expect(fakeClient.sendEvent).toHaveBeenNthCalledWith(
      1,
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        body: "File incoming",
        msgtype: "m.text",
      })
    );
    expect(fakeClient.sendEvent).toHaveBeenNthCalledWith(
      2,
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        body: "report.png",
        msgtype: "m.image",
        url: "mxc://beeper.com/file-1",
      })
    );
  });

  it("skips invalid file uploads instead of passing malformed entries downstream", async () => {
    const fakeClient = makeClient();
    const logger = makeTestLogger();
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      logger: logger.logger,
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapter.initialize(makeChatInstance());

    await adapter.postMessage("matrix:!room%3Abeeper.com", {
      files: [
        { data: new Uint8Array([1, 2, 3]), filename: "valid.bin" },
        { data: new Uint8Array([4, 5, 6]), filename: "   " },
        { data: "not-binary", filename: "invalid.txt" },
      ],
    } as never);

    expect(fakeClient.uploadContent).toHaveBeenCalledTimes(1);
    expect(fakeClient.uploadContent).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ name: "valid.bin" })
    );
    expect(logger.warn).toHaveBeenCalledWith("Skipping invalid Matrix file upload", {
      filename: "invalid.txt",
    });
  });

  it("falls back to a synthetic MatrixEvent when a sent event is not yet in the timeline", async () => {
    const fakeClient = makeClient();
    fakeClient.getRoom.mockReturnValue(
      makeRoom({
        findEventById: () => null,
      })
    );
    fakeClient.sendEvent.mockResolvedValue({ event_id: "$missing" });

    const adapter = await makeInitializedAdapter(fakeClient);
    const sent = await adapter.postMessage("matrix:!room%3Abeeper.com", "hello");

    expect(sent.id).toBe("$missing");
    expect(sent.raw.getId()).toBe("$missing");
    expect(sent.raw.getRoomId()).toBe("!room:beeper.com");
    expect(sent.raw.getContent()).toMatchObject({ body: "hello", msgtype: "m.text" });
  });

  it("logs and rethrows Matrix send failures", async () => {
    const fakeClient = makeClient();
    const logger = makeTestLogger();
    const sendError = new Error("send failed");
    fakeClient.sendEvent = vi.fn().mockRejectedValue(sendError);

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      logger: logger.logger,
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapter.initialize(makeChatInstance());

    await expect(
      adapter.postMessage("matrix:!room%3Abeeper.com", "hello")
    ).rejects.toThrow("send failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Matrix send message failed",
      expect.objectContaining({
        roomId: "!room:beeper.com",
        eventType: EventType.RoomMessage,
        msgtype: "m.text",
        error: sendError,
      })
    );
  });

  it("logs and rethrows Matrix upload failures", async () => {
    const fakeClient = makeClient();
    const logger = makeTestLogger();
    const uploadError = new Error("upload failed");
    fakeClient.uploadContent = vi.fn().mockRejectedValue(uploadError);

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      logger: logger.logger,
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapter.initialize(makeChatInstance());

    await expect(
      adapter.postMessage("matrix:!room%3Abeeper.com", {
        markdown: "File incoming",
        files: [
          {
            data: new Uint8Array([1, 2, 3]).buffer,
            filename: "report.png",
            mimeType: "image/png",
          },
        ],
      })
    ).rejects.toThrow("upload failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Matrix upload content failed",
      expect.objectContaining({
        fileName: "report.png",
        mimeType: "image/png",
        msgtype: "m.image",
        error: uploadError,
      })
    );
  });

  it("rejects empty outbound messages instead of posting blank content", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    await expect(
      adapter.postMessage("matrix:!room%3Abeeper.com", "")
    ).rejects.toThrow("Cannot post an empty Matrix message.");
    expect(fakeClient.sendEvent).not.toHaveBeenCalled();
  });

  it("appends URL-only attachments to message body", async () => {
    const fakeClient = makeClient();
    fakeClient.sendEvent = vi.fn(async () => ({ event_id: "$text" }));
    const adapter = await makeInitializedAdapter(fakeClient);

    await adapter.postMessage("matrix:!room%3Abeeper.com", {
      raw: "See attachment",
      attachments: [
        {
          type: "file",
          name: "spec",
          url: "https://example.com/spec.pdf",
        },
      ],
    });

    expect(fakeClient.uploadContent).not.toHaveBeenCalled();
    expect(fakeClient.sendEvent).toHaveBeenCalledWith(
      "!room:beeper.com",
      EventType.RoomMessage,
      expect.objectContaining({
        msgtype: "m.text",
        body: "See attachment\n\nspec: https://example.com/spec.pdf",
      })
    );
  });

  it("generates and persists a device id when one is not provided", async () => {
    const adapter = getInternals(
      new MatrixAdapter({
        baseURL: "https://hs.beeper.com",
        auth: {
          type: "accessToken",
          accessToken: "token",
          userID: "@bot:beeper.com",
        },
      })
    );
    const state = makeStateAdapter();
    adapter.stateAdapter = state;

    await adapter.resolveDeviceID();

    expect(adapter.deviceID).toMatch(/^chatsdk_[A-Z0-9]{8}$/);
    expect(state.set).toHaveBeenCalled();
  });

  it("reuses persisted device id when available", async () => {
    const persistedDeviceID = "chatsdk_ABCDEFGH";
    const state = makeStateAdapter({
      "matrix:device:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com":
        persistedDeviceID,
    });

    const adapter = getInternals(
      new MatrixAdapter({
        baseURL: "https://hs.beeper.com",
        auth: {
          type: "accessToken",
          accessToken: "token",
          userID: "@bot:beeper.com",
        },
        deviceID: "   ",
      })
    );
    adapter.stateAdapter = state;

    await adapter.resolveDeviceID();

    expect(adapter.deviceID).toBe(persistedDeviceID);
  });

  it("supports typed username/password auth config", () => {
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "password",
        username: "bot",
        password: "secret",
      },
    });

    expect(adapter).toBeInstanceOf(MatrixAdapter);
  });

  it("shuts down matrix client cleanly", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    await adapter.shutdown();
    expect(fakeClient.stopClient).toHaveBeenCalledOnce();
  });

  it("persists and reloads matrix session via chat state", async () => {
    const baseURL = "https://hs.beeper.com";
    const state = makeStateAdapter();

    const adapter = getInternals(new MatrixAdapter({
      baseURL,
      auth: {
        type: "password",
        username: "bot",
        password: "secret",
      },
    }));

    adapter.stateAdapter = state;

    await adapter.persistSession({
      accessToken: "persisted-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE1",
    });

    const restored = await adapter.loadPersistedSession();

    expect(state.set).toHaveBeenCalled();
    expect(restored).toMatchObject({
      accessToken: "persisted-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE1",
    });

    expect(state.set).toHaveBeenCalledWith(
      "matrix:session:https%3A%2F%2Fhs.beeper.com:username:bot",
      expect.objectContaining({}),
      undefined
    );
  });

  it("reuses persisted password session before password login", async () => {
    const baseURL = "https://hs.beeper.com";
    const sessionKey = `matrix:session:${encodeURIComponent(baseURL)}:username:${encodeURIComponent("bot")}`;
    const state = makeStateAdapter({
      [sessionKey]: {
        accessToken: "persisted-token",
        authType: "password",
        baseURL,
        createdAt: new Date().toISOString(),
        e2eeEnabled: false,
        recoveryKeyPresent: false,
        updatedAt: new Date().toISOString(),
        userID: "@bot:beeper.com",
        username: "bot",
      },
    });

    const loginWithPassword = vi.fn(async () => {
      throw new Error("should not login");
    });
    const whoami = vi.fn(async () => ({
      user_id: "@bot:beeper.com",
      device_id: "DEVICE1",
    }));

    const adapter = new MatrixAdapter({
      baseURL,
      auth: { type: "password", username: "bot", password: "secret" },
      createBootstrapClient: () =>
        ({
          loginWithPassword,
          whoami,
        }),
    });

    const internals = getInternals(adapter);
    internals.stateAdapter = state;
    const resolved = await internals.resolveAuth();

    expect(resolved).toMatchObject({
      accessToken: "persisted-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE1",
    });
    expect(whoami).toHaveBeenCalledOnce();
    expect(loginWithPassword).not.toHaveBeenCalled();
  });

  it("falls back to password login when persisted session is invalid", async () => {
    const baseURL = "https://hs.beeper.com";
    const sessionKey = `matrix:session:${encodeURIComponent(baseURL)}:username:${encodeURIComponent("bot")}`;
    const state = makeStateAdapter({
      [sessionKey]: {
        accessToken: "invalid-token",
        authType: "password",
        baseURL,
        createdAt: new Date().toISOString(),
        e2eeEnabled: false,
        recoveryKeyPresent: false,
        updatedAt: new Date().toISOString(),
        userID: "@bot:beeper.com",
        username: "bot",
      },
    });

    const loginWithPassword = vi.fn(async () => ({
      access_token: "fresh-token",
      user_id: "@bot:beeper.com",
      device_id: "DEVICE2",
    }));
    const whoami = vi
      .fn()
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce({
        user_id: "@bot:beeper.com",
      });

    const adapter = new MatrixAdapter({
      baseURL,
      auth: { type: "password", username: "bot", password: "secret" },
      createBootstrapClient: () =>
        ({
          loginWithPassword,
          whoami,
        }),
    });

    const internals = getInternals(adapter);
    internals.stateAdapter = state;
    const resolved = await internals.resolveAuth();

    expect(loginWithPassword).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      accessToken: "fresh-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE2",
    });
  });

  it("uses loginRequest for password login and forwards deviceID", async () => {
    const loginRequest = vi.fn(async () => ({
      access_token: "fresh-token",
      user_id: "@bot:beeper.com",
      device_id: "DEVICE2",
    }));
    const loginWithPassword = vi.fn(async () => {
      throw new Error("should not use loginWithPassword");
    });

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "password",
        username: "bot",
        password: "secret",
      },
      deviceID: "DEVICE1",
      createBootstrapClient: () =>
        ({
          loginRequest,
          loginWithPassword,
          whoami: vi.fn(),
        }),
    });

    const internals = getInternals(adapter);
    internals.stateAdapter = makeStateAdapter();
    const resolved = await internals.resolveAuth();

    expect(loginRequest).toHaveBeenCalledOnce();
    expect(loginRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: "DEVICE1",
        identifier: { type: "m.id.user", user: "bot" },
        password: "secret",
        type: "m.login.password",
        user: "bot",
      })
    );
    expect(loginWithPassword).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      accessToken: "fresh-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE2",
    });
  });

  it("uses whoami device_id for access token auth", async () => {
    const whoami = vi.fn(async () => ({
      user_id: "@bot:beeper.com",
      device_id: "DEVICE_FROM_WHOAMI",
    }));

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      deviceID: "DEVICE_FALLBACK",
      createBootstrapClient: () =>
        ({
          whoami,
          loginWithPassword: vi.fn(),
        }),
    });

    const internals = getInternals(adapter);
    internals.stateAdapter = makeStateAdapter();
    const resolved = await internals.resolveAuth();

    expect(whoami).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      accessToken: "token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE_FROM_WHOAMI",
    });
  });

  it("rejects legacy cursors for API pagination", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    await expect(
      adapter.fetchMessages("matrix:!room%3Abeeper.com", { cursor: "$legacy_cursor" })
    ).rejects.toThrow("Invalid cursor format. Expected mxv1 cursor.");
  });

  it("rejects cursors reused with a different fetch direction", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    const cursor = `mxv1:${Buffer.from(
      JSON.stringify({
        dir: "backward",
        kind: "room_messages",
        roomID: "!room:beeper.com",
        token: "room-page-token-1",
      }),
      "utf8"
    ).toString("base64url")}`;

    await expect(
      adapter.fetchMessages("matrix:!room%3Abeeper.com", {
        direction: "forward",
        limit: 10,
        cursor,
      })
    ).rejects.toThrow("Invalid cursor direction. Expected forward.");
  });

  it("fetches non-thread messages via matrix API with mxv1 cursor", async () => {
    const fakeClient = makeClient();
    fakeClient.createMessagesRequest
      .mockResolvedValueOnce({
        chunk: [
          makeRawEvent({
            event_id: "$top2",
            origin_server_ts: 1_700_000_000_200,
            content: { body: "top-2" },
          }),
          makeRawEvent({
            event_id: "$reply1",
            origin_server_ts: 1_700_000_000_100,
            content: {
              body: "reply-1",
              "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
            },
          }),
          makeRawEvent({
            event_id: "$top1",
            origin_server_ts: 1_700_000_000_050,
            content: { body: "top-1" },
          }),
        ],
        end: "room-page-token-1",
      })
      .mockResolvedValueOnce({
        chunk: [],
        end: undefined,
      });

    const adapter = await makeInitializedAdapter(fakeClient);

    const firstPage = await adapter.fetchMessages("matrix:!room%3Abeeper.com", {
      direction: "backward",
      limit: 10,
    });

    expect(firstPage.messages.map((message) => message.id)).toEqual([
      "$top1",
      "$top2",
    ]);
    expect(firstPage.nextCursor).toBeTruthy();
    const decoded = decodeCursorToken(
      requireValue(firstPage.nextCursor, "firstPage.nextCursor")
    );
    expect(decoded).toMatchObject({
      kind: "room_messages",
      token: "room-page-token-1",
      roomID: "!room:beeper.com",
      dir: "backward",
    });

    await adapter.fetchMessages("matrix:!room%3Abeeper.com", {
      direction: "backward",
      limit: 10,
      cursor: firstPage.nextCursor,
    });
    expect(fakeClient.createMessagesRequest).toHaveBeenNthCalledWith(
      2,
      "!room:beeper.com",
      "room-page-token-1",
      10,
      "b"
    );
  });

  it("fetches thread messages via relations and includes root on first page", async () => {
    const fakeClient = makeClient();
    fakeClient.relations.mockResolvedValue({
      originalEvent: null,
      events: [
        makeEvent({
          getId: () => "$reply2",
          getTs: () => 1_700_000_000_400,
          getRoomId: () => "!room:beeper.com",
          getContent: () => ({
            body: "reply-2",
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          }),
          threadRootId: "$root",
          isRelation: () => true,
        }),
        makeEvent({
          getId: () => "$reply1",
          getTs: () => 1_700_000_000_300,
          getRoomId: () => "!room:beeper.com",
          getContent: () => ({
            body: "reply-1",
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          }),
          threadRootId: "$root",
          isRelation: () => true,
        }),
      ],
      nextBatch: "thread-page-token-1",
      prevBatch: null,
    });
    fakeClient.fetchRoomEvent.mockResolvedValue(
      makeRawEvent({
        event_id: "$root",
        origin_server_ts: 1_700_000_000_100,
        content: { body: "root" },
      })
    );

    const adapter = await makeInitializedAdapter(fakeClient);

    const page = await adapter.fetchMessages(
      "matrix:!room%3Abeeper.com:%24root",
      { direction: "forward", limit: 3 }
    );

    expect(page.messages.map((message) => message.id)).toEqual([
      "$root",
      "$reply1",
      "$reply2",
    ]);
    expect(page.messages.every((message) => message.threadId.endsWith(":%24root"))).toBe(
      true
    );
    expect(page.nextCursor).toBeTruthy();
    expect(
      decodeCursorToken(requireValue(page.nextCursor, "thread page nextCursor"))
    ).toMatchObject({
      kind: "thread_relations",
      token: "thread-page-token-1",
      roomID: "!room:beeper.com",
      rootEventID: "$root",
      dir: "forward",
    });
  });

  it("fetches channel-level messages through fetchChannelMessages", async () => {
    const fakeClient = makeClient();
    fakeClient.createMessagesRequest.mockResolvedValue({
      chunk: [
        makeRawEvent({
          event_id: "$reply",
          origin_server_ts: 1_700_000_000_200,
          content: {
            body: "reply",
            "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          },
        }),
        makeRawEvent({
          event_id: "$top",
          origin_server_ts: 1_700_000_000_050,
          content: { body: "top" },
        }),
      ],
      end: "channel-page-token-1",
    });

    const adapter = await makeInitializedAdapter(fakeClient);

    const result = await adapter.fetchChannelMessages?.("matrix:!room%3Abeeper.com", {
      direction: "backward",
      limit: 20,
    });

    expect(result?.messages.map((message) => message.id)).toEqual(["$top"]);
    expect(result?.nextCursor).toBeTruthy();
    const nextCursor = requireValue(result?.nextCursor, "channel nextCursor");
    expect(decodeCursorToken(nextCursor)).toMatchObject({
      kind: "room_messages",
      token: "channel-page-token-1",
      roomID: "!room:beeper.com",
    });
  });

  it("filters edit relations from room history", async () => {
    const fakeClient = makeClient();
    fakeClient.createMessagesRequest.mockResolvedValue({
      chunk: [
        makeRawEvent({
          event_id: "$edit",
          origin_server_ts: 1_700_000_000_150,
          content: {
            body: "edited",
            "m.relates_to": { rel_type: RelationType.Replace, event_id: "$top" },
          },
        }),
        makeRawEvent({
          event_id: "$top",
          origin_server_ts: 1_700_000_000_050,
          content: { body: "top" },
        }),
      ],
      end: undefined,
    });

    const adapter = await makeInitializedAdapter(fakeClient);

    const result = await adapter.fetchMessages("matrix:!room%3Abeeper.com", {
      direction: "backward",
      limit: 20,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["$top"]);
  });

  it("applies server-aggregated edits to fetched messages", async () => {
    const fakeClient = makeClient();
    fakeClient.fetchRoomEvent.mockResolvedValueOnce(
      makeRawEvent({
        event_id: "$top",
        origin_server_ts: 1_700_000_000_050,
        content: { body: "top" },
        unsigned: {
          "m.relations": {
            [RelationType.Replace]: {
              event_id: "$edit",
              content: {
                body: "* edited",
                "m.new_content": {
                  body: "edited",
                  msgtype: MsgType.Text,
                },
              },
            },
          },
        },
      })
    );

    const adapter = await makeInitializedAdapter(fakeClient);

    const message = await adapter.fetchMessage?.("matrix:!room%3Abeeper.com", "$top");

    expect(message?.text).toBe("edited");
    expect(message?.metadata.edited).toBe(true);
  });

  it("fetches a single message in context and returns null for mismatches", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);

    fakeClient.fetchRoomEvent
      .mockResolvedValueOnce(
        makeRawEvent({
          event_id: "$root",
          origin_server_ts: 1_700_000_000_000,
          content: { body: "root" },
        })
      )
      .mockResolvedValueOnce(
        makeRawEvent({
          event_id: "$reply-other-thread",
          origin_server_ts: 1_700_000_000_000,
          content: {
            body: "wrong thread",
            "m.relates_to": { rel_type: "m.thread", event_id: "$another-root" },
          },
        })
      );
    const message = await adapter.fetchMessage?.("matrix:!room%3Abeeper.com:%24root", "$root");
    expect(message?.id).toBe("$root");
    expect(message?.threadId).toBe("matrix:!room%3Abeeper.com:%24root");
    const mismatch = await adapter.fetchMessage?.(
      "matrix:!room%3Abeeper.com:%24root",
      "$reply-other-thread"
    );
    expect(mismatch).toBeNull();
  });

  it("fetchMessage returns null when server returns M_NOT_FOUND", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);
    fakeClient.fetchRoomEvent.mockRejectedValueOnce(
      new MatrixError({ errcode: "M_NOT_FOUND", error: "Event not found" }, 404)
    );
    const result = await adapter.fetchMessage?.(
      "matrix:!room%3Abeeper.com:%24root",
      "$missing"
    );
    expect(result).toBeNull();
  });

  it("fetchMessage propagates transient server errors", async () => {
    const fakeClient = makeClient();
    const adapter = await makeInitializedAdapter(fakeClient);
    fakeClient.fetchRoomEvent.mockRejectedValueOnce(
      new MatrixError({ errcode: "M_UNKNOWN", error: "Internal server error" }, 500)
    );
    await expect(
      adapter.fetchMessage?.("matrix:!room%3Abeeper.com:%24root", "$event")
    ).rejects.toThrow("Internal server error");
  });

  it("preserves attachment metadata and fetchData for Matrix media events", async () => {
    const fakeClient = makeClient();
    fakeClient.fetchRoomEvent.mockResolvedValueOnce(
      makeRawEvent({
        event_id: "$file",
        origin_server_ts: 1_700_000_000_000,
        content: {
          body: "report.txt",
          msgtype: MsgType.File,
          url: "mxc://beeper.com/file-1",
          info: {
            mimetype: "text/plain",
            size: 7,
          },
        },
      })
    );
    fakeClient.mxcUrlToHttp.mockReturnValueOnce(
      "https://hs.beeper.com/_matrix/client/v1/media/download/beeper.com/file-1"
    );

    const fetchMock = vi.fn(async () =>
      new Response(Buffer.from("payload"), {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const adapter = await makeInitializedAdapter(fakeClient);
      const message = await adapter.fetchMessage?.(
        "matrix:!room%3Abeeper.com",
        "$file"
      );

      expect(message?.attachments).toHaveLength(1);
      expect(message?.attachments[0]).toMatchObject({
        type: "file",
        name: "report.txt",
        mimeType: "text/plain",
        size: 7,
        url: "mxc://beeper.com/file-1",
      });
      await expect(message?.attachments[0]?.fetchData?.()).resolves.toEqual(
        Buffer.from("payload")
      );
      expect(fakeClient.mxcUrlToHttp).toHaveBeenCalledWith(
        "mxc://beeper.com/file-1",
        undefined,
        undefined,
        undefined,
        true,
        true,
        true
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://hs.beeper.com/_matrix/client/v1/media/download/beeper.com/file-1",
        {
          headers: {
            Authorization: "Bearer token",
          },
        }
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("openDM reuses cached mapping, then m.direct mapping, then creates and persists", async () => {
    const fakeClient = makeClient();
    const cachedState = makeStateAdapter({
      "matrix:dm:%40bob%3Abeeper.com": "!cached-dm:beeper.com",
    });
    const adapterFromCache = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapterFromCache.initialize(makeChatInstance({ state: cachedState }));
    const cachedThread = await adapterFromCache.openDM("@bob:beeper.com");
    expect(cachedThread).toBe("matrix:!cached-dm%3Abeeper.com");
    expect(fakeClient.createRoom).not.toHaveBeenCalled();

    const directState = makeStateAdapter();
    fakeClient.getAccountDataFromServer.mockResolvedValue({
      "@bob:beeper.com": ["!from-direct:beeper.com"],
    });
    const adapterFromDirect = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapterFromDirect.initialize(makeChatInstance({ state: directState }));
    const directThread = await adapterFromDirect.openDM("@bob:beeper.com");
    expect(directThread).toBe("matrix:!from-direct%3Abeeper.com");
    expect(directState.set).toHaveBeenCalledWith(
      "matrix:dm:%40bob%3Abeeper.com",
      "!from-direct:beeper.com"
    );

    const createState = makeStateAdapter();
    fakeClient.getAccountDataFromServer.mockResolvedValue({});
    fakeClient.createRoom.mockResolvedValue({ room_id: "!created-dm:beeper.com" });
    fakeClient.setAccountData.mockResolvedValue({});
    const adapterCreate = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapterCreate.initialize(makeChatInstance({ state: createState }));
    const createdThread = await adapterCreate.openDM("@bob:beeper.com");
    expect(createdThread).toBe("matrix:!created-dm%3Abeeper.com");
    expect(fakeClient.createRoom).toHaveBeenCalledWith({
      invite: ["@bob:beeper.com"],
      is_direct: true,
    });
    expect(fakeClient.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@bob:beeper.com": ["!created-dm:beeper.com"],
    });
    expect(createState.set).toHaveBeenCalledWith(
      "matrix:dm:%40bob%3Abeeper.com",
      "!created-dm:beeper.com"
    );
  });

  it("openDM skips direct mappings for rooms the bot already left", async () => {
    const fakeClient = makeClient();
    fakeClient.getAccountDataFromServer.mockResolvedValue({
      "@bob:beeper.com": ["!stale-dm:beeper.com", "!active-dm:beeper.com"],
    });
    fakeClient.getRoom.mockImplementation((roomID?: string) => {
      if (roomID === "!stale-dm:beeper.com") {
        return makeRoom({
          roomId: roomID,
          name: "Stale DM",
          getMyMembership: () => "leave",
        });
      }
      if (roomID === "!active-dm:beeper.com") {
        return makeRoom({
          roomId: roomID,
          name: "Active DM",
          getMyMembership: () => "join",
        });
      }
      return null;
    });

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });
    await adapter.initialize(makeChatInstance());

    const threadID = await adapter.openDM("@bob:beeper.com");

    expect(threadID).toBe("matrix:!active-dm%3Abeeper.com");
    expect(fakeClient.createRoom).not.toHaveBeenCalled();
  });

  it("openDM clears stale cached mappings before creating a fresh DM", async () => {
    const fakeClient = makeClient();
    fakeClient.getRoom.mockImplementation((roomID?: string) => {
      if (roomID === "!stale-dm:beeper.com") {
        return null;
      }
      return makeRoom({ roomId: roomID ?? "!room:beeper.com" });
    });
    fakeClient.getAccountDataFromServer.mockResolvedValue({});
    fakeClient.createRoom.mockResolvedValue({ room_id: "!fresh-dm:beeper.com" });

    const state = makeStateAdapter({
      "matrix:dm:%40bob%3Abeeper.com": "!stale-dm:beeper.com",
    });
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance({ state }));
    const threadId = await adapter.openDM("@bob:beeper.com");

    expect(threadId).toBe("matrix:!fresh-dm%3Abeeper.com");
    expect(state.delete).toHaveBeenCalledWith("matrix:dm:%40bob%3Abeeper.com");
    expect(fakeClient.createRoom).toHaveBeenCalledOnce();
  });

  it("merges fresh m.direct account data before persisting a newly created DM", async () => {
    const fakeClient = makeClient();
    fakeClient.getAccountDataFromServer
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        "@bob:beeper.com": ["!existing-dm:beeper.com"],
        "@carol:beeper.com": ["!carol-dm:beeper.com"],
      });
    fakeClient.createRoom.mockResolvedValue({ room_id: "!new-dm:beeper.com" });

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
      createClient: () => asMatrixClient(fakeClient),
    });

    await adapter.initialize(makeChatInstance({ state: makeStateAdapter() }));
    await adapter.openDM("@bob:beeper.com");

    expect(fakeClient.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@bob:beeper.com": ["!existing-dm:beeper.com", "!new-dm:beeper.com"],
      "@carol:beeper.com": ["!carol-dm:beeper.com"],
    });
  });

  it("lists threads using server-side thread API with mxv1 cursor", async () => {
    const fakeClient = makeClient();
    fakeClient.createThreadListMessagesRequest.mockResolvedValue({
      chunk: [
        makeRawEvent({
          event_id: "$root2",
          origin_server_ts: 1_700_000_000_200,
          content: { body: "Root 2" },
          unsigned: {
            "m.relations": {
              "m.thread": {
                count: 4,
                latest_event: { origin_server_ts: 1_700_000_000_900 },
              },
            },
          },
        }),
        makeRawEvent({
          event_id: "$root1",
          origin_server_ts: 1_700_000_000_100,
          content: { body: "Root 1" },
          unsigned: {
            "m.relations": {
              "m.thread": {
                count: 2,
                latest_event: { origin_server_ts: 1_700_000_000_500 },
              },
            },
          },
        }),
      ],
      end: "thread-list-page-token-1",
    });

    const adapter = await makeInitializedAdapter(fakeClient);

    const result = await adapter.listThreads("matrix:!room%3Abeeper.com", { limit: 2 });

    expect(result.threads.map((thread) => thread.id)).toEqual([
      "matrix:!room%3Abeeper.com:%24root2",
      "matrix:!room%3Abeeper.com:%24root1",
    ]);
    expect(result.threads.map((thread) => thread.replyCount)).toEqual([4, 2]);
    expect(result.nextCursor).toBeTruthy();
    expect(
      decodeCursorToken(requireValue(result.nextCursor, "thread list nextCursor"))
    ).toMatchObject({
      kind: "thread_list",
      token: "thread-list-page-token-1",
      roomID: "!room:beeper.com",
      dir: "backward",
    });
  });
});
