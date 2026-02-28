import { randomBytes } from "node:crypto";
import type {
  Adapter,
  AdapterPostableMessage,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  ListThreadsOptions,
  ListThreadsResult,
  Logger,
  RawMessage,
  ThreadInfo,
  ThreadSummary,
  WebhookOptions,
  StateAdapter,
} from "chat";
import {
  ConsoleLogger,
  getEmoji,
  isCardElement,
  Message,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import sdk, {
  Direction,
  type MatrixClient,
  type MatrixEvent,
  type IEvent,
  type IThreadBundledRelationship,
  type Room,
  ClientEvent,
  EventType,
  MsgType,
  RelationType,
  RoomEvent,
  ThreadFilterType,
  THREAD_RELATION_TYPE,
} from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import type {
  RoomMessageEventContent,
  RoomMessageTextEventContent,
} from "matrix-js-sdk/lib/@types/events";
import { logger as matrixSDKLogger } from "matrix-js-sdk/lib/logger";
import type {
  MatrixAuthBootstrapClient,
  MatrixAccessTokenAuthConfig,
  MatrixAdapterConfig,
  MatrixAuthConfig,
  MatrixThreadID,
} from "./types";

const MATRIX_PREFIX = "matrix";
const MATRIX_DEVICE_PREFIX = "matrix:device";
const MATRIX_DM_PREFIX = "matrix:dm";
const MATRIX_SESSION_PREFIX = "matrix:session";
const MATRIX_CURSOR_PREFIX = "mxv1:";
const DEFAULT_COMMAND_PREFIX = "/";
const TYPING_TIMEOUT_MS = 30_000;
const FAST_SYNC_DEFAULTS: NonNullable<MatrixAdapterConfig["sync"]> = {
  initialSyncLimit: 1,
  lazyLoadMembers: true,
  disablePresence: true,
  pollTimeout: 10_000,
};
const MATRIX_SDK_LOG_LEVELS: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};
let matrixSDKLogConfigured = false;

type MatrixMessageContent = {
  body?: string;
  format?: string;
  formatted_body?: string;
  msgtype?: string;
  [key: string]: unknown;
};

type MatrixTextMessageContent = RoomMessageTextEventContent & {
  "com.beeper.dont_render_edited"?: boolean;
};

type MatrixRoomMessageContent = RoomMessageEventContent & {
  "com.beeper.dont_render_edited"?: boolean;
  "m.new_content"?: RoomMessageEventContent & {
    "com.beeper.dont_render_edited"?: boolean;
  };
};

type StoredReaction = {
  emoji: EmojiValue;
  messageID: string;
  rawEmoji: string;
  roomID: string;
  threadID: string;
  userID: string;
};

type ResolvedAuth = {
  accessToken: string;
  deviceID?: string;
  userID: string;
};

type StoredSession = {
  accessToken?: string;
  authType: MatrixAuthConfig["type"];
  baseURL: string;
  createdAt: string;
  deviceID?: string;
  e2eeEnabled: boolean;
  encryptedPayload?: string;
  recoveryKeyPresent: boolean;
  updatedAt: string;
  userID: string;
  username?: string;
};

type DeviceIDPersistenceConfig = {
  enabled: boolean;
  key?: string;
};

type CursorKind = "room_messages" | "thread_relations" | "thread_list";

type CursorDirection = "forward" | "backward";

type CursorV1Payload = {
  dir: CursorDirection;
  kind: CursorKind;
  roomID: string;
  rootEventID?: string;
  token: string;
};

type DirectAccountData = Record<string, string[]>;

// Intentionally unsupported in this adapter: postEphemeral, openModal, and native stream.
export class MatrixAdapter implements Adapter<MatrixThreadID, MatrixEvent> {
  readonly name = "matrix";
  readonly userName: string;

  private readonly baseURL: string;
  private readonly auth: MatrixAuthConfig;
  private readonly commandPrefix: string;
  private readonly roomAllowlist?: Set<string>;
  private readonly syncOptions?: MatrixAdapterConfig["sync"];
  private readonly createClientFn?: MatrixAdapterConfig["createClient"];
  private readonly createBootstrapClientFn?: MatrixAdapterConfig["createBootstrapClient"];
  private readonly e2eeConfig?: MatrixAdapterConfig["e2ee"];
  private readonly recoveryKey?: string;
  private readonly matrixSDKLogLevel?: MatrixAdapterConfig["matrixSDKLogLevel"];
  private readonly deviceIDPersistence: DeviceIDPersistenceConfig;
  private readonly loggerProvided: boolean;
  private readonly sessionConfig: Required<
    Pick<NonNullable<MatrixAdapterConfig["session"]>, "enabled">
  > &
    Pick<
      NonNullable<MatrixAdapterConfig["session"]>,
      "decrypt" | "encrypt" | "key" | "ttlMs"
    >;

  private logger: Logger;
  private chat: ChatInstance | null = null;
  private stateAdapter: StateAdapter | null = null;
  private client: MatrixClient | null = null;
  private started = false;
  private userID: string;
  private deviceID?: string;
  private botUserID?: string;
  private readonly reactionByEventID = new Map<string, StoredReaction>();
  private readonly myReactionByKey = new Map<string, string>();
  private readonly processedTimelineEventIDs = new Set<string>();
  private liveSyncReady = false;
  private shuttingDown = false;

  constructor(config: MatrixAdapterConfig) {
    this.validateConfig(config);
    this.baseURL = config.baseURL;
    this.auth = config.auth;
    this.userID =
      config.auth.type === "accessToken"
        ? (config.auth.userID ?? "")
        : (config.auth.userID ?? "");
    this.botUserID = this.userID || undefined;
    this.deviceID = normalizeOptionalString(config.deviceID);
    this.userName = config.userName ?? "bot";
    this.commandPrefix = config.commandPrefix ?? DEFAULT_COMMAND_PREFIX;
    this.roomAllowlist = config.roomAllowlist
      ? new Set(config.roomAllowlist)
      : undefined;
    this.syncOptions = config.sync ?? FAST_SYNC_DEFAULTS;
    this.createClientFn = config.createClient;
    this.createBootstrapClientFn = config.createBootstrapClient;
    this.e2eeConfig = {
      ...config.e2ee,
      enabled: config.e2ee?.enabled ?? Boolean(config.recoveryKey),
      storagePassword:
        config.e2ee?.storagePassword ?? config.recoveryKey,
    };
    this.recoveryKey = normalizeOptionalString(config.recoveryKey);
    this.matrixSDKLogLevel = config.matrixSDKLogLevel;
    this.deviceIDPersistence = {
      enabled: config.deviceIDPersistence?.enabled ?? true,
      key: normalizeOptionalString(config.deviceIDPersistence?.key),
    };
    this.sessionConfig = {
      decrypt: config.session?.decrypt,
      enabled: config.session?.enabled ?? true,
      encrypt: config.session?.encrypt,
      key: config.session?.key,
      ttlMs: config.session?.ttlMs,
    };
    this.loggerProvided = Boolean(config.logger);
    this.logger = config.logger ?? new ConsoleLogger("info").child("matrix");
  }

  async initialize(chat: ChatInstance): Promise<void> {
    if (this.started) {
      return;
    }

    this.chat = chat;
    if (!this.loggerProvided) {
      this.logger = chat.getLogger("matrix");
    }
    this.stateAdapter = chat.getState();
    this.configureMatrixSDKLogging();
    await this.resolveDeviceID();

    if (this.createClientFn) {
      this.client = this.createClientFn();
    } else {
      const resolvedAuth = await this.resolveAuth();
      this.userID = resolvedAuth.userID;
      this.botUserID = resolvedAuth.userID;
      this.deviceID = normalizeOptionalString(resolvedAuth.deviceID) ?? this.deviceID;
      this.client = this.buildClient(resolvedAuth);
    }

    this.client.on(ClientEvent.Sync, (state: string) => {
      if (state === "PREPARED" || state === "SYNCING") {
        this.liveSyncReady = true;
      }
      this.logger.debug("Matrix sync state", { state });
    });

    this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      void this.onTimelineEvent(event, room, Boolean(toStartOfTimeline));
    });
    this.client.on(ClientEvent.Event, (event) => {
      if (!event.getRoomId()) {
        return;
      }
      void this.onTimelineEvent(event, undefined, false);
    });

    await this.maybeInitE2EE();
    await this.client.startClient(this.syncOptions);
    this.started = true;

    this.logger.info("Matrix adapter initialized", {
      userId: this.userID,
      baseUrl: this.baseURL,
    });
  }

  get botUserId(): string | undefined {
    return this.botUserID;
  }

  async shutdown(): Promise<void> {
    if (!this.client || this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    try {
      this.client.stopClient();
      this.reactionByEventID.clear();
      this.myReactionByKey.clear();
      this.started = false;
      this.logger.info("Matrix adapter shutdown complete");
    } finally {
      this.shuttingDown = false;
    }
  }

  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    return new Response(
      "Matrix adapter uses sync polling and does not expose a webhook endpoint.",
      { status: 501 }
    );
  }

  encodeThreadId(platformData: MatrixThreadID): string {
    const room = encodeURIComponent(platformData.roomID);
    if (platformData.rootEventID) {
      return `${MATRIX_PREFIX}:${room}:${encodeURIComponent(platformData.rootEventID)}`;
    }
    return `${MATRIX_PREFIX}:${room}`;
  }

  decodeThreadId(threadId: string): MatrixThreadID {
    const parts = threadId.split(":");
    if (parts.length < 2 || parts[0] !== MATRIX_PREFIX) {
      throw new Error(`Invalid Matrix thread ID: ${threadId}`);
    }

    const roomID = decodeURIComponent(parts[1]);
    const rootEventID = parts[2] ? decodeURIComponent(parts[2]) : undefined;

    return { roomID, rootEventID };
  }

  channelIdFromThreadId(threadId: string): string {
    const { roomID } = this.decodeThreadId(threadId);
    return `${MATRIX_PREFIX}:${encodeURIComponent(roomID)}`;
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  parseMessage(raw: MatrixEvent): Message<MatrixEvent> {
    return this.parseMessageInternal(raw);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<MatrixEvent>> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const content = this.toRoomMessageContent(message);

    const response = await this.sendRoomMessage(roomID, rootEventID, content);

    return {
      id: response.event_id,
      threadId,
      raw: this.mustGetEventByID(roomID, response.event_id),
    };
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<MatrixEvent>> {
    const roomID = this.decodeChannelID(channelId);
    return this.postMessage(this.encodeThreadId({ roomID }), message);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<MatrixEvent>> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const baseContent = this.toRoomMessageContent(message);
    const newContent: MatrixTextMessageContent = {
      ...baseContent,
      "com.beeper.dont_render_edited": true,
    };

    const editContent: MatrixRoomMessageContent = {
      "com.beeper.dont_render_edited": true,
      "m.new_content": newContent,
      "m.relates_to": {
        rel_type: RelationType.Replace,
        event_id: messageId,
      },
      msgtype: newContent.msgtype,
      body: `* ${baseContent.body}`,
    };

    const response = await this.sendRoomMessage(roomID, rootEventID, editContent);

    return {
      id: response.event_id,
      threadId,
      raw: this.mustGetEventByID(roomID, response.event_id),
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { roomID } = this.decodeThreadId(threadId);
    await this.requireClient().redactEvent(roomID, messageId);
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const rawEmoji = typeof emoji === "string" ? emoji : emoji.toString();

    const response = await this.requireClient().sendEvent(
      roomID,
      rootEventID ?? null,
      EventType.Reaction,
      {
        "m.relates_to": {
          rel_type: RelationType.Annotation,
          event_id: messageId,
          key: rawEmoji,
        },
      }
    );

    const key = this.myReactionKey(threadId, messageId, rawEmoji);
    this.myReactionByKey.set(key, response.event_id);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const rawEmoji = typeof emoji === "string" ? emoji : emoji.toString();
    const reactionEventID = this.myReactionByKey.get(
      this.myReactionKey(threadId, messageId, rawEmoji)
    );

    if (!reactionEventID) {
      return;
    }

    const { roomID } = this.decodeThreadId(threadId);
    await this.requireClient().redactEvent(roomID, reactionEventID);
  }

  async startTyping(threadId: string): Promise<void> {
    const { roomID } = this.decodeThreadId(threadId);
    await this.requireClient().sendTyping(roomID, true, TYPING_TIMEOUT_MS);
  }

  async openDM(userId: string): Promise<string> {
    const cachedRoomID = await this.loadPersistedDMRoomID(userId);
    if (cachedRoomID) {
      return this.encodeThreadId({ roomID: cachedRoomID });
    }

    const direct = await this.loadDirectAccountData();
    const existingRoomID = this.findExistingDirectRoomID(direct, userId);
    if (existingRoomID) {
      await this.persistDMRoomID(userId, existingRoomID);
      return this.encodeThreadId({ roomID: existingRoomID });
    }

    const response = await this.requireClient().createRoom({
      invite: [userId],
      is_direct: true,
    });

    const createdRoomID = response.room_id;
    if (!createdRoomID) {
      throw new Error("Matrix createRoom did not return room_id for DM.");
    }

    await this.persistDMRoomID(userId, createdRoomID);
    await this.persistDirectAccountDataRoom(userId, createdRoomID, direct);
    return this.encodeThreadId({ roomID: createdRoomID });
  }

  async fetchMessages(
    threadId: string,
    options: FetchOptions = {}
  ): Promise<FetchResult<MatrixEvent>> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const direction = options.direction ?? "backward";
    const limit = options.limit ?? 50;
    const cursor = options.cursor
      ? this.decodeCursorV1(
          options.cursor,
          rootEventID ? "thread_relations" : "room_messages",
          roomID,
          rootEventID
        )
      : null;

    if (!rootEventID) {
      const response = await this.fetchRoomMessagesPage({
        roomID,
        includeThreadReplies: false,
        limit,
        direction,
        fromToken: cursor?.token ?? null,
      });

      return {
        messages: response.events.map((event) => this.parseMessageInternal(event)),
        nextCursor: response.nextToken
          ? this.encodeCursorV1({
              kind: "room_messages",
              dir: direction,
              token: response.nextToken,
              roomID,
            })
          : undefined,
      };
    }

    const includeRoot = !cursor;
    const response = await this.fetchThreadMessagesPage({
      roomID,
      rootEventID,
      includeRoot,
      limit,
      direction,
      fromToken: cursor?.token ?? null,
    });

    return {
      messages: response.events.map((event) =>
        this.parseMessageInternal(event, this.encodeThreadId({ roomID, rootEventID }))
      ),
      nextCursor: response.nextToken
        ? this.encodeCursorV1({
            kind: "thread_relations",
            dir: direction,
            token: response.nextToken,
            roomID,
            rootEventID,
          })
        : undefined,
    };
  }

  async fetchChannelMessages(
    channelId: string,
    options: FetchOptions = {}
  ): Promise<FetchResult<MatrixEvent>> {
    const roomID = this.decodeChannelID(channelId);
    const direction = options.direction ?? "backward";
    const limit = options.limit ?? 50;
    const cursor = options.cursor
      ? this.decodeCursorV1(options.cursor, "room_messages", roomID)
      : null;

    const response = await this.fetchRoomMessagesPage({
      roomID,
      includeThreadReplies: false,
      limit,
      direction,
      fromToken: cursor?.token ?? null,
    });

    return {
      messages: response.events.map((event) => this.parseMessageInternal(event)),
      nextCursor: response.nextToken
        ? this.encodeCursorV1({
            kind: "room_messages",
            dir: direction,
            token: response.nextToken,
            roomID,
          })
        : undefined,
    };
  }

  async fetchMessage(
    threadId: string,
    messageId: string
  ): Promise<Message<MatrixEvent> | null> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const event = await this.fetchRoomEventMapped(roomID, messageId);
    if (!event) {
      return null;
    }

    if (!this.isMessageEventInContext(event, roomID, rootEventID)) {
      return null;
    }

    const overrideThreadID = rootEventID
      ? this.encodeThreadId({ roomID, rootEventID })
      : undefined;
    return this.parseMessageInternal(event, overrideThreadID);
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { roomID } = this.decodeThreadId(threadId);
    const room = this.requireRoom(roomID);

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: room.name,
      isDM: room.getJoinedMembers().length === 2,
      metadata: {
        roomID,
      },
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const roomID = this.decodeChannelID(channelId);
    const room = this.requireRoom(roomID);

    return {
      id: channelId,
      name: room.name,
      isDM: room.getJoinedMembers().length === 2,
      memberCount: room.getJoinedMembers().length,
      metadata: {
        roomID,
      },
    };
  }

  async listThreads(
    channelId: string,
    options: ListThreadsOptions = {}
  ): Promise<ListThreadsResult<MatrixEvent>> {
    const roomID = this.decodeChannelID(channelId);
    const direction: CursorDirection = "backward";
    const limit = options.limit ?? 50;
    const cursor = options.cursor
      ? this.decodeCursorV1(options.cursor, "thread_list", roomID)
      : null;
    const listResponse = await this.requireClient().createThreadListMessagesRequest(
      roomID,
      cursor?.token ?? null,
      limit,
      Direction.Backward,
      ThreadFilterType.All
    );
    const events = await this.mapRawEvents(listResponse.chunk ?? [], roomID);
    const summaries: ThreadSummary<MatrixEvent>[] = [];

    for (const rootEvent of events) {
      const rootID = rootEvent.getId();
      if (!rootID || rootEvent.getType() !== EventType.RoomMessage) {
        continue;
      }

      const bundled = rootEvent.getServerAggregatedRelation<IThreadBundledRelationship>(
        THREAD_RELATION_TYPE.name
      );
      const latestTS = bundled?.latest_event?.origin_server_ts;
      const threadID = this.encodeThreadId({ roomID, rootEventID: rootID });

      summaries.push({
        id: threadID,
        rootMessage: this.parseMessageInternal(rootEvent, threadID),
        replyCount: bundled?.count ?? 0,
        lastReplyAt: typeof latestTS === "number" ? new Date(latestTS) : undefined,
      });
    }

    return {
      threads: summaries,
      nextCursor: listResponse.end
        ? this.encodeCursorV1({
            kind: "thread_list",
            dir: direction,
            token: listResponse.end,
            roomID,
          })
        : undefined,
    };
  }

  private parseMessageInternal(
    raw: MatrixEvent,
    overrideThreadID?: string
  ): Message<MatrixEvent> {
    const roomID = raw.getRoomId();
    if (!roomID) {
      throw new Error("Matrix event missing room ID");
    }

    const threadID = overrideThreadID ?? this.threadIDForEvent(raw, roomID);
    const content = raw.getContent<MatrixMessageContent>();
    const text = this.extractText(content);
    const sender = raw.getSender() ?? "unknown";

    return new Message<MatrixEvent>({
      id: raw.getId() ?? `${roomID}:${raw.getTs()}`,
      threadId: threadID,
      text,
      formatted: parseMarkdown(text),
      author: this.makeUser(sender),
      metadata: {
        dateSent: new Date(raw.getTs()),
        edited: this.isEdited(raw),
      },
      attachments: this.extractAttachments(content),
      raw,
      isMention: this.isMentioned(content, text),
    });
  }

  private encodeCursorV1(payload: CursorV1Payload): string {
    return `${MATRIX_CURSOR_PREFIX}${Buffer.from(
      JSON.stringify(payload),
      "utf8"
    ).toString("base64url")}`;
  }

  private decodeCursorV1(
    cursor: string,
    expectedKind: CursorKind,
    expectedRoomID: string,
    expectedRootEventID?: string
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

  private async fetchRoomMessagesPage(args: {
    roomID: string;
    includeThreadReplies: boolean;
    limit: number;
    direction: CursorDirection;
    fromToken: string | null;
  }): Promise<{ events: MatrixEvent[]; nextToken: string | null }> {
    const response = await this.requireClient().createMessagesRequest(
      args.roomID,
      args.fromToken,
      args.limit,
      args.direction === "forward" ? Direction.Forward : Direction.Backward
    );
    const events = await this.mapRawEvents(response.chunk ?? [], args.roomID);
    const filtered = events.filter((event) => {
      if (event.getType() !== EventType.RoomMessage) {
        return false;
      }
      if (event.getRoomId() !== args.roomID) {
        return false;
      }
      if (args.includeThreadReplies) {
        return true;
      }
      return this.isTopLevelMessageEvent(event);
    });

    return {
      events: this.sortEventsChronologically(filtered),
      nextToken: response.end ?? null,
    };
  }

  private async fetchThreadMessagesPage(args: {
    roomID: string;
    rootEventID: string;
    includeRoot: boolean;
    limit: number;
    direction: CursorDirection;
    fromToken: string | null;
  }): Promise<{ events: MatrixEvent[]; nextToken: string | null }> {
    const relationLimit = args.includeRoot
      ? Math.max(args.limit - 1, 1)
      : args.limit;

    const relationResponse = await this.requireClient().relations(
      args.roomID,
      args.rootEventID,
      THREAD_RELATION_TYPE.name,
      null,
      {
        dir: args.direction === "forward" ? Direction.Forward : Direction.Backward,
        from: args.fromToken ?? undefined,
        limit: relationLimit,
      }
    );

    await Promise.all(
      relationResponse.events.map((event) => this.tryDecryptEvent(event))
    );
    const replies = this.sortEventsChronologically(
      relationResponse.events.filter((event) =>
        this.isMessageEventInContext(event, args.roomID, args.rootEventID)
      )
    );

    if (!args.includeRoot) {
      return {
        events: replies.slice(0, args.limit),
        nextToken: relationResponse.nextBatch ?? null,
      };
    }

    const rootEvent =
      relationResponse.originalEvent?.getId() === args.rootEventID
        ? relationResponse.originalEvent
        : await this.fetchRoomEventMapped(args.roomID, args.rootEventID);
    const rootArray =
      rootEvent &&
      this.isMessageEventInContext(rootEvent, args.roomID, args.rootEventID)
        ? [rootEvent]
        : [];
    const dedupedReplies = replies.filter(
      (event) => event.getId() !== args.rootEventID
    );

    return {
      events: [...rootArray, ...dedupedReplies].slice(0, args.limit),
      nextToken: relationResponse.nextBatch ?? null,
    };
  }

  private async mapRawEvents(
    rawEvents: Array<Partial<IEvent>>,
    roomID: string
  ): Promise<MatrixEvent[]> {
    const events = rawEvents.map((event) => this.mapRawEvent(event, roomID));
    await Promise.all(events.map((event) => this.tryDecryptEvent(event)));
    return events;
  }

  private mapRawEvent(rawEvent: Partial<IEvent>, roomID: string): MatrixEvent {
    const mapper = this.requireClient().getEventMapper();
    const withRoomID = rawEvent.room_id
      ? rawEvent
      : { ...rawEvent, room_id: roomID };
    return mapper(withRoomID);
  }

  private async fetchRoomEventMapped(
    roomID: string,
    eventID: string
  ): Promise<MatrixEvent | null> {
    try {
      const rawEvent = await this.requireClient().fetchRoomEvent(roomID, eventID);
      if (!rawEvent) {
        return null;
      }

      const mapped = this.mapRawEvent(rawEvent, roomID);
      await this.tryDecryptEvent(mapped);
      return mapped;
    } catch {
      return null;
    }
  }

  private sortEventsChronologically(events: MatrixEvent[]): MatrixEvent[] {
    const deduped = new Map<string, MatrixEvent>();
    const withoutIDs: MatrixEvent[] = [];

    for (const event of events) {
      const eventID = event.getId();
      if (!eventID) {
        withoutIDs.push(event);
        continue;
      }
      deduped.set(eventID, event);
    }

    return [...deduped.values(), ...withoutIDs].sort((a, b) => {
      const tsDiff = a.getTs() - b.getTs();
      if (tsDiff !== 0) {
        return tsDiff;
      }
      return (a.getId() ?? "").localeCompare(b.getId() ?? "");
    });
  }

  private isTopLevelMessageEvent(event: MatrixEvent): boolean {
    return !event.threadRootId && !event.isRelation(THREAD_RELATION_TYPE.name);
  }

  private isMessageEventInContext(
    event: MatrixEvent,
    roomID: string,
    rootEventID?: string
  ): boolean {
    if (event.getType() !== EventType.RoomMessage || event.getRoomId() !== roomID) {
      return false;
    }

    if (!rootEventID) {
      return this.isTopLevelMessageEvent(event);
    }

    return event.threadRootId === rootEventID || event.getId() === rootEventID;
  }

  private getDMStorageKey(userID: string): string {
    return `${MATRIX_DM_PREFIX}:${encodeURIComponent(userID)}`;
  }

  private async loadPersistedDMRoomID(userID: string): Promise<string | null> {
    if (!this.stateAdapter) {
      return null;
    }

    const cached = await this.stateAdapter.get<string | null>(
      this.getDMStorageKey(userID)
    );
    const normalized = normalizeOptionalString(cached ?? undefined);
    return normalized ?? null;
  }

  private async persistDMRoomID(userID: string, roomID: string): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    await this.stateAdapter.set(this.getDMStorageKey(userID), roomID);
  }

  private async loadDirectAccountData(): Promise<DirectAccountData> {
    const direct = await this.requireClient().getAccountDataFromServer(EventType.Direct);
    return this.normalizeDirectAccountData(direct);
  }

  private normalizeDirectAccountData(value: unknown): DirectAccountData {
    if (!value || typeof value !== "object") {
      return {};
    }

    const out: DirectAccountData = {};
    for (const [userID, roomIDs] of Object.entries(value)) {
      if (!Array.isArray(roomIDs)) {
        continue;
      }
      out[userID] = roomIDs.filter(
        (roomID): roomID is string => typeof roomID === "string" && roomID.length > 0
      );
    }

    return out;
  }

  private findExistingDirectRoomID(
    direct: DirectAccountData,
    userID: string
  ): string | null {
    const candidates = direct[userID] ?? [];
    for (const roomID of candidates) {
      if (roomID) {
        return roomID;
      }
    }
    return null;
  }

  private async persistDirectAccountDataRoom(
    userID: string,
    roomID: string,
    existing: DirectAccountData
  ): Promise<void> {
    const updated: DirectAccountData = { ...existing };
    const existingRooms = updated[userID] ?? [];
    if (!existingRooms.includes(roomID)) {
      updated[userID] = [...existingRooms, roomID];
      await this.requireClient().setAccountData(EventType.Direct, updated);
    }
  }

  private async resolveAuth(): Promise<ResolvedAuth> {
    if (this.auth.type === "accessToken") {
      const whoami = await this.lookupWhoAmIFromAccessToken(this.auth.accessToken);
      const userID = this.auth.userID ?? whoami.userID;
      const resolved: ResolvedAuth = {
        accessToken: this.auth.accessToken,
        userID,
        deviceID: whoami.deviceID ?? this.deviceID,
      };
      await this.persistDeviceIDForResolvedUser(userID);
      await this.persistSession(resolved);
      return resolved;
    }

    const restored = await this.loadPersistedSession();
    if (restored?.accessToken) {
      try {
        const whoami = await this.lookupWhoAmIFromAccessToken(restored.accessToken);
        const resolved: ResolvedAuth = {
          accessToken: restored.accessToken,
          userID: whoami.userID,
          deviceID: this.deviceID ?? whoami.deviceID ?? restored.deviceID,
        };
        await this.persistDeviceIDForResolvedUser(resolved.userID, resolved.deviceID);
        await this.persistSession(resolved);
        this.logger.info("Reused persisted Matrix session", {
          userId: resolved.userID,
        });
        return resolved;
      } catch (error) {
        this.logger.warn(
          "Persisted Matrix session is invalid. Falling back to password login.",
          { error }
        );
      }
    }

    const bootstrapClient = this.createBootstrapClient();
    const loginResponse = bootstrapClient.loginRequest
      ? await bootstrapClient.loginRequest({
          type: "m.login.password",
          password: this.auth.password,
          identifier: {
            type: "m.id.user",
            user: this.auth.username,
          },
          user: this.auth.username,
          device_id: this.deviceID,
          initial_device_display_name: this.auth.initialDeviceDisplayName,
        })
      : await bootstrapClient.loginWithPassword(
          this.auth.username,
          this.auth.password
        );

    const userID = this.auth.userID ?? loginResponse.user_id;
    if (!userID) {
      throw new Error("Password login succeeded but no user ID was returned.");
    }

    const resolved: ResolvedAuth = {
      accessToken: loginResponse.access_token,
      userID,
      deviceID: loginResponse.device_id ?? this.deviceID ?? undefined,
    };
    await this.persistDeviceIDForResolvedUser(resolved.userID, resolved.deviceID);
    await this.persistSession(resolved);
    return resolved;
  }

  private async lookupUserIDFromAccessToken(accessToken: string): Promise<string> {
    const whoami = await this.lookupWhoAmIFromAccessToken(accessToken);
    return whoami.userID;
  }

  private async lookupWhoAmIFromAccessToken(
    accessToken: string
  ): Promise<{ deviceID?: string; userID: string }> {
    const bootstrapClient = this.createBootstrapClient({
      accessToken,
      deviceID: this.deviceID,
    });
    const whoami = await bootstrapClient.whoami();
    const userID = whoami.user_id;
    const deviceID =
      typeof whoami.device_id === "string" ? whoami.device_id : undefined;

    if (!userID) {
      throw new Error("Access token whoami lookup did not return user_id.");
    }

    return { userID, deviceID };
  }

  private buildClient(auth: ResolvedAuth): MatrixClient {
    const cryptoCallbacks =
      this.recoveryKey && this.e2eeConfig?.enabled
        ? {
            getSecretStorageKey: async (
              opts: { keys: Record<string, unknown> },
              _name: string
            ) => this.getSecretStorageKeyFromRecoveryKey(opts),
          }
        : undefined;

    return sdk.createClient({
      baseUrl: this.baseURL,
      accessToken: auth.accessToken,
      userId: auth.userID,
      deviceId: auth.deviceID,
      cryptoCallbacks,
    });
  }

  private createBootstrapClient(args?: {
    accessToken?: string;
    deviceID?: string;
  }): MatrixAuthBootstrapClient {
    if (this.createBootstrapClientFn) {
      return this.createBootstrapClientFn({
        baseURL: this.baseURL,
        accessToken: args?.accessToken,
        deviceID: args?.deviceID,
      });
    }

    const client = sdk.createClient({
      baseUrl: this.baseURL,
      accessToken: args?.accessToken,
      deviceId: args?.deviceID,
    });

    return {
      loginRequest: client.loginRequest?.bind(client),
      loginWithPassword: client.loginWithPassword.bind(client),
      whoami: client.whoami.bind(client),
    };
  }

  private sendRoomMessage(
    roomID: string,
    rootEventID: string | undefined,
    content: MatrixRoomMessageContent
  ) {
    const client = this.requireClient();
    if (rootEventID) {
      return client.sendEvent(roomID, rootEventID, EventType.RoomMessage, content);
    }

    return client.sendEvent(roomID, EventType.RoomMessage, content);
  }

  private async maybeInitE2EE(): Promise<void> {
    if (!this.e2eeConfig?.enabled) {
      return;
    }

    if (!this.deviceID) {
      throw new Error(
        "E2EE is enabled but deviceID is missing. Set MATRIX_DEVICE_ID or provide config.deviceID."
      );
    }

    const requestedIndexedDB = this.e2eeConfig.useIndexedDB;
    const useIndexedDB =
      requestedIndexedDB === true && !hasIndexedDB()
        ? false
        : requestedIndexedDB;

    if (requestedIndexedDB === true && useIndexedDB === false) {
      this.logger.warn(
        "IndexedDB requested for Matrix E2EE, but indexedDB is unavailable in this runtime. Falling back to non-IndexedDB crypto store."
      );
    }

    await this.requireClient().initRustCrypto({
      useIndexedDB,
      cryptoDatabasePrefix: this.e2eeConfig.cryptoDatabasePrefix,
      storagePassword: this.e2eeConfig.storagePassword,
      storageKey: this.e2eeConfig.storageKey,
    });
    void this.maybeLoadKeyBackupFromRecoveryKey();

    this.logger.info("Matrix E2EE initialized", {
      useIndexedDB: useIndexedDB !== false,
      cryptoDatabasePrefix: this.e2eeConfig.cryptoDatabasePrefix,
    });
  }

  private async maybeLoadKeyBackupFromRecoveryKey(): Promise<void> {
    if (!this.recoveryKey) {
      return;
    }

    const crypto = this.requireClient().getCrypto();
    if (!crypto) {
      return;
    }

    try {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.checkKeyBackupAndEnable();
      this.logger.info("Loaded Matrix key backup using recovery key");
    } catch (error) {
      this.logger.warn(
        "Failed to load Matrix key backup from recovery key. E2EE will run, but historical key restore may be unavailable.",
        { error }
      );
    }
  }

  private async tryDecryptEvent(event: MatrixEvent): Promise<void> {
    if (!this.e2eeConfig?.enabled) {
      return;
    }

    if (event.getType() !== EventType.RoomMessageEncrypted) {
      return;
    }

    try {
      await this.requireClient().decryptEventIfNeeded(event);
    } catch (error) {
      this.logger.warn("Failed to decrypt Matrix event", {
        eventId: event.getId(),
        error,
      });
    }
  }

  private requireClient(): MatrixClient {
    if (!this.client) {
      throw new Error("Matrix client is not initialized");
    }
    return this.client;
  }

  private requireChat(): ChatInstance {
    if (!this.chat) {
      throw new Error("Chat instance is not initialized");
    }
    return this.chat;
  }

  private requireRoom(roomID: string): Room {
    const room = this.requireClient().getRoom(roomID);
    if (!room) {
      throw new Error(`Room not available in local sync store: ${roomID}`);
    }
    return room;
  }

  private decodeChannelID(channelId: string): string {
    const parts = channelId.split(":");
    if (parts.length !== 2 || parts[0] !== MATRIX_PREFIX) {
      throw new Error(`Invalid Matrix channel ID: ${channelId}`);
    }
    return decodeURIComponent(parts[1]);
  }

  private async onTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean
  ): Promise<void> {
    if (toStartOfTimeline) {
      return;
    }

    const eventID = event.getId();
    if (eventID) {
      if (this.processedTimelineEventIDs.has(eventID)) {
        return;
      }
      this.processedTimelineEventIDs.add(eventID);
      if (this.processedTimelineEventIDs.size > 10_000) {
        this.processedTimelineEventIDs.clear();
      }
    }

    const roomID = room?.roomId ?? event.getRoomId();
    if (!roomID) {
      return;
    }

    if (!this.liveSyncReady) {
      this.logger.debug("Ignoring pre-live-sync event", {
        eventId: eventID,
        eventType: event.getType(),
        roomId: roomID,
      });
      return;
    }
    if (this.roomAllowlist && !this.roomAllowlist.has(roomID)) {
      this.logger.debug("Ignoring event outside room allowlist", { roomId: roomID });
      return;
    }

    if (this.userID && event.getSender() === this.userID) {
      this.logger.debug("Ignoring self-sent event", {
        eventId: event.getId(),
        userId: this.userID,
      });
      return;
    }

    await this.tryDecryptEvent(event);

    const chat = this.requireChat();

    if (event.getType() === EventType.Reaction) {
      this.logger.debug("Matrix timeline event received", {
        eventId: event.getId(),
        eventType: event.getType(),
        roomId: roomID,
      });
      this.logger.debug("Processing reaction event", {
        eventId: event.getId(),
        roomId: roomID,
      });
      this.handleReactionEvent(event, roomID);
      return;
    }

    if (event.isRedaction()) {
      this.logger.debug("Matrix timeline event received", {
        eventId: event.getId(),
        eventType: event.getType(),
        roomId: roomID,
      });
      this.logger.debug("Processing redaction event", {
        eventId: event.getId(),
        redacts: event.getAssociatedId(),
      });
      this.handleReactionRedaction(event);
      return;
    }

    if (
      event.getType() !== EventType.RoomMessage &&
      event.getType() !== EventType.RoomMessageEncrypted
    ) {
      return;
    }
    this.logger.debug("Matrix timeline event received", {
      eventId: event.getId(),
      eventType: event.getType(),
      roomId: roomID,
      sender: event.getSender(),
    });

    if (event.getType() !== EventType.RoomMessage) {
      return;
    }

    const threadID = this.threadIDForEvent(event, roomID);
    const message = this.parseMessage(event);
    this.logger.debug("Dispatching Matrix message to Chat SDK", {
      eventId: event.getId(),
      threadId: threadID,
      isMention: message.isMention,
    });

    chat.processMessage(this, threadID, message);

    const slash = this.parseSlashCommand(message.text);
    if (slash) {
      this.logger.debug("Dispatching slash command", {
        command: slash.command,
        threadId: threadID,
      });
      chat.processSlashCommand({
        adapter: this,
        channelId: this.channelIdFromThreadId(threadID),
        command: slash.command,
        text: slash.text,
        raw: event,
        user: message.author,
        triggerId: event.getId(),
      });
    }
  }

  private handleReactionEvent(event: MatrixEvent, roomID: string): void {
    const content = event.getContent<{ "m.relates_to"?: Record<string, unknown> }>();
    const relatesTo = content["m.relates_to"];
    if (!relatesTo) {
      return;
    }

    const relType = relatesTo.rel_type;
    const targetEventID = relatesTo.event_id;
    const key = relatesTo.key;

    if (
      relType !== RelationType.Annotation ||
      typeof targetEventID !== "string" ||
      typeof key !== "string"
    ) {
      return;
    }

    const sender = event.getSender();
    if (!sender) {
      return;
    }

    const threadID = this.resolveReactionThreadID(roomID, targetEventID);
    const emoji = getEmoji(key);

    const reactionEventID = event.getId();
    if (reactionEventID) {
      this.reactionByEventID.set(reactionEventID, {
        roomID,
        threadID,
        messageID: targetEventID,
        emoji,
        rawEmoji: key,
        userID: sender,
      });
    }

    this.requireChat().processReaction({
      adapter: this,
      threadId: threadID,
      messageId: targetEventID,
      emoji,
      rawEmoji: key,
      added: true,
      user: this.makeUser(sender),
      raw: event,
    });
  }

  private resolveReactionThreadID(roomID: string, relatedEventID: string): string {
    const room = this.requireClient().getRoom(roomID);
    const relatedEvent = room?.findEventById(relatedEventID);
    if (!relatedEvent) {
      return this.encodeThreadId({ roomID });
    }

    return this.threadIDForEvent(relatedEvent, roomID);
  }

  private handleReactionRedaction(event: MatrixEvent): void {
    const redactedEventID = event.getAssociatedId();
    if (!redactedEventID) {
      return;
    }

    const reaction = this.reactionByEventID.get(redactedEventID);
    if (!reaction) {
      return;
    }

    this.reactionByEventID.delete(redactedEventID);

    this.requireChat().processReaction({
      adapter: this,
      threadId: reaction.threadID,
      messageId: reaction.messageID,
      emoji: reaction.emoji,
      rawEmoji: reaction.rawEmoji,
      added: false,
      user: this.makeUser(reaction.userID),
      raw: event,
    });
  }

  private threadIDForEvent(event: MatrixEvent, roomID: string): string {
    const eventID = event.getId();
    const rootEventID =
      event.threadRootId ?? (event.isThreadRoot ? eventID : undefined);

    return this.encodeThreadId({ roomID, rootEventID });
  }

  private extractText(content: MatrixMessageContent): string {
    if (typeof content.body === "string") {
      return content.body;
    }
    if (typeof content.formatted_body === "string") {
      return content.formatted_body;
    }
    return "";
  }

  private extractAttachments(content: MatrixMessageContent) {
    const url = typeof content.url === "string" ? content.url : undefined;
    if (!url) {
      return [];
    }

    const info = isRecord(content.info) ? content.info : undefined;
    const mimeType = typeof info?.mimetype === "string" ? info.mimetype : undefined;
    const attachment: { type: "file"; url: string; mimeType?: string } = {
      type: "file",
      url,
      mimeType,
    };

    return [attachment];
  }

  private isEdited(event: MatrixEvent): boolean {
    const relation = event.getRelation();
    return relation?.rel_type === RelationType.Replace;
  }

  private isMentioned(content: MatrixMessageContent, text: string): boolean {
    const formatted =
      typeof content.formatted_body === "string" ? content.formatted_body : "";

    const hasUserID = this.userID
      ? text.includes(this.userID) || formatted.includes(this.userID)
      : false;
    const hasMatrixTo = this.userID
      ? formatted.includes(`matrix.to/#/${encodeURIComponent(this.userID)}`)
      : false;

    const usernameMention = this.userName.startsWith("@")
      ? this.userName
      : `@${this.userName}`;

    const hasUserName =
      text.includes(usernameMention) || formatted.includes(usernameMention);

    return hasUserID || hasMatrixTo || hasUserName;
  }

  private parseSlashCommand(
    text: string
  ): { command: string; text: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith(this.commandPrefix)) {
      return null;
    }

    const tokens = trimmed.split(/\s+/);
    const command = tokens[0];

    if (!command || command === this.commandPrefix) {
      return null;
    }

    return {
      command,
      text: tokens.slice(1).join(" "),
    };
  }

  private toRoomMessageContent(
    message: AdapterPostableMessage
  ): MatrixTextMessageContent {
    const body = this.toText(message);

    return {
      body,
      msgtype: MsgType.Text,
    };
  }

  private toText(message: AdapterPostableMessage): string {
    if (typeof message === "string") {
      return message;
    }

    if (isCardElement(message)) {
      return "[Card message]";
    }

    if (typeof message === "object" && message !== null) {
      if ("raw" in message && typeof message.raw === "string") {
        return message.raw;
      }
      if ("markdown" in message && typeof message.markdown === "string") {
        return message.markdown;
      }
      if ("ast" in message) {
        return stringifyMarkdown(message.ast);
      }
      if ("card" in message) {
        return message.fallbackText ?? "[Card message]";
      }
    }

    return String(message);
  }

  private isMessageEvent(
    event: MatrixEvent,
    roomID: string,
    rootEventID?: string
  ): boolean {
    if (event.getType() !== EventType.RoomMessage) {
      return false;
    }

    if (event.getRoomId() !== roomID) {
      return false;
    }

    if (!rootEventID) {
      return !event.threadRootId;
    }

    return event.threadRootId === rootEventID || event.getId() === rootEventID;
  }

  private mustGetEventByID(roomID: string, eventID: string): MatrixEvent {
    const room = this.requireRoom(roomID);
    const event = room.findEventById(eventID);
    if (!event) {
      throw new Error(`Sent Matrix event not found in local timeline: ${eventID}`);
    }
    return event;
  }

  private makeUser(userId: string) {
    return {
      userId,
      userName: userId,
      fullName: userId,
      isBot: userId === this.userID,
      isMe: userId === this.userID,
    };
  }

  private myReactionKey(
    threadId: string,
    messageId: string,
    rawEmoji: string
  ): string {
    return `${threadId}::${messageId}::${rawEmoji}`;
  }

  private get sessionBasePrefix(): string {
    return `${MATRIX_SESSION_PREFIX}:${encodeURIComponent(this.baseURL)}`;
  }

  private getSessionStorageKey(userID: string): string {
    if (this.sessionConfig.key) {
      return this.sessionConfig.key;
    }

    return `${this.sessionBasePrefix}:user:${encodeURIComponent(userID)}`;
  }

  private getSessionUsernameTemporaryKey(): string | null {
    if (this.sessionConfig.key || this.auth.type !== "password") {
      return null;
    }
    return `${this.sessionBasePrefix}:username:${encodeURIComponent(this.auth.username)}`;
  }

  private async loadPersistedSession(): Promise<StoredSession | null> {
    if (!this.sessionConfig.enabled || !this.stateAdapter) {
      return null;
    }

    if (this.auth.userID) {
      const canonicalRaw = await this.stateAdapter.get<StoredSession>(
        this.getSessionStorageKey(this.auth.userID)
      );
      const canonicalSession = this.decodeStoredSession(canonicalRaw);
      if (this.isValidStoredSession(canonicalSession)) {
        return canonicalSession;
      }
    }

    const temporaryKey = this.getSessionUsernameTemporaryKey();
    if (temporaryKey) {
      const temporaryRaw = await this.stateAdapter.get<StoredSession>(temporaryKey);
      const temporarySession = this.decodeStoredSession(temporaryRaw);
      if (this.isValidStoredSession(temporarySession)) {
        return temporarySession;
      }
    }

    return null;
  }

  private async persistSession(auth: ResolvedAuth): Promise<void> {
    if (!this.sessionConfig.enabled || !this.stateAdapter) {
      return;
    }

    const now = new Date().toISOString();
    const existing = await this.loadPersistedSession();
    const session: StoredSession = {
      accessToken: auth.accessToken,
      authType: this.auth.type,
      baseURL: this.baseURL,
      createdAt: existing?.createdAt ?? now,
      deviceID: auth.deviceID,
      e2eeEnabled: Boolean(this.e2eeConfig?.enabled),
      recoveryKeyPresent: Boolean(this.e2eeConfig?.storagePassword),
      updatedAt: now,
      userID: auth.userID,
      username: this.auth.type === "password" ? this.auth.username : undefined,
    };
    const encodedSession = this.encodeStoredSession(session);

    await this.stateAdapter.set(
      this.getSessionStorageKey(auth.userID),
      encodedSession,
      this.sessionConfig.ttlMs
    );

    const temporaryKey = this.getSessionUsernameTemporaryKey();
    if (temporaryKey && temporaryKey !== this.getSessionStorageKey(auth.userID)) {
      await this.stateAdapter.set(temporaryKey, encodedSession, this.sessionConfig.ttlMs);
    }
  }

  private encodeStoredSession(session: StoredSession): StoredSession {
    if (!this.sessionConfig.encrypt) {
      return session;
    }

    const encryptedPayload = this.sessionConfig.encrypt(JSON.stringify(session));
    return {
      authType: session.authType,
      baseURL: session.baseURL,
      createdAt: session.createdAt,
      deviceID: session.deviceID,
      e2eeEnabled: session.e2eeEnabled,
      encryptedPayload,
      recoveryKeyPresent: session.recoveryKeyPresent,
      updatedAt: session.updatedAt,
      userID: session.userID,
      username: session.username,
    };
  }

  private decodeStoredSession(
    session: StoredSession | null
  ): StoredSession | null {
    if (!session || !session.encryptedPayload) {
      return session;
    }

    if (!this.sessionConfig.decrypt) {
      return null;
    }

    try {
      const decryptedJSON = this.sessionConfig.decrypt(session.encryptedPayload);
      const parsed: unknown = JSON.parse(decryptedJSON);
      if (!this.isValidStoredSession(parsed)) {
        return null;
      }
      return parsed;
    } catch (error) {
      this.logger.warn("Failed to decrypt persisted Matrix session", {
        error,
      });
      return null;
    }
  }

  private isValidStoredSession(value: unknown): value is StoredSession {
    if (!isRecord(value)) {
      return false;
    }

    return (
      typeof value.accessToken === "string" &&
      typeof value.userID === "string" &&
      typeof value.baseURL === "string" &&
      value.baseURL === this.baseURL
    );
  }

  private getSecretStorageKeyFromRecoveryKey(
    opts: { keys: Record<string, unknown> }
  ): [string, Uint8Array<ArrayBuffer>] | null {
    if (!this.recoveryKey) {
      return null;
    }

    const keyIDs = Object.keys(opts.keys ?? {});
    const keyID = keyIDs[0];
    if (!keyID) {
      return null;
    }

    const privateKey = decodeRecoveryKey(this.recoveryKey);
    return [keyID, privateKey];
  }

  private validateConfig(config: MatrixAdapterConfig): void {
    if (!config.baseURL?.trim()) {
      throw new Error("baseURL is required.");
    }
    if (config.session?.ttlMs !== undefined && config.session.ttlMs <= 0) {
      throw new Error("session.ttlMs must be a positive number.");
    }
    if (
      (config.session?.encrypt && !config.session?.decrypt) ||
      (!config.session?.encrypt && config.session?.decrypt)
    ) {
      throw new Error(
        "session.encrypt and session.decrypt must be provided together."
      );
    }
  }

  private async resolveDeviceID(): Promise<void> {
    if (this.deviceID) {
      return;
    }

    const persisted = await this.loadPersistedDeviceID();
    if (persisted) {
      this.deviceID = persisted;
      return;
    }

    const generated = generateDeviceID();
    this.deviceID = generated;
    await this.persistDeviceID(generated);
  }

  private getDeviceIDStorageKey(identityHint?: string): string {
    if (this.deviceIDPersistence.key) {
      return this.deviceIDPersistence.key;
    }

    const basePrefix = `${MATRIX_DEVICE_PREFIX}:${encodeURIComponent(this.baseURL)}`;
    const hint =
      identityHint ??
      this.auth.userID ??
      (this.auth.type === "password" ? `username:${this.auth.username}` : "default");
    return `${basePrefix}:${encodeURIComponent(hint)}`;
  }

  private async loadPersistedDeviceID(): Promise<string | null> {
    if (!this.deviceIDPersistence.enabled || !this.stateAdapter) {
      return null;
    }

    const candidates = new Set<string>([
      this.getDeviceIDStorageKey(),
      this.getDeviceIDStorageKey(this.auth.userID),
    ]);

    for (const key of candidates) {
      if (!key) {
        continue;
      }
      const value = await this.stateAdapter.get<string | null>(key);
      const normalized = normalizeOptionalString(value ?? undefined);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private async persistDeviceID(deviceID: string, identityHint?: string): Promise<void> {
    if (!this.deviceIDPersistence.enabled || !this.stateAdapter) {
      return;
    }

    await this.stateAdapter.set(this.getDeviceIDStorageKey(identityHint), deviceID);
  }

  private async persistDeviceIDForResolvedUser(
    userID: string,
    resolvedDeviceID?: string
  ): Promise<void> {
    const finalDeviceID = normalizeOptionalString(resolvedDeviceID) ?? this.deviceID;
    if (!finalDeviceID) {
      return;
    }

    this.deviceID = finalDeviceID;
    await this.persistDeviceID(finalDeviceID, userID);

    const temporaryKey = this.getDeviceIDStorageKey();
    const canonicalKey = this.getDeviceIDStorageKey(userID);
    if (
      this.deviceIDPersistence.enabled &&
      this.stateAdapter &&
      !this.deviceIDPersistence.key &&
      temporaryKey !== canonicalKey
    ) {
      await this.stateAdapter.delete(temporaryKey);
    }
  }

  private configureMatrixSDKLogging(): void {
    if (matrixSDKLogConfigured) {
      return;
    }

    const requestedLevel = this.matrixSDKLogLevel;
    if (!requestedLevel) {
      return;
    }

    const numericLevel = MATRIX_SDK_LOG_LEVELS[requestedLevel];
    if (numericLevel === undefined) {
      return;
    }

    const setLevel = Reflect.get(matrixSDKLogger, "setLevel");
    if (typeof setLevel === "function") {
      setLevel.call(matrixSDKLogger, numericLevel, false);
    }
    matrixSDKLogConfigured = true;
  }
}

export function createMatrixAdapter(config: MatrixAdapterConfig): MatrixAdapter;
export function createMatrixAdapter(): MatrixAdapter;
export function createMatrixAdapter(config?: MatrixAdapterConfig): MatrixAdapter {
  if (config) {
    const normalizedDeviceID = normalizeOptionalString(config.deviceID);
    return new MatrixAdapter({
      ...config,
      deviceID: normalizedDeviceID,
    });
  }

  const baseURL = process.env.MATRIX_BASE_URL;
  if (!baseURL) {
    throw new Error("baseURL is required. Set MATRIX_BASE_URL.");
  }

  const recoveryKey = process.env.MATRIX_RECOVERY_KEY;
  const e2eeEnabled =
    Boolean(recoveryKey) || envBool(process.env.MATRIX_E2EE_ENABLED);

  const auth = resolveAuthFromEnv();

  return new MatrixAdapter({
    baseURL,
    auth,
    userName:
      process.env.MATRIX_BOT_USERNAME ??
      process.env.MOM_BOT_USERNAME ??
      "bot",
    deviceID: normalizeOptionalString(process.env.MATRIX_DEVICE_ID),
    deviceIDPersistence: {
      enabled: envBool(process.env.MATRIX_DEVICE_ID_PERSIST_ENABLED, true),
      key: normalizeOptionalString(process.env.MATRIX_DEVICE_ID_PERSIST_KEY),
    },
    commandPrefix: process.env.MATRIX_COMMAND_PREFIX,
    recoveryKey,
    e2ee: {
      enabled: e2eeEnabled,
      useIndexedDB: envBool(
        process.env.MATRIX_E2EE_USE_INDEXEDDB,
        hasIndexedDB()
      ),
      cryptoDatabasePrefix: process.env.MATRIX_E2EE_DB_PREFIX,
      storagePassword: process.env.MATRIX_E2EE_STORAGE_PASSWORD ?? recoveryKey,
      storageKey: decodeBase64(
        process.env.MATRIX_E2EE_STORAGE_KEY_BASE64,
        "MATRIX_E2EE_STORAGE_KEY_BASE64"
      ),
    },
    session: {
      enabled: envBool(process.env.MATRIX_SESSION_ENABLED, true),
      key: process.env.MATRIX_SESSION_KEY,
      ttlMs: parseEnvNumber(process.env.MATRIX_SESSION_TTL_MS),
    },
    matrixSDKLogLevel:
      parseSDKLogLevel(process.env.MATRIX_SDK_LOG_LEVEL) ?? "error",
  });
}

export type { MatrixAdapterConfig, MatrixThreadID } from "./types";

function resolveAuthFromEnv(): MatrixAuthConfig {
  const username = process.env.MATRIX_USERNAME;
  const password = process.env.MATRIX_PASSWORD;

  if (username && password) {
    return {
      type: "password",
      username,
      password,
      userID: process.env.MATRIX_USER_ID,
    };
  }

  const accessToken = process.env.MATRIX_ACCESS_TOKEN;
  const userID = process.env.MATRIX_USER_ID;

  if (!accessToken) {
    throw new Error(
      "Set MATRIX_USERNAME+MATRIX_PASSWORD for password auth, or MATRIX_ACCESS_TOKEN for access token auth."
    );
  }

  const auth: MatrixAccessTokenAuthConfig = {
    type: "accessToken",
    accessToken,
    userID,
  };

  return auth;
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function decodeBase64(
  value: string | undefined,
  envName: string
): Uint8Array | undefined {
  if (!value) {
    return undefined;
  }

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) {
    throw new Error(`${envName} is set but could not be decoded as base64.`);
  }

  return bytes;
}

function parseEnvNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got: ${value}`);
  }

  return parsed;
}

function generateDeviceID(length = 8): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "chatsdk_";

  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== "undefined" && globalThis.indexedDB !== null;
}

function parseSDKLogLevel(
  value: string | undefined
): MatrixAdapterConfig["matrixSDKLogLevel"] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "trace" ||
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
