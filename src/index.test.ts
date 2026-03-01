import { describe, expect, it, vi } from "vitest";
import { getEmoji } from "chat";
import type { ChatInstance, StateAdapter } from "chat";
import { EventType, RelationType, type MatrixClient } from "matrix-js-sdk";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { createMatrixAdapter, MatrixAdapter } from "./index";

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

function mapRawToEvent(raw: Record<string, unknown>) {
  const content = (raw.content as Record<string, unknown> | undefined) ?? {};
  const relatesTo = content["m.relates_to"] as
    | Record<string, unknown>
    | undefined;
  const relationType = relatesTo?.rel_type;
  const relationEventID = relatesTo?.event_id;
  const mappedThreadRootId =
    typeof raw.threadRootId === "string"
      ? raw.threadRootId
      : relationType === "m.thread" && typeof relationEventID === "string"
        ? relationEventID
        : undefined;
  const isThreadRoot = raw.isThreadRoot === true;

  return makeEvent({
    getId: () => (raw.event_id as string | undefined) ?? "$raw",
    getRoomId: () => (raw.room_id as string | undefined) ?? "!room:beeper.com",
    getTs: () => (raw.origin_server_ts as number | undefined) ?? 1_700_000_000_000,
    getSender: () => (raw.sender as string | undefined) ?? "@alice:beeper.com",
    getType: () => (raw.type as string | undefined) ?? EventType.RoomMessage,
    getContent: () => content,
    getRelation: () =>
      relationType
        ? {
            rel_type: relationType,
          }
        : null,
    isRelation: (expectedRelType: string) => relationType === expectedRelType,
    getServerAggregatedRelation: (expectedRelType: string) =>
      ((raw.unsigned as Record<string, unknown> | undefined)?.[
        "m.relations"
      ] as Record<string, unknown> | undefined)?.[expectedRelType],
    threadRootId: mappedThreadRootId,
    isThreadRoot,
  });
}

type RawEventLike = {
  content?: Record<string, unknown>;
  event_id?: string;
  origin_server_ts?: number;
  room_id?: string;
  sender?: string;
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

type RoomLike = {
  roomId: string;
  name: string;
  timeline: unknown[];
  getJoinedMembers: () => Array<Record<string, never>>;
  getMyMembership: () => string;
  findEventById: (eventID?: string) => ReturnType<typeof makeEvent> | null;
};

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
  return client as unknown as MatrixClient;
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
    getEventMapper: vi.fn(() => (raw: Record<string, unknown>) => mapRawToEvent(raw)),
    initRustCrypto: vi.fn(async () => undefined),
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
    getRoom: vi.fn((): RoomLike => ({
      roomId: "!room:beeper.com",
      name: "Example Room",
      timeline: [],
      getJoinedMembers: () => [{}, {}],
      getMyMembership: () => "join",
      findEventById: (_eventID?: string) => makeEvent({ getId: () => "$sent" }),
    })),
    __handlers: handlers,
  };

  return client;
}

function makeStateAdapter(initial: Record<string, unknown> = {}): StateAdapter {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    acquireLock: vi.fn(async () => null),
    connect: vi.fn(async () => undefined),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    disconnect: vi.fn(async () => undefined),
    extendLock: vi.fn(async () => false),
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    isSubscribed: vi.fn(async () => false),
    releaseLock: vi.fn(async () => undefined),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
  } as StateAdapter;
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

function makeChatInstance(overrides: Record<string, unknown> = {}): ChatInstance {
  return {
    getLogger: () =>
      ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({}),
      }),
    getState: vi.fn(),
    getUserName: vi.fn(),
    handleIncomingMessage: vi.fn(),
    processAction: vi.fn(),
    processAppHomeOpened: vi.fn(),
    processAssistantContextChanged: vi.fn(),
    processAssistantThreadStarted: vi.fn(),
    processMessage: vi.fn(),
    processModalClose: vi.fn(),
    processModalSubmit: vi.fn(),
    processReaction: vi.fn(),
    processSlashCommand: vi.fn(),
    ...overrides,
  } as unknown as ChatInstance;
}

async function makeInitializedAdapter(fakeClient: ReturnType<typeof makeClient>) {
  const adapter = new MatrixAdapter({
    baseURL: "https://hs.beeper.com",
    auth: { type: "accessToken", accessToken: "token", userID: "@bot:beeper.com" },
    createClient: () => asMatrixClient(fakeClient),
  });
  await adapter.initialize(makeChatInstance({ getState: vi.fn(() => makeStateAdapter()) }));
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
    fakeClient.getRoom.mockReturnValue({
      roomId: "!room:beeper.com",
      name: "Example Room",
      timeline: [],
      getJoinedMembers: () => [{}, {}],
      getMyMembership: () => "join",
      findEventById: (eventId?: string) =>
        eventId === "$target"
          ? makeEvent({
              getId: () => "$target",
              getRoomId: () => "!room:beeper.com",
              threadRootId: "$root",
            })
          : null,
    });

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
    await adapterFromCache.initialize(makeChatInstance({ getState: vi.fn(() => cachedState) }));
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
    await adapterFromDirect.initialize(makeChatInstance({ getState: vi.fn(() => directState) }));
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
    await adapterCreate.initialize(makeChatInstance({ getState: vi.fn(() => createState) }));
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
