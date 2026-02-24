import { describe, expect, it, vi } from "vitest";
import { getEmoji } from "chat";
import { EventType, RelationType } from "matrix-js-sdk";
import { createMatrixAdapter, MatrixAdapter } from "./index";

function makeEvent(overrides: Record<string, unknown> = {}) {
  const event = {
    getId: () => "$event",
    getRoomId: () => "!room:example.com",
    getTs: () => 1_700_000_000_000,
    getSender: () => "@alice:example.com",
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
    sendMessage: vi.fn(async () => ({ event_id: "$sent" })),
    sendEvent: vi.fn(async () => ({ event_id: "$reaction" })),
    redactEvent: vi.fn(async () => ({ event_id: "$redaction" })),
    sendTyping: vi.fn(async () => ({})),
    initRustCrypto: vi.fn(async () => undefined),
    decryptEventIfNeeded: vi.fn(async () => undefined),
    getRoom: vi.fn(() => ({
      roomId: "!room:example.com",
      name: "Example Room",
      timeline: [],
      getJoinedMembers: () => [{}, {}],
      findEventById: () => makeEvent({ getId: () => "$sent" }),
    })),
    __handlers: handlers,
  };

  return client;
}

describe("MatrixAdapter", () => {
  it("encodes and decodes thread IDs", () => {
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
      },
    });

    const encoded = adapter.encodeThreadId({
      roomID: "!room:example.com",
      rootEventID: "$root:example.com",
    });

    expect(encoded).toBe("matrix:!room%3Aexample.com:%24root%3Aexample.com");
    expect(adapter.decodeThreadId(encoded)).toEqual({
      roomID: "!room:example.com",
      rootEventID: "$root:example.com",
    });
  });

  it("parses slash commands from timeline messages", async () => {
    const fakeClient = makeClient();

    const adapter = new MatrixAdapter({
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
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
      { roomId: "!room:example.com" },
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
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
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
      { roomId: "!room:example.com" },
      false
    );

    timelineHandler?.(
      makeEvent({
        getType: () => EventType.RoomRedaction,
        isRedaction: () => true,
        getAssociatedId: () => "$reaction1",
      }),
      { roomId: "!room:example.com" },
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
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
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
      { roomId: "!room:example.com" },
      false
    );

    await Promise.resolve();
    expect(fakeClient.decryptEventIfNeeded).toHaveBeenCalledOnce();
  });

  it("enables e2ee when recovery key is provided", () => {
    const adapter = createMatrixAdapter({
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
      },
      recoveryKey: "s3cr3t-recovery-key",
    }) as unknown as { e2eeConfig?: { enabled?: boolean } };

    expect(adapter.e2eeConfig?.enabled).toBe(true);
  });

  it("generates a device id when one is not provided", () => {
    const adapter = createMatrixAdapter({
      baseURL: "https://hs.example.com",
      auth: {
        type: "accessToken",
        accessToken: "token",
        userID: "@bot:example.com",
      },
    }) as unknown as { deviceID?: string };

    expect(adapter.deviceID).toBeDefined();
    expect(adapter.deviceID?.length).toBe(10);
  });

  it("supports typed username/password auth config", () => {
    const adapter = new MatrixAdapter({
      baseURL: "https://hs.example.com",
      auth: {
        type: "password",
        username: "bot",
        password: "secret",
      },
    });

    expect(adapter).toBeInstanceOf(MatrixAdapter);
  });
});
