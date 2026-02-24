import { describe, expect, it, vi } from "vitest";
import { getEmoji } from "chat";
import { EventType, RelationType } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { createMatrixAdapter, MatrixAdapter } from "./index";

function makeEvent(overrides: Record<string, unknown> = {}) {
  const event = {
    getId: () => "$event",
    getRoomId: () => "!room:beeper.com",
    getTs: () => 1_700_000_000_000,
    getSender: () => "@alice:beeper.com",
    getType: () => EventType.RoomMessage,
    getContent: () => ({ body: "hello" }),
    getRelation: () => null,
    threadRootId: undefined,
    isThreadRoot: false,
    isRedaction: () => false,
    getAssociatedId: () => undefined,
    ...overrides,
  };

  return event;
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
    redactEvent: vi.fn(async () => ({ event_id: "$redaction" })),
    sendTyping: vi.fn(async () => ({})),
    initRustCrypto: vi.fn(async () => undefined),
    decryptEventIfNeeded: vi.fn(async () => undefined),
    getRoom: vi.fn(() => ({
      roomId: "!room:beeper.com",
      name: "Example Room",
      timeline: [],
      getJoinedMembers: () => [{}, {}],
      findEventById: () => makeEvent({ getId: () => "$sent" }),
    })),
    __handlers: handlers,
  };

  return client;
}

function makeStateAdapter(initial: Record<string, unknown> = {}) {
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
  };
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
      createClient: () => fakeClient as never,
    });

    const processMessage = vi.fn();
    const processSlashCommand = vi.fn();

    await adapter.initialize({
      getLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({}) as never,
      }) as never,
      getState: vi.fn(),
      getUserName: vi.fn(),
      handleIncomingMessage: vi.fn(),
      processAction: vi.fn(),
      processAppHomeOpened: vi.fn(),
      processAssistantContextChanged: vi.fn(),
      processAssistantThreadStarted: vi.fn(),
      processMessage,
      processModalClose: vi.fn(),
      processModalSubmit: vi.fn(),
      processReaction: vi.fn(),
      processSlashCommand,
    });

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
    expect(timelineHandler).toBeTruthy();

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
      createClient: () => fakeClient as never,
    });

    await adapter.initialize({
      getLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({}) as never,
      }) as never,
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
      processReaction,
      processSlashCommand: vi.fn(),
    });

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");

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
      createClient: () => fakeClient as never,
      e2ee: { enabled: true },
    });

    await adapter.initialize({
      getLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({}) as never,
      }) as never,
      getState: vi.fn(),
      getUserName: vi.fn(),
      handleIncomingMessage: vi.fn(),
      processAction: vi.fn(),
      processAppHomeOpened: vi.fn(),
      processAssistantContextChanged: vi.fn(),
      processAssistantThreadStarted: vi.fn(),
      processMessage,
      processModalClose: vi.fn(),
      processModalSubmit: vi.fn(),
      processReaction: vi.fn(),
      processSlashCommand: vi.fn(),
    });

    expect(fakeClient.initRustCrypto).toHaveBeenCalledOnce();

    const timelineHandler = fakeClient.__handlers.get("Room.timeline");
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
    const adapter = createMatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      recoveryKey: "s3cr3t-recovery-key",
    }) as unknown as { e2eeConfig?: { enabled?: boolean } };

    expect(adapter.e2eeConfig?.enabled).toBe(true);
  });

  it("decodes recovery key for secret storage callback", () => {
    const recoveryKey = encodeRecoveryKey(new Uint8Array(32).fill(7));
    expect(recoveryKey).toBeDefined();

    const adapter = createMatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      recoveryKey: recoveryKey!,
    }) as unknown as {
      getSecretStorageKeyFromRecoveryKey: (opts: {
        keys: Record<string, unknown>;
      }) => [string, Uint8Array] | null;
    };

    const result = adapter.getSecretStorageKeyFromRecoveryKey({
      keys: {
        key1: {},
      },
    });

    expect(result).not.toBeNull();
    expect(result?.[0]).toBe("key1");
    expect(result?.[1]).toBeInstanceOf(Uint8Array);
  });

  it("generates a device id when one is not provided", () => {
    const adapter = createMatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
    }) as unknown as { deviceID?: string };

    expect(adapter.deviceID).toBeDefined();
    expect(adapter.deviceID).toMatch(/^chatsdk_[A-Z0-9]{8}$/);
  });

  it("generates a device id when provided deviceID is blank", () => {
    const adapter = createMatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      deviceID: "   ",
    }) as unknown as { deviceID?: string };

    expect(adapter.deviceID).toMatch(/^chatsdk_[A-Z0-9]{8}$/);
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
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.beeper.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:beeper.com",
      },
      createClient: () => fakeClient as never,
    });

    await adapter.initialize({
      getLogger: () =>
        ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          child: () => ({}) as never,
        }) as never,
      getState: vi.fn(() => makeStateAdapter() as never),
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
    });

    await adapter.shutdown();
    expect(fakeClient.stopClient).toHaveBeenCalledOnce();
  });

  it("persists and reloads matrix session via chat state", async () => {
    const baseURL = "https://hs.beeper.com";
    const state = makeStateAdapter();

    const adapter = new MatrixAdapter({
      baseURL,
      auth: {
        type: "password",
        username: "bot",
        password: "secret",
      },
    });

    (adapter as unknown as { stateAdapter: unknown }).stateAdapter =
      state as unknown;

    await (
      adapter as unknown as {
        persistSession: (session: {
          accessToken: string;
          deviceID?: string;
          userID: string;
        }) => Promise<void>;
      }
    ).persistSession({
      accessToken: "persisted-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE1",
    });

    const restored = await (
      adapter as unknown as {
        loadPersistedSession: () => Promise<{
          accessToken: string;
          userID: string;
          deviceID?: string;
        } | null>;
      }
    ).loadPersistedSession();

    expect(state.set).toHaveBeenCalled();
    expect(restored).toMatchObject({
      accessToken: "persisted-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE1",
    });
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
        }) as never,
    });

    (adapter as unknown as { stateAdapter: unknown }).stateAdapter =
      state as unknown;
    const resolved = await (
      adapter as unknown as {
        resolveAuth: () => Promise<{
          accessToken: string;
          userID: string;
          deviceID?: string;
        }>;
      }
    ).resolveAuth();

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
        }) as never,
    });

    (adapter as unknown as { stateAdapter: unknown }).stateAdapter =
      state as unknown;
    const resolved = await (
      adapter as unknown as {
        resolveAuth: () => Promise<{
          accessToken: string;
          userID: string;
          deviceID?: string;
        }>;
      }
    ).resolveAuth();

    expect(loginWithPassword).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      accessToken: "fresh-token",
      userID: "@bot:beeper.com",
      deviceID: "DEVICE2",
    });
  });
});
