import { randomBytes } from "node:crypto";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FileUpload,
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
  markdownToPlainText,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import sdk, {
  Direction,
  MatrixEvent,
  type ICreateClientOpts,
  type MatrixClient,
  type IEvent,
  type IThreadBundledRelationship,
  type Room,
  type RoomMember,
  ClientEvent,
  EventType,
  MsgType,
  RelationType,
  RoomEvent,
  SyncState,
  ThreadFilterType,
  THREAD_RELATION_TYPE,
} from "matrix-js-sdk";
import type { IStore } from "matrix-js-sdk/lib/store";
import type {
  RoomMessageEventContent,
  RoomMessageTextEventContent,
} from "matrix-js-sdk/lib/@types/events";
import type { MediaEventContent } from "matrix-js-sdk/lib/@types/media";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { logger as matrixSDKLogger } from "matrix-js-sdk/lib/logger";
import { marked } from "marked";
import {
  HTMLElement,
  NodeType,
  parse as parseHTML,
  type Node as HTMLNode,
} from "node-html-parser";
import { ChatStateMatrixStore } from "./store/chat-state-matrix-store";
import type {
  MatrixAuthBootstrapClient,
  MatrixAccessTokenAuthConfig,
  MatrixAdapterConfig,
  MatrixAuthConfig,
  MatrixCreateStoreOptions,
  MatrixPersistenceConfig,
  MatrixPersistenceSyncConfig,
  MatrixThreadID,
} from "./types";

const MATRIX_PREFIX = "matrix";
const MATRIX_CURSOR_PREFIX = "mxv1:";
const DEFAULT_COMMAND_PREFIX = "/";
const DEFAULT_PERSISTENCE_KEY_PREFIX = "matrix";
const TYPING_TIMEOUT_MS = 30_000;
const DEFAULT_MATRIX_STORE_PERSIST_INTERVAL_MS = 30_000;
const DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES = 12_000;
const FAST_SYNC_DEFAULTS: NonNullable<MatrixAdapterConfig["sync"]> = {
  initialSyncLimit: 1,
  lazyLoadMembers: true,
  disablePresence: true,
  pollTimeout: 10_000,
};
type SDKLogLevel = NonNullable<MatrixAdapterConfig["matrixSDKLogLevel"]>;
const MATRIX_SDK_LOG_LEVELS: Record<SDKLogLevel, number> = {
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
  "m.mentions"?: {
    room?: boolean;
    user_ids?: string[];
  };
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

type MatrixOutboundMessageContent = MatrixRoomMessageContent | MediaEventContent;

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

type ResolvedPersistenceConfig = {
  keyPrefix: string;
  session: Pick<NonNullable<MatrixPersistenceConfig["session"]>, "decrypt" | "encrypt" | "ttlMs">;
  sync: Required<Pick<NonNullable<MatrixPersistenceSyncConfig>, "persistIntervalMs">> &
    Pick<NonNullable<MatrixPersistenceSyncConfig>, "snapshotTtlMs">;
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

type OutboundUpload = {
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

type MatrixMediaMsgType =
  | MsgType.Audio
  | MsgType.File
  | MsgType.Image
  | MsgType.Video;

type ParsedMatrixContent = {
  markdown: string;
  mentionsRoom: boolean;
  mentionedUserIDs: Set<string>;
  text: string;
};

type RenderedMatrixMessage = {
  body: string;
  formattedBody?: string;
  mentions?: {
    room?: boolean;
    user_ids?: string[];
  };
};

type MatrixRoomMetadata = {
  avatarURL?: string;
  canonicalAlias?: string;
  encrypted: boolean;
  encryptionAlgorithm?: string;
  isDM: boolean;
  name?: string;
  roomID: string;
  topic?: string;
};

// Intentionally unsupported in this adapter: postEphemeral, openModal, and native stream.
export class MatrixAdapter implements Adapter<MatrixThreadID, MatrixEvent> {
  readonly name = "matrix";
  readonly userName: string;

  private readonly baseURL: string;
  private readonly auth: MatrixAuthConfig;
  private readonly commandPrefix: string;
  private readonly roomAllowlist?: Set<string>;
  private readonly inviteAutoJoinEnabled: boolean;
  private readonly inviteAutoJoinInviterAllowlist?: Set<string>;
  private readonly syncOptions?: MatrixAdapterConfig["sync"];
  private readonly createClientFn?: MatrixAdapterConfig["createClient"];
  private readonly createStoreFn?: MatrixAdapterConfig["createStore"];
  private readonly createBootstrapClientFn?: MatrixAdapterConfig["createBootstrapClient"];
  private readonly e2eeConfig?: MatrixAdapterConfig["e2ee"];
  private readonly e2eeEnabled: boolean;
  private readonly persistenceConfig: ResolvedPersistenceConfig;
  private readonly recoveryKey?: string;
  private readonly matrixSDKLogLevel?: MatrixAdapterConfig["matrixSDKLogLevel"];
  private readonly loggerProvided: boolean;

  private logger: Logger;
  private chat: ChatInstance | null = null;
  private stateAdapter: StateAdapter | null = null;
  private client: MatrixClient | null = null;
  private matrixStoreScopeKey: string | null = null;
  private started = false;
  private userID: string;
  private deviceID?: string;
  private readonly reactionByEventID = new Map<string, StoredReaction>();
  private readonly myReactionByKey = new Map<string, string>();
  private readonly processedTimelineEventIDs = new Set<string>();
  private lastSecretsBundlePersistAt = 0;
  private secretsBundleUnavailableLogged = false;
  private liveSyncReady = false;
  private shuttingDown = false;

  constructor(config: MatrixAdapterConfig) {
    this.validateConfig(config);
    this.baseURL = config.baseURL;
    this.auth = config.auth;
    this.userID = config.auth.userID ?? "";
    this.deviceID = normalizeOptionalString(config.deviceID);
    this.userName = config.userName ?? "bot";
    this.commandPrefix = config.commandPrefix ?? DEFAULT_COMMAND_PREFIX;
    this.roomAllowlist = config.roomAllowlist
      ? new Set(config.roomAllowlist)
      : undefined;
    const inviteAutoJoinInviterAllowlist = normalizeStringList(
      config.inviteAutoJoin?.inviterAllowlist
    );
    this.inviteAutoJoinEnabled = Boolean(config.inviteAutoJoin);
    this.inviteAutoJoinInviterAllowlist =
      inviteAutoJoinInviterAllowlist.length > 0
        ? new Set(inviteAutoJoinInviterAllowlist)
        : undefined;
    this.syncOptions = config.sync ?? FAST_SYNC_DEFAULTS;
    this.createClientFn = config.createClient;
    this.createStoreFn = config.createStore;
    this.createBootstrapClientFn = config.createBootstrapClient;
    this.e2eeEnabled = Boolean(config.recoveryKey || config.e2ee);
    this.e2eeConfig = {
      ...config.e2ee,
      storagePassword:
        config.e2ee?.storagePassword ?? config.recoveryKey,
    };
    this.persistenceConfig = normalizePersistenceConfig(config.persistence);
    this.recoveryKey = normalizeOptionalString(config.recoveryKey);
    this.matrixSDKLogLevel = config.matrixSDKLogLevel;
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

    let resolvedAuth: ResolvedAuth | null = null;
    if (this.createClientFn) {
      await this.resolveDeviceID();
      const store = await this.maybeCreateMatrixStore();
      this.matrixStoreScopeKey = this.resolveMatrixStoreContext()?.scopeKey ?? null;
      const clientOptions = this.buildCustomClientOptions(store);
      this.client = this.createClientFn(clientOptions);
    } else {
      resolvedAuth = await this.resolveAuth();
      this.userID = resolvedAuth.userID;
      this.deviceID = normalizeOptionalString(resolvedAuth.deviceID) ?? this.deviceID;
      const store = await this.maybeCreateMatrixStore(resolvedAuth);
      this.matrixStoreScopeKey =
        this.resolveMatrixStoreContext(resolvedAuth)?.scopeKey ?? null;
      this.client = this.buildClient(resolvedAuth, store);
    }

    this.client.on(ClientEvent.Sync, (state: string) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        this.liveSyncReady = true;
      }
      this.logger.debug("Matrix sync state", { state });
    });

    this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      this.dispatchTimelineEvent(event, room, Boolean(toStartOfTimeline));
    });
    this.client.on(ClientEvent.Event, (event) => {
      if (!event.getRoomId()) {
        return;
      }
      this.dispatchTimelineEvent(event, undefined, false);
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
    return this.userID || undefined;
  }

  async shutdown(): Promise<void> {
    if (!this.client || this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    try {
      await this.maybePersistSecretsBundle(true);
      await this.maybeFlushMatrixStore();
      this.client.removeAllListeners();
      this.client.stopClient();
      this.reactionByEventID.clear();
      this.myReactionByKey.clear();
      this.client = null;
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
    return this.encodeThreadId({ roomID });
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
    const replyEventID = this.extractReplyEventID(message);
    const contents = await this.toRoomMessageContents(message);
    const [firstContent, ...extraContents] = contents;
    if (!firstContent) {
      throw new Error("Cannot post an empty Matrix message.");
    }
    const response = await this.sendRoomMessage(
      roomID,
      rootEventID,
      replyEventID,
      firstContent,
    );
    for (const content of extraContents) {
      await this.sendRoomMessage(roomID, rootEventID, replyEventID, content);
    }

    return {
      id: response.event_id,
      threadId,
      raw: this.resolveSentEvent(roomID, response.event_id, {
        content: firstContent,
        roomID,
        sender: this.userID,
      }),
    };
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<MatrixEvent>> {
    const roomID = this.decodeThreadId(channelId).roomID;
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

    const response = await this.sendRoomMessage(roomID, rootEventID, undefined, editContent);

    return {
      id: response.event_id,
      threadId,
      raw: this.resolveSentEvent(roomID, response.event_id, {
        content: editContent,
        roomID,
        sender: this.userID,
      }),
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { roomID } = this.decodeThreadId(threadId);
    await this.withLoggedMatrixOperation(
      "Matrix redact message failed",
      {
        roomId: roomID,
        eventId: messageId,
      },
      () => this.requireClient().redactEvent(roomID, messageId)
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const rawEmoji = this.rawEmoji(emoji);

    const response = await this.withLoggedMatrixOperation(
      "Matrix send reaction failed",
      {
        roomId: roomID,
        rootEventId: rootEventID,
        messageId,
        emoji: rawEmoji,
      },
      () =>
        this.requireClient().sendEvent(roomID, rootEventID ?? null, EventType.Reaction, {
          "m.relates_to": {
            rel_type: RelationType.Annotation,
            event_id: messageId,
            key: rawEmoji,
          },
        })
    );

    const key = this.myReactionKey(threadId, messageId, rawEmoji);
    this.myReactionByKey.set(key, response.event_id);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const rawEmoji = this.rawEmoji(emoji);
    const reactionEventID = this.myReactionByKey.get(
      this.myReactionKey(threadId, messageId, rawEmoji)
    );

    if (!reactionEventID) {
      return;
    }

    const { roomID } = this.decodeThreadId(threadId);
    await this.withLoggedMatrixOperation(
      "Matrix remove reaction failed",
      {
        roomId: roomID,
        reactionEventId: reactionEventID,
        messageId,
        emoji: rawEmoji,
      },
      () => this.requireClient().redactEvent(roomID, reactionEventID)
    );
    this.myReactionByKey.delete(this.myReactionKey(threadId, messageId, rawEmoji));
  }

  async startTyping(threadId: string): Promise<void> {
    const { roomID } = this.decodeThreadId(threadId);
    await this.withLoggedMatrixOperation(
      "Matrix typing request failed",
      {
        roomId: roomID,
        timeoutMs: TYPING_TIMEOUT_MS,
      },
      () => this.requireClient().sendTyping(roomID, true, TYPING_TIMEOUT_MS)
    );
  }

  async openDM(userId: string): Promise<string> {
    const cachedRoomID = await this.loadPersistedDMRoomID(userId);
    if (cachedRoomID) {
      if (this.isUsableDirectRoom(cachedRoomID)) {
        return this.encodeThreadId({ roomID: cachedRoomID });
      }
      await this.clearPersistedDMRoomID(userId);
    }

    const direct = await this.loadDirectAccountData();
    const existingRoomID = this.findExistingDirectRoomID(direct, userId);
    if (existingRoomID) {
      await this.persistDMRoomID(userId, existingRoomID);
      return this.encodeThreadId({ roomID: existingRoomID });
    }

    const response = await this.withLoggedMatrixOperation(
      "Matrix create DM room failed",
      {
        userId,
      },
      () =>
        this.requireClient().createRoom({
          invite: [userId],
          is_direct: true,
        })
    );

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
          rootEventID,
          direction
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
    const roomID = this.decodeThreadId(channelId).roomID;
    return this.fetchMessages(this.encodeThreadId({ roomID }), options);
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
    const isDM = await this.isDirectRoom(roomID);
    const metadata = this.readRoomMetadata(room, isDM);

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: metadata.name,
      isDM,
      metadata,
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const roomID = this.decodeThreadId(channelId).roomID;
    const room = this.requireRoom(roomID);
    const isDM = await this.isDirectRoom(roomID);
    const metadata = this.readRoomMetadata(room, isDM);

    const members = room.getJoinedMembers();
    return {
      id: channelId,
      name: metadata.name,
      isDM,
      memberCount: members.length,
      metadata,
    };
  }

  async listThreads(
    channelId: string,
    options: ListThreadsOptions = {}
  ): Promise<ListThreadsResult<MatrixEvent>> {
    const roomID = this.decodeThreadId(channelId).roomID;
    const limit = options.limit ?? 50;
    const cursor = options.cursor
      ? this.decodeCursorV1(options.cursor, "thread_list", roomID, undefined, "backward")
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
            dir: "backward",
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
    const edited = this.extractEditedContent(raw);
    const effectiveContent = edited?.content ?? content;
    const parsed = this.parseMatrixContent(effectiveContent);
    const sender = raw.getSender() ?? "unknown";

    return new Message<MatrixEvent>({
      id: raw.getId() ?? `${roomID}:${raw.getTs()}`,
      threadId: threadID,
      text: parsed.text,
      formatted: parseMarkdown(parsed.markdown),
      author: this.makeUser(sender, roomID),
      metadata: {
        dateSent: new Date(raw.getTs()),
        edited: this.isEdited(raw) || Boolean(edited?.content),
        editedAt: edited?.editedAt,
      },
      attachments: this.extractAttachments(effectiveContent),
      raw,
      isMention: this.isMentioned(effectiveContent, parsed),
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

  private toSDKDirection(dir: CursorDirection): Direction {
    return dir === "forward" ? Direction.Forward : Direction.Backward;
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
      this.toSDKDirection(args.direction)
    );
    const messageChunk = (response.chunk ?? []).filter(
      (raw) =>
        raw.type === EventType.RoomMessage ||
        raw.type === EventType.RoomMessageEncrypted
    );
    const events = await this.mapRawEvents(messageChunk, args.roomID);
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
    // When includeRoot is true, reserve one slot for the root and fetch at most
    // limit - 1 replies; the merged result is sliced back to args.limit below.
    const relationLimit = args.includeRoot
      ? Math.max(args.limit - 1, 1)
      : args.limit;

    const relationResponse = await this.requireClient().relations(
      args.roomID,
      args.rootEventID,
      THREAD_RELATION_TYPE.name,
      null,
      {
        dir: this.toSDKDirection(args.direction),
        from: args.fromToken ?? undefined,
        limit: relationLimit,
      }
    );

    const candidateEvents = relationResponse.events.filter(
      (event) =>
        event.getType() === EventType.RoomMessage ||
        event.getType() === EventType.RoomMessageEncrypted
    );
    await Promise.all(
      candidateEvents.map((event) => this.tryDecryptEvent(event))
    );
    const replies = this.sortEventsChronologically(
      candidateEvents.filter((event) =>
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
    const mapper = this.requireClient().getEventMapper();
    const events = rawEvents.map((event) => {
      const withRoomID = event.room_id ? event : { ...event, room_id: roomID };
      return mapper(withRoomID);
    });
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
    } catch (error) {
      const isNotFound =
        error instanceof MatrixError &&
        (error.errcode === "M_NOT_FOUND" || error.httpStatus === 404);
      if (isNotFound) {
        this.logger.debug("Room event not found", { roomID, eventID });
        return null;
      }
      throw error;
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
    return !event.threadRootId && !event.getRelation();
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
    return `${this.persistenceConfig.keyPrefix}:dm:${encodeURIComponent(userID)}`;
  }

  private async loadPersistedDMRoomID(userID: string): Promise<string | null> {
    if (!this.stateAdapter) {
      return null;
    }

    const cached = await this.stateAdapter.get<string | null>(
      this.getDMStorageKey(userID)
    );
    const normalized = normalizeOptionalString(cached);
    return normalized ?? null;
  }

  private async clearPersistedDMRoomID(userID: string): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    await this.stateAdapter.delete(this.getDMStorageKey(userID));
  }

  private async persistDMRoomID(userID: string, roomID: string): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    await this.stateAdapter.set(this.getDMStorageKey(userID), roomID);
  }

  private async loadDirectAccountData(): Promise<DirectAccountData> {
    const cached = this.loadCachedDirectAccountData();
    if (Object.keys(cached).length > 0) {
      return cached;
    }

    const direct = await this.requireClient().getAccountDataFromServer(EventType.Direct);
    return this.normalizeDirectAccountData(direct);
  }

  private loadCachedDirectAccountData(): DirectAccountData {
    const client = this.requireClient();
    const getAccountData = Reflect.get(client, "getAccountData");
    if (typeof getAccountData !== "function") {
      return {};
    }

    const event = getAccountData.call(client, EventType.Direct);
    const direct =
      typeof event === "object" &&
      event !== null &&
      typeof Reflect.get(event, "getContent") === "function"
        ? Reflect.get(event, "getContent").call(event)
        : undefined;
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
    const client = this.requireClient();
    const candidates = direct[userID] ?? [];
    for (const roomID of candidates) {
      if (!roomID) {
        continue;
      }

      const room = client.getRoom(roomID);
      if (!room) {
        // m.direct is server state; if the room is not in the local sync cache yet,
        // prefer the server mapping over creating a duplicate DM.
        return roomID;
      }

      const membership = room.getMyMembership();
      if (membership === "join" || membership === "invite") {
        return roomID;
      }
    }
    return null;
  }

  private async isDirectRoom(roomID: string): Promise<boolean> {
    const cached = this.loadCachedDirectAccountData();
    if (this.directAccountDataContainsRoom(cached, roomID)) {
      return true;
    }

    const direct = await this.loadDirectAccountData();
    return this.directAccountDataContainsRoom(direct, roomID);
  }

  private directAccountDataContainsRoom(
    direct: DirectAccountData,
    roomID: string
  ): boolean {
    return Object.values(direct).some((roomIDs) => roomIDs.includes(roomID));
  }

  private async persistDirectAccountDataRoom(
    userID: string,
    roomID: string,
    existing: DirectAccountData
  ): Promise<void> {
    const latest = await this.loadLatestDirectAccountData(existing);
    const existingRooms = latest[userID] ?? [];
    if (!existingRooms.includes(roomID)) {
      const updated: DirectAccountData = {
        ...latest,
        [userID]: [...existingRooms, roomID],
      };
      await this.requireClient().setAccountData(EventType.Direct, updated);
    }
  }

  private async loadLatestDirectAccountData(
    fallback: DirectAccountData
  ): Promise<DirectAccountData> {
    try {
      const direct = await this.requireClient().getAccountDataFromServer(EventType.Direct);
      return this.normalizeDirectAccountData(direct);
    } catch (error) {
      this.logger.debug("Failed to refresh m.direct before writing; using cached snapshot", {
        error,
      });
      return fallback;
    }
  }

  private async resolveAuth(): Promise<ResolvedAuth> {
    if (this.auth.type === "accessToken") {
      const whoami = await this.lookupWhoAmIFromAccessToken(this.auth.accessToken);
      const userID = this.auth.userID ?? whoami.userID;
      const deviceID = await this.resolveDeviceID(whoami.deviceID);
      const resolved: ResolvedAuth = {
        accessToken: this.auth.accessToken,
        userID,
        deviceID,
      };
      await Promise.all([
        this.persistDeviceIDForResolvedUser(userID, resolved.deviceID),
        this.persistSession(resolved),
      ]);
      return resolved;
    }

    const restored = await this.loadPersistedSession();
    if (restored?.accessToken) {
      try {
        const whoami = await this.lookupWhoAmIFromAccessToken(restored.accessToken);
        const deviceID = await this.resolveDeviceID(
          whoami.deviceID,
          restored.deviceID
        );
        const resolved: ResolvedAuth = {
          accessToken: restored.accessToken,
          userID: whoami.userID,
          deviceID,
        };
        await Promise.all([
          this.persistDeviceIDForResolvedUser(resolved.userID, resolved.deviceID),
          this.persistSession(resolved, restored.createdAt),
        ]);
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

    let userID = this.auth.userID ?? loginResponse.user_id;
    if (!userID) {
      throw new Error("Password login succeeded but no user ID was returned.");
    }

    let authDeviceID = normalizeOptionalString(loginResponse.device_id);
    if (!authDeviceID) {
      const whoami = await this.lookupWhoAmIFromAccessToken(loginResponse.access_token);
      userID = userID ?? whoami.userID;
      authDeviceID = whoami.deviceID;
    }

    const deviceID = await this.resolveDeviceID(authDeviceID);
    const resolved: ResolvedAuth = {
      accessToken: loginResponse.access_token,
      userID,
      deviceID,
    };
    await Promise.all([
      this.persistDeviceIDForResolvedUser(resolved.userID, resolved.deviceID),
      this.persistSession(resolved),
    ]);
    return resolved;
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

  private buildClient(auth: ResolvedAuth, store?: IStore): MatrixClient {
    const cryptoCallbacks =
      this.recoveryKey && this.e2eeEnabled
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
      store,
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

  private buildCustomClientOptions(store?: IStore): ICreateClientOpts | undefined {
    if (!store) {
      return undefined;
    }

    const customUserID =
      normalizeOptionalString(this.auth.userID) ??
      normalizeOptionalString(this.userID);

    return {
      baseUrl: this.baseURL,
      accessToken:
        this.auth.type === "accessToken" ? this.auth.accessToken : undefined,
      userId: customUserID,
      deviceId: this.deviceID,
      store,
    };
  }

  private async maybeCreateMatrixStore(resolvedAuth?: ResolvedAuth): Promise<IStore | undefined> {
    if (!this.stateAdapter) {
      return undefined;
    }

    const storeContext = this.resolveMatrixStoreContext(resolvedAuth);
    if (!storeContext) {
      return undefined;
    }

    const { scopeKey, userID, deviceID } = storeContext;
    this.matrixStoreScopeKey = scopeKey;

    const createStoreOptions: MatrixCreateStoreOptions = {
      baseURL: this.baseURL,
      config: { ...this.persistenceConfig.sync },
      deviceID,
      logger: this.logger,
      scopeKey,
      state: this.stateAdapter,
      userID,
    };

    if (this.createStoreFn) {
      return this.createStoreFn(createStoreOptions);
    }

    return new ChatStateMatrixStore({
      state: this.stateAdapter,
      scopeKey,
      logger: this.logger,
      persistIntervalMs: this.persistenceConfig.sync.persistIntervalMs,
      snapshotTtlMs: this.persistenceConfig.sync.snapshotTtlMs,
    });
  }

  private resolveMatrixStoreContext(
    resolvedAuth?: ResolvedAuth
  ): { deviceID?: string; scopeKey: string; userID: string } | null {
    const userID = normalizeOptionalString(resolvedAuth?.userID) ??
      normalizeOptionalString(this.auth.userID) ??
      normalizeOptionalString(this.userID);
    if (!userID) {
      this.logger.warn(
        "No user ID is available for Matrix persistence scoping. Continuing without persistent sync store."
      );
      return null;
    }

    const deviceID = normalizeOptionalString(resolvedAuth?.deviceID) ?? this.deviceID;
    return {
      userID,
      deviceID,
      scopeKey: this.buildMatrixStoreScopeKey(userID, deviceID),
    };
  }

  private buildMatrixStoreScopeKey(userID: string, deviceID?: string): string {
    return `${this.persistenceStorePrefix}:${encodeURIComponent(this.baseURL)}:${encodeURIComponent(userID)}:${encodeURIComponent(deviceID ?? "default")}`;
  }

  private async maybeFlushMatrixStore(): Promise<void> {
    const store = this.client?.store as { save?: (force?: boolean) => Promise<void> } | undefined;
    if (!store?.save) {
      return;
    }

    try {
      await store.save(true);
    } catch (error) {
      this.logger.warn("Failed to flush Matrix sync store during shutdown", { error });
    }
  }

  private dispatchTimelineEvent(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean
  ): void {
    void this.onTimelineEvent(event, room, toStartOfTimeline).catch((error) => {
      this.logger.error("Unhandled Matrix timeline event failure", {
        eventId: event.getId(),
        eventType: event.getType(),
        roomId: room?.roomId ?? event.getRoomId(),
        error,
      });
    });
  }

  private async withLoggedMatrixOperation<T>(
    message: string,
    context: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(message, { ...context, error });
      throw error;
    }
  }

  private async sendRoomMessage(
    roomID: string,
    rootEventID: string | undefined,
    replyEventID: string | undefined,
    content: MatrixOutboundMessageContent
  ) {
    const threadContent = this.applyThreadReplyMetadata(content, rootEventID, replyEventID);

    try {
      const response = await this.performSendRoomMessage(roomID, rootEventID, threadContent);
      void this.maybePersistSecretsBundle();
      return response;
    } catch (error) {
      if (this.isTooLargeMatrixError(error)) {
        const splitContents = this.splitOversizedTextContent(threadContent);
        if (splitContents.length > 1) {
          this.logger.warn(
            "Matrix message exceeded size limit; retrying as split plain-text chunks",
            {
              roomId: roomID,
              rootEventId: rootEventID,
              originalLength: typeof threadContent.body === "string" ? threadContent.body.length : undefined,
              chunkCount: splitContents.length,
              msgtype: threadContent.msgtype,
            }
          );

          let firstResponse: Awaited<ReturnType<MatrixClient["sendEvent"]>> | undefined;
          for (const splitContent of splitContents) {
            const response = await this.sendRoomMessage(
              roomID,
              rootEventID,
              replyEventID,
              splitContent
            );
            firstResponse ??= response;
          }

          if (firstResponse) {
            return firstResponse;
          }
        }
      }

      this.logger.error("Matrix send message failed", {
        roomId: roomID,
        rootEventId: rootEventID,
        eventType: EventType.RoomMessage,
        msgtype: content.msgtype,
        error,
      });
      throw error;
    }
  }

  private async toRoomMessageContents(
    message: AdapterPostableMessage
  ): Promise<MatrixOutboundMessageContent[]> {
    const textContent = this.toRoomMessageContent(message);
    const attachments = this.extractAttachmentsFromMessage(message);
    const uploads = await this.collectUploads(message, attachments);
    const linkLines = this.collectLinkOnlyAttachmentLines(attachments);
    const textBody = this.mergeTextAndLinks(textContent, linkLines);
    const contents: MatrixOutboundMessageContent[] = [];

    if ((normalizeOptionalString(textBody.body) ?? "").length > 0) {
      contents.push(textBody);
    }

    const uploadedContents = await Promise.all(
      uploads.map(async (upload) => {
        const uploadResponse = await this.withLoggedMatrixOperation(
          "Matrix upload content failed",
          {
            fileName: upload.fileName,
            mimeType: upload.info?.mimetype,
            msgtype: upload.msgtype,
          },
          () =>
            this.requireClient().uploadContent(upload.data, {
              name: upload.fileName,
              type: upload.info?.mimetype,
            })
        );
        const content: MediaEventContent = {
          body: upload.fileName,
          msgtype: upload.msgtype,
          url: uploadResponse.content_uri,
          info: upload.info,
        };
        return content;
      })
    );
    contents.push(...uploadedContents);

    return contents;
  }

  private async maybeInitE2EE(): Promise<void> {
    if (!this.e2eeEnabled) {
      return;
    }

    if (!this.deviceID) {
      throw new Error(
        "E2EE is enabled but deviceID is missing. Set MATRIX_DEVICE_ID or provide config.deviceID."
      );
    }

    const e2eeConfig = this.e2eeConfig ?? {};
    const requestedIndexedDB = e2eeConfig.useIndexedDB;
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
      cryptoDatabasePrefix: e2eeConfig.cryptoDatabasePrefix,
      storagePassword: e2eeConfig.storagePassword,
      storageKey: e2eeConfig.storageKey,
    });
    await this.maybeImportPersistedSecretsBundle();
    void this.maybeLoadKeyBackupFromRecoveryKey();
    void this.maybePersistSecretsBundle();

    this.logger.info("Matrix E2EE initialized", {
      useIndexedDB: useIndexedDB !== false,
      cryptoDatabasePrefix: e2eeConfig.cryptoDatabasePrefix,
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

  private get persistSecretsBundleEnabled(): boolean {
    return Boolean(this.e2eeEnabled && this.stateAdapter);
  }

  private getSecretsBundleStorageKey(): string | null {
    if (!this.persistSecretsBundleEnabled || !this.matrixStoreScopeKey) {
      return null;
    }

    return `${this.matrixStoreScopeKey}:secrets-bundle`;
  }

  private async maybeImportPersistedSecretsBundle(): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    const storageKey = this.getSecretsBundleStorageKey();
    if (!storageKey) {
      return;
    }

    const crypto = this.requireClient().getCrypto();
    if (!crypto?.importSecretsBundle) {
      return;
    }

    try {
      const bundle = await this.stateAdapter.get<unknown>(storageKey);
      if (!bundle) {
        return;
      }

      await crypto.importSecretsBundle(bundle as Parameters<
        NonNullable<NonNullable<typeof crypto>["importSecretsBundle"]>
      >[0]);
      this.logger.info("Imported persisted Matrix secrets bundle");
    } catch (error) {
      this.logger.warn("Failed to import persisted Matrix secrets bundle", { error });
    }
  }

  private async maybePersistSecretsBundle(force = false): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    const storageKey = this.getSecretsBundleStorageKey();
    if (!storageKey) {
      return;
    }

    const crypto = this.client?.getCrypto();
    if (!crypto?.exportSecretsBundle) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastSecretsBundlePersistAt < 60_000) {
      return;
    }

    try {
      const bundle = await crypto.exportSecretsBundle();
      await this.stateAdapter.set(storageKey, bundle);
      this.lastSecretsBundlePersistAt = now;
      this.secretsBundleUnavailableLogged = false;
      if (force) {
        this.logger.debug("Persisted Matrix secrets bundle during shutdown");
      }
    } catch (error) {
      if (this.isExpectedSecretsBundleUnavailableError(error)) {
        if (!this.secretsBundleUnavailableLogged) {
          this.logger.debug(
            "Skipping Matrix secrets bundle persistence because cross-signing secrets are not available yet"
          );
          this.secretsBundleUnavailableLogged = true;
        }
        return;
      }
      this.logger.warn("Failed to persist Matrix secrets bundle", { error });
    }
  }

  private isExpectedSecretsBundleUnavailableError(error: unknown): boolean {
    return error instanceof Error &&
      error.message.includes("cross-signing keys");
  }

  private async tryDecryptEvent(event: MatrixEvent): Promise<void> {
    if (!this.e2eeEnabled) {
      return;
    }

    if (event.getType() !== EventType.RoomMessageEncrypted) {
      return;
    }

    try {
      await this.requireClient().decryptEventIfNeeded(event);
      void this.maybePersistSecretsBundle();
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
      evictOldestEntries(this.processedTimelineEventIDs);
    }

    const roomID = room?.roomId ?? event.getRoomId();
    if (!roomID) {
      return;
    }

    if (event.getType() === EventType.RoomMember) {
      await this.maybeAutoJoinInvite(event, roomID);
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

    this.logger.debug("Matrix timeline event received", {
      eventId: event.getId(),
      eventType: event.getType(),
      roomId: roomID,
      sender: event.getSender(),
    });

    const chat = this.requireChat();

    if (event.getType() === EventType.Reaction) {
      this.handleReactionEvent(event, roomID);
      return;
    }

    if (event.isRedaction()) {
      this.handleReactionRedaction(event);
      return;
    }

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
      }, undefined);
    }
  }

  private async maybeAutoJoinInvite(
    event: MatrixEvent,
    roomID: string
  ): Promise<void> {
    if (!this.inviteAutoJoinEnabled || event.getType() !== EventType.RoomMember) {
      return;
    }

    const membership = event.getContent<{ membership?: string }>()?.membership;
    if (membership !== "invite") {
      return;
    }

    const targetUserID = event.getStateKey();
    if (!targetUserID || targetUserID !== this.userID) {
      return;
    }

    const inviter = event.getSender();
    if (!this.shouldAcceptInvite(roomID, inviter)) {
      this.logger.info("Declined Matrix invite due to invite auto-join policy", {
        roomId: roomID,
        inviter,
      });
      return;
    }

    try {
      await this.joinRoomWithRetry(roomID);
      this.logger.info("Accepted Matrix invite", {
        roomId: roomID,
        inviter,
      });
    } catch (error) {
      this.logger.warn("Failed to auto-join Matrix invite", {
        roomId: roomID,
        inviter,
        error,
      });
    }
  }

  private async joinRoomWithRetry(roomID: string, maxAttempts = 3): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.requireClient().joinRoom(roomID);
        return;
      } catch (error) {
        lastError = error;
        if (!this.isRetryableJoinError(error) || attempt === maxAttempts) {
          throw error;
        }

        const retryDelayMs = this.retryDelayMsForJoinError(error);
        this.logger.warn("Matrix invite auto-join rate limited, retrying", {
          roomId: roomID,
          attempt,
          maxAttempts,
          retryDelayMs,
          error,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs)
        );
      }
    }

    throw lastError;
  }

  private shouldAcceptInvite(
    roomID: string,
    inviter: string | null | undefined
  ): boolean {
    if (this.roomAllowlist && !this.roomAllowlist.has(roomID)) {
      return false;
    }

    if (!this.inviteAutoJoinInviterAllowlist) {
      return true;
    }

    if (!inviter) {
      return false;
    }

    return this.inviteAutoJoinInviterAllowlist.has(inviter);
  }

  private isRetryableJoinError(error: unknown): error is MatrixError {
    return (
      error instanceof MatrixError &&
      (error.errcode === "M_LIMIT_EXCEEDED" || error.httpStatus === 429)
    );
  }

  private retryDelayMsForJoinError(error: MatrixError): number {
    const retryAfterMs =
      typeof error.data?.retry_after_ms === "number" && error.data.retry_after_ms >= 0
        ? error.data.retry_after_ms
        : undefined;
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }

    const retryAfterHeader = error.httpHeaders?.get("retry-after");
    const retryAfterSeconds =
      typeof retryAfterHeader === "string"
        ? Number.parseFloat(retryAfterHeader)
        : Number.NaN;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return retryAfterSeconds * 1000;
    }

    return 500;
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

      evictOldestEntries(this.reactionByEventID);
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

  private readRoomMetadata(room: Room, isDM: boolean): MatrixRoomMetadata {
    const canonicalAlias = normalizeOptionalString(
      this.readStateEventString(room, "m.room.canonical_alias", "alias")
    );
    const topic = normalizeOptionalString(
      this.readStateEventString(room, "m.room.topic", "topic")
    );
    const avatarURL = normalizeOptionalString(
      this.readStateEventString(room, "m.room.avatar", "url")
    );
    const encryption = this.readStateEventContent(room, "m.room.encryption");
    const encryptionAlgorithm = readStringValue(encryption?.algorithm);
    const encrypted = this.roomHasEncryptionStateEvent(room) ?? Boolean(encryptionAlgorithm);

    return {
      roomID: room.roomId,
      name: normalizeOptionalString(room.name) ?? canonicalAlias,
      canonicalAlias,
      topic,
      avatarURL,
      encrypted,
      encryptionAlgorithm,
      isDM,
    };
  }

  private readStateEventContent(
    room: Room,
    eventType: string
  ): Record<string, unknown> | undefined {
    const event = this.readRoomStateEvent(room, eventType);
    if (!event) {
      return undefined;
    }
    const content = event.getContent<Record<string, unknown>>();
    return isRecord(content) ? content : undefined;
  }

  private readStateEventString(
    room: Room,
    eventType: string,
    key: string
  ): string | undefined {
    const content = this.readStateEventContent(room, eventType);
    return readStringValue(content?.[key]);
  }

  private readRoomStateEvent(room: Room, eventType: string): MatrixEvent | undefined {
    if (!("currentState" in room) || !room.currentState) {
      return undefined;
    }

    const { currentState } = room;
    if (
      typeof currentState !== "object" ||
      !("getStateEvents" in currentState) ||
      typeof currentState.getStateEvents !== "function"
    ) {
      return undefined;
    }

    return currentState.getStateEvents(eventType, "") ?? undefined;
  }

  private roomHasEncryptionStateEvent(room: Room): boolean | undefined {
    if (
      !("hasEncryptionStateEvent" in room) ||
      typeof room.hasEncryptionStateEvent !== "function"
    ) {
      return undefined;
    }

    return room.hasEncryptionStateEvent();
  }

  private readRoomMember(room: Room | undefined, userId: string): RoomMember | undefined {
    if (!room || !("getMember" in room) || typeof room.getMember !== "function") {
      return undefined;
    }

    return room.getMember(userId) ?? undefined;
  }

  private parseMatrixContent(content: MatrixMessageContent): ParsedMatrixContent {
    const mentionedUserIDs = this.extractMentionedUserIDs(content);
    const mentionsRoom = this.extractRoomMention(content);
    const formattedBody = normalizeOptionalString(content.formatted_body);
    if (formattedBody) {
      const htmlMarkdown = this.parseMatrixHTML(formattedBody);
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

    const body = this.stripReplyFallbackFromBody(
      normalizeOptionalString(content.body) ?? ""
    );
    return {
      text: body,
      markdown: this.markdownForPlainText(body, content.msgtype),
      mentionedUserIDs,
      mentionsRoom,
    };
  }

  private parseMatrixHTML(
    html: string
  ): { markdown: string; mentionedUserIDs: Set<string> } {
    const root = parseHTML(this.stripReplyFallbackFromHTML(html));
    const mentionedUserIDs = new Set<string>();
    const markdown = this.normalizeMarkdownSpacing(
      this.renderHTMLNodesToMarkdown(root.childNodes, mentionedUserIDs)
    );
    return {
      markdown,
      mentionedUserIDs,
    };
  }

  private renderHTMLNodesToMarkdown(
    nodes: HTMLNode[],
    mentionedUserIDs: Set<string>
  ): string {
    return nodes
      .map((node) => this.renderHTMLNodeToMarkdown(node, mentionedUserIDs))
      .join("");
  }

  private renderHTMLNodeToMarkdown(
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
    const children = this.renderHTMLNodesToMarkdown(node.childNodes, mentionedUserIDs);

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
          .map((child) => this.renderListItemToMarkdown(child, mentionedUserIDs, null))
          .filter(Boolean)
          .join("\n")}\n\n`;
      case "ol":
        return `${node.childNodes
          .map((child, index) =>
            this.renderListItemToMarkdown(child, mentionedUserIDs, index + 1)
          )
          .filter(Boolean)
          .join("\n")}\n\n`;
      case "a":
        return this.renderHTMLLinkToMarkdown(node, children, mentionedUserIDs);
      case "img":
        return normalizeOptionalString(node.getAttribute("alt")) ?? "image";
      default:
        return children;
    }
  }

  private renderListItemToMarkdown(
    node: HTMLNode,
    mentionedUserIDs: Set<string>,
    ordinal: number | null
  ): string {
    if (!(node instanceof HTMLElement) || node.tagName.toLowerCase() !== "li") {
      return "";
    }
    const content = this.normalizeMarkdownSpacing(
      this.renderHTMLNodesToMarkdown(node.childNodes, mentionedUserIDs)
    );
    if (!content) {
      return "";
    }
    return `${ordinal === null ? "-" : `${ordinal}.`} ${content}`;
  }

  private renderHTMLLinkToMarkdown(
    node: HTMLElement,
    children: string,
    mentionedUserIDs: Set<string>
  ): string {
    const href = normalizeOptionalString(node.getAttribute("href"));
    const text = children || node.text;
    if (!href) {
      return text;
    }

    const mentionedUserID = this.parseMatrixToUserID(href);
    if (mentionedUserID) {
      mentionedUserIDs.add(mentionedUserID);
      return text || this.matrixMentionDisplayText(mentionedUserID);
    }

    return `[${text || href}](${href})`;
  }

  private parseMatrixToUserID(href: string): string | null {
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

  private extractMentionedUserIDs(content: MatrixMessageContent): Set<string> {
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

  private extractRoomMention(content: MatrixMessageContent): boolean {
    const matrixMentions = content["m.mentions"];
    return isRecord(matrixMentions) && matrixMentions.room === true;
  }

  private stripReplyFallbackFromBody(body: string): string {
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

  private stripReplyFallbackFromHTML(html: string): string {
    const root = parseHTML(html);
    for (const child of [...root.childNodes]) {
      if (child instanceof HTMLElement && child.tagName.toLowerCase() === "mx-reply") {
        child.remove();
      }
    }
    return root.toString();
  }

  private extractAttachments(content: MatrixMessageContent) {
    const url = typeof content.url === "string" ? content.url : undefined;
    if (!url) {
      return [];
    }

    const info = isRecord(content.info) ? content.info : undefined;
    const mimeType = typeof info?.mimetype === "string" ? info.mimetype : undefined;
    const attachment: Attachment = {
      type: this.attachmentTypeForContent(content, mimeType),
      url,
      name: normalizeOptionalString(content.body),
      mimeType,
      size: typeof info?.size === "number" ? info.size : undefined,
      width: typeof info?.w === "number" ? info.w : undefined,
      height: typeof info?.h === "number" ? info.h : undefined,
      fetchData: this.createAttachmentFetcher(url),
    };

    return [attachment];
  }

  private extractEditedContent(raw: MatrixEvent): {
    content?: MatrixMessageContent;
    editedAt?: Date;
  } | undefined {
    const replacement = raw.getServerAggregatedRelation<{
      content?: MatrixRoomMessageContent;
      origin_server_ts?: number;
    }>(RelationType.Replace);
    const replacementContent = isRecord(replacement?.content)
      ? replacement.content
      : undefined;
    const newContent = isRecord(replacementContent?.["m.new_content"])
      ? replacementContent["m.new_content"]
      : undefined;

    if (!newContent) {
      return undefined;
    }

    return {
      content: newContent,
      editedAt:
        typeof replacement?.origin_server_ts === "number"
          ? new Date(replacement.origin_server_ts)
          : undefined,
    };
  }

  private attachmentTypeForContent(
    content: MatrixMessageContent,
    mimeType?: string
  ): Attachment["type"] {
    switch (content.msgtype) {
      case MsgType.Image:
        return "image";
      case MsgType.Video:
        return "video";
      case MsgType.Audio:
        return "audio";
      case MsgType.File:
        return "file";
      default: {
        const mediaType = this.messageTypeForMimeType(mimeType);
        switch (mediaType) {
          case MsgType.Image:
            return "image";
          case MsgType.Video:
            return "video";
          case MsgType.Audio:
            return "audio";
          default:
            return "file";
        }
      }
    }
  }

  private createAttachmentFetcher(url: string): Attachment["fetchData"] | undefined {
    if (typeof fetch !== "function") {
      return undefined;
    }

    return async () => {
      const client = this.requireClient();
      const downloadURL = this.resolveAttachmentDownloadURL(url, client);
      if (!downloadURL) {
        throw new Error(`Unable to resolve Matrix attachment download URL for ${url}`);
      }

      const accessToken =
        typeof client.getAccessToken === "function"
          ? normalizeOptionalString(client.getAccessToken() ?? undefined)
          : undefined;
      const response = await fetch(downloadURL, {
        headers: accessToken
          ? {
              Authorization: `Bearer ${accessToken}`,
            }
          : undefined,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Matrix attachment (${response.status} ${response.statusText})`
        );
      }

      return Buffer.from(await response.arrayBuffer());
    };
  }

  private resolveAttachmentDownloadURL(
    url: string,
    client: MatrixClient
  ): string | undefined {
    if (typeof client.mxcUrlToHttp === "function") {
      const authenticatedURL = normalizeOptionalString(
        client.mxcUrlToHttp(
          url,
          undefined,
          undefined,
          undefined,
          true,
          true,
          true
        ) ?? undefined
      );
      if (authenticatedURL) {
        return authenticatedURL;
      }

      const unauthenticatedURL = normalizeOptionalString(
        client.mxcUrlToHttp(url, undefined, undefined, undefined, true) ?? undefined
      );
      if (unauthenticatedURL) {
        return unauthenticatedURL;
      }
    }

    return url.startsWith("mxc://") ? undefined : url;
  }

  private isEdited(event: MatrixEvent): boolean {
    const relation = event.getRelation();
    return relation?.rel_type === RelationType.Replace;
  }

  private isMentioned(content: MatrixMessageContent, parsed: ParsedMatrixContent): boolean {
    if (parsed.mentionsRoom) {
      return true;
    }
    if (this.userID && parsed.mentionedUserIDs.has(this.userID)) {
      return true;
    }

    const formatted =
      typeof content.formatted_body === "string" ? content.formatted_body : "";

    const hasUserID = this.userID
      ? parsed.text.includes(this.userID) || formatted.includes(this.userID)
      : false;
    const hasMatrixTo = this.userID
      ? formatted.includes(`matrix.to/#/${encodeURIComponent(this.userID)}`)
      : false;

    const usernameMention = this.userName.startsWith("@")
      ? this.userName
      : `@${this.userName}`;

    const hasUserName =
      parsed.text.includes(usernameMention) || formatted.includes(usernameMention);

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

  private extractReplyEventID(message: AdapterPostableMessage): string | undefined {
    if (typeof message !== "object" || message === null || isCardElement(message)) {
      return undefined;
    }

    const replyEventID = (message as { matrixReplyToEventId?: unknown }).matrixReplyToEventId;
    return typeof replyEventID === "string" && replyEventID.length > 0
      ? replyEventID
      : undefined;
  }

  private applyThreadReplyMetadata(
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

  private async performSendRoomMessage(
    roomID: string,
    rootEventID: string | undefined,
    content: MatrixOutboundMessageContent
  ) {
    const client = this.requireClient();
    if (rootEventID) {
      return client.sendEvent(
        roomID,
        rootEventID,
        EventType.RoomMessage,
        content as RoomMessageEventContent
      );
    }

    return client.sendEvent(roomID, EventType.RoomMessage, content);
  }

  private isTooLargeMatrixError(error: unknown): error is MatrixError {
    return (
      error instanceof MatrixError &&
      (error.errcode === "M_TOO_LARGE" || error.httpStatus === 413)
    );
  }

  private splitOversizedTextContent(
    content: MatrixOutboundMessageContent
  ): MatrixTextMessageContent[] {
    if (!this.isSplittableTextContent(content)) {
      return [];
    }

    const body = content.body;
    if (this.utf8ByteLength(body) <= DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES) {
      return [];
    }

    const parts = this.splitTextByUtf8Bytes(body, DEFAULT_OVERSIZED_MESSAGE_CHUNK_BYTES);
    if (parts.length <= 1) {
      return [];
    }

    return parts.map((part) => ({
      body: part,
      msgtype: content.msgtype,
    }));
  }

  private isSplittableTextContent(
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

  private splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
    const normalizedMaxBytes = Math.max(1, Math.floor(maxBytes));
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (this.utf8ByteLength(remaining) <= normalizedMaxBytes) {
        chunks.push(remaining);
        remaining = "";
        break;
      }

      const boundary = this.findSplitBoundary(remaining, normalizedMaxBytes);
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

  private findSplitBoundary(text: string, maxBytes: number): number {
    let low = 1;
    let high = text.length;
    let best = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = text.slice(0, mid);
      if (this.utf8ByteLength(candidate) <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    for (const pattern of [/\n{2,}/gu, /\n/gu, /\s+/gu]) {
      let match: RegExpExecArray | null = null;
      let lastBoundary: number | null = null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index >= best) {
          break;
        }
        lastBoundary = match.index + match[0].length;
      }
      if (lastBoundary && lastBoundary > 0) {
        return lastBoundary;
      }
    }

    return best;
  }

  private utf8ByteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
  }

  private toRoomMessageContent(
    message: AdapterPostableMessage
  ): MatrixTextMessageContent {
    const rendered = this.renderTextMessage(message);
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

  private renderTextMessage(message: AdapterPostableMessage): RenderedMatrixMessage {
    if (typeof message === "string") {
      return this.renderPlainTextMessage(message);
    }

    if (isCardElement(message)) {
      return this.renderPlainTextMessage("[Card message]");
    }

    if (typeof message === "object" && message !== null) {
      if ("raw" in message && typeof message.raw === "string") {
        return this.renderPlainTextMessage(message.raw);
      }
      if ("markdown" in message && typeof message.markdown === "string") {
        return this.renderMarkdownMessage(message.markdown);
      }
      if ("ast" in message) {
        return this.renderMarkdownMessage(stringifyMarkdown(message.ast));
      }
      if ("card" in message) {
        return this.renderPlainTextMessage(message.fallbackText ?? "[Card message]");
      }
    }

    return { body: "" };
  }

  private renderPlainTextMessage(text: string): RenderedMatrixMessage {
    const rendered = this.replaceMentionPlaceholdersInPlainText(text);
    if (rendered.mentionedUserIDs.size === 0) {
      return {
        body: rendered.body,
      };
    }

    return {
      body: rendered.body,
      formattedBody: this.renderMarkdownToMatrixHTML(rendered.markdown),
      mentions: this.buildMentionsContent(rendered.mentionedUserIDs),
    };
  }

  private renderMarkdownMessage(markdown: string): RenderedMatrixMessage {
    const rendered = this.replaceMentionPlaceholdersInMarkdown(markdown);
    return {
      body: markdownToPlainText(rendered.markdown),
      formattedBody: this.renderMarkdownToMatrixHTML(rendered.markdown),
      mentions: this.buildMentionsContent(rendered.mentionedUserIDs),
    };
  }

  private replaceMentionPlaceholdersInPlainText(text: string): {
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

      const mentionText = this.matrixMentionDisplayText(userID);
      body += mentionText;
      markdown += `[${escapeMarkdownLinkText(mentionText)}](${this.matrixToUserLink(userID)})`;
      mentionedUserIDs.add(userID);
      lastIndex = index + token.length;
    }

    const trailing = text.slice(lastIndex);
    body += trailing;
    markdown += escapeMarkdownText(trailing);

    return { body, markdown, mentionedUserIDs };
  }

  private replaceMentionPlaceholdersInMarkdown(markdown: string): {
    markdown: string;
    mentionedUserIDs: Set<string>;
  } {
    const mentionedUserIDs = new Set<string>();
    const transformed = markdown.replace(
      /<@(@[^>\s]+:[^>\s]+)>/gu,
      (_match, userID: string) => {
        mentionedUserIDs.add(userID);
        return `[${escapeMarkdownLinkText(this.matrixMentionDisplayText(userID))}](${this.matrixToUserLink(
          userID
        )})`;
      }
    );

    return {
      markdown: transformed,
      mentionedUserIDs,
    };
  }

  private renderMarkdownToMatrixHTML(markdown: string): string {
    return marked.parse(markdown, {
      async: false,
      breaks: true,
      gfm: true,
    });
  }

  private buildMentionsContent(
    mentionedUserIDs: Set<string>
  ): { room?: boolean; user_ids?: string[] } | undefined {
    if (mentionedUserIDs.size === 0) {
      return undefined;
    }

    return {
      user_ids: [...mentionedUserIDs],
    };
  }

  private matrixToUserLink(userID: string): string {
    return `https://matrix.to/#/${encodeURIComponent(userID)}`;
  }

  private matrixMentionDisplayText(userID: string): string {
    return `@${matrixLocalpart(userID)}`;
  }

  private markdownForPlainText(text: string, msgtype?: string): string {
    const escaped = escapeMarkdownText(text);
    if (msgtype === "m.emote" && escaped.length > 0) {
      return `*${escaped}*`;
    }
    return escaped;
  }

  private normalizeMarkdownSpacing(markdown: string): string {
    return markdown.replace(/\n{3,}/gu, "\n\n").trim();
  }

  private mergeTextAndLinks(
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

  private collectLinkOnlyAttachmentLines(attachments: Attachment[]): string[] {
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

  private async collectUploads(
    message: AdapterPostableMessage,
    attachments: Attachment[]
  ): Promise<OutboundUpload[]> {
    const uploads: OutboundUpload[] = [];
    const files = this.extractFilesFromMessage(message);
    for (const file of files) {
      uploads.push({
        data: this.normalizeUploadData(file.data),
        fileName: file.filename,
        info: {
          mimetype: normalizeOptionalString(file.mimeType),
          size: this.binarySize(file.data),
        },
        msgtype: this.messageTypeForMimeType(normalizeOptionalString(file.mimeType)),
      });
    }

    for (const attachment of attachments) {
      const data = await this.readAttachmentData(attachment);
      if (!data) {
        continue;
      }
      const fileName =
        normalizeOptionalString(attachment.name) ??
        this.defaultAttachmentName(attachment);
      uploads.push({
        data: this.normalizeUploadData(data),
        fileName,
        info: {
          h: attachment.height,
          mimetype: normalizeOptionalString(attachment.mimeType),
          size: attachment.size ?? this.binarySize(data),
          w: attachment.width,
        },
        msgtype: this.messageTypeForAttachment(attachment),
        type: attachment.type,
      });
    }

    return uploads;
  }

  private extractFilesFromMessage(message: AdapterPostableMessage): FileUpload[] {
    if (typeof message !== "object" || message === null) {
      return [];
    }
    if (!("files" in message) || !Array.isArray(message.files)) {
      return [];
    }
    return message.files.flatMap((file): FileUpload[] => {
      const normalized = this.normalizeFileUpload(file);
      return normalized ? [normalized] : [];
    });
  }

  private normalizeFileUpload(file: unknown): FileUpload | null {
    if (!isRecord(file)) {
      return null;
    }

    const filename = normalizeOptionalString(
      typeof file.filename === "string" ? file.filename : undefined
    );
    if (!filename) {
      return null;
    }

    const data = this.normalizeFileUploadData(file.data);
    if (!data) {
      this.logger.warn("Skipping invalid Matrix file upload", { filename });
      return null;
    }

    return {
      filename,
      data,
      mimeType:
        typeof file.mimeType === "string" ? normalizeOptionalString(file.mimeType) : undefined,
    };
  }

  private normalizeFileUploadData(data: unknown): Buffer | Blob | ArrayBuffer | null {
    if (Buffer.isBuffer(data) || data instanceof Blob || data instanceof ArrayBuffer) {
      return data;
    }

    if (data instanceof Uint8Array) {
      return Buffer.from(data);
    }

    return null;
  }

  private extractAttachmentsFromMessage(message: AdapterPostableMessage): Attachment[] {
    if (typeof message !== "object" || message === null) {
      return [];
    }
    if (!("attachments" in message) || !Array.isArray(message.attachments)) {
      return [];
    }
    return message.attachments.filter((a): a is Attachment => isRecord(a));
  }

  private async readAttachmentData(
    attachment: Attachment
  ): Promise<Buffer | Blob | ArrayBuffer | null> {
    if (typeof attachment.fetchData === "function") {
      return attachment.fetchData();
    }
    return attachment.data ?? null;
  }

  private normalizeUploadData(data: Buffer | Blob | ArrayBuffer): Blob {
    if (data instanceof Blob) {
      return data;
    }
    if (this.isNodeBuffer(data)) {
      return new Blob([new Uint8Array(data)]);
    }
    return new Blob([data]);
  }

  private binarySize(data: Buffer | Blob | ArrayBuffer): number {
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    if (this.isNodeBuffer(data)) {
      return data.length;
    }
    return data.size;
  }

  private isNodeBuffer(value: unknown): value is Buffer {
    return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
  }

  private messageTypeForAttachment(attachment: Attachment): MatrixMediaMsgType {
    switch (attachment.type) {
      case "image":
        return MsgType.Image;
      case "video":
        return MsgType.Video;
      case "audio":
        return MsgType.Audio;
      default:
        return this.messageTypeForMimeType(normalizeOptionalString(attachment.mimeType));
    }
  }

  private messageTypeForMimeType(mimeType?: string): MatrixMediaMsgType {
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

  private defaultAttachmentName(attachment: Attachment): string {
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

  private mustGetEventByID(roomID: string, eventID: string): MatrixEvent {
    const room = this.requireRoom(roomID);
    const event = room.findEventById(eventID);
    if (!event) {
      throw new Error(`Sent Matrix event not found in local timeline: ${eventID}`);
    }
    return event;
  }

  private resolveSentEvent(
    roomID: string,
    eventID: string,
    fallback: {
      content: MatrixRoomMessageContent;
      roomID: string;
      sender?: string;
    }
  ): MatrixEvent {
    try {
      return this.mustGetEventByID(roomID, eventID);
    } catch (error) {
      this.logger.warn("Sent Matrix event not found in local timeline; using synthetic fallback", {
        error,
        eventId: eventID,
        roomId: roomID,
      });

      return new MatrixEvent({
        content: fallback.content,
        event_id: eventID,
        origin_server_ts: Date.now(),
        room_id: fallback.roomID,
        sender: fallback.sender ?? "",
        type: EventType.RoomMessage,
      });
    }
  }

  private isUsableDirectRoom(roomID: string): boolean {
    const room = this.requireClient().getRoom(roomID);
    if (!room) {
      return false;
    }

    const membership = room.getMyMembership();
    return membership === "join" || membership === "invite";
  }

  private makeUser(userId: string, roomId?: string) {
    const room = roomId ? this.client?.getRoom(roomId) ?? undefined : undefined;
    const member = this.readRoomMember(room, userId);
    const localpart = matrixLocalpart(userId);
    const displayName =
      readStringValue(member?.rawDisplayName) ??
      readStringValue(member?.name) ??
      localpart;
    const isBot: boolean | "unknown" = userId === this.userID ? true : "unknown";

    return {
      userId,
      userName: localpart,
      fullName: displayName,
      isBot,
      isMe: userId === this.userID,
    };
  }

  private rawEmoji(emoji: EmojiValue | string): string {
    return typeof emoji === "string" ? emoji : emoji.toString();
  }

  private myReactionKey(
    threadId: string,
    messageId: string,
    rawEmoji: string
  ): string {
    return `${threadId}::${messageId}::${rawEmoji}`;
  }

  private get persistenceSessionPrefix(): string {
    return `${this.persistenceConfig.keyPrefix}:session:${encodeURIComponent(this.baseURL)}`;
  }

  private get persistenceStorePrefix(): string {
    return `${this.persistenceConfig.keyPrefix}:store`;
  }

  private get sessionBasePrefix(): string {
    return this.persistenceSessionPrefix;
  }

  private getSessionStorageKey(userID: string): string {
    return `${this.sessionBasePrefix}:user:${encodeURIComponent(userID)}`;
  }

  private getSessionUsernameTemporaryKey(): string | null {
    if (this.auth.type !== "password") {
      return null;
    }
    return `${this.sessionBasePrefix}:username:${encodeURIComponent(this.auth.username)}`;
  }

  private async loadPersistedSession(): Promise<StoredSession | null> {
    if (!this.stateAdapter) {
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

  private async persistSession(auth: ResolvedAuth, existingCreatedAt?: string): Promise<void> {
    if (!this.stateAdapter) {
      return;
    }

    const now = new Date().toISOString();
    const session: StoredSession = {
      accessToken: auth.accessToken,
      authType: this.auth.type,
      baseURL: this.baseURL,
      createdAt: existingCreatedAt ?? now,
      deviceID: auth.deviceID,
      e2eeEnabled: this.e2eeEnabled,
      recoveryKeyPresent: Boolean(this.e2eeConfig?.storagePassword),
      updatedAt: now,
      userID: auth.userID,
      username: this.auth.type === "password" ? this.auth.username : undefined,
    };
    const encodedSession = this.encodeStoredSession(session);
    const sessionKey = this.getSessionStorageKey(auth.userID);

    await this.stateAdapter.set(
      sessionKey,
      encodedSession,
      this.persistenceConfig.session.ttlMs
    );

    const temporaryKey = this.getSessionUsernameTemporaryKey();
    if (temporaryKey && temporaryKey !== sessionKey) {
      await this.stateAdapter.set(
        temporaryKey,
        encodedSession,
        this.persistenceConfig.session.ttlMs
      );
    }
  }

  private encodeStoredSession(session: StoredSession): StoredSession {
    if (!this.persistenceConfig.session.encrypt) {
      return session;
    }

    const encryptedPayload =
      this.persistenceConfig.session.encrypt(JSON.stringify(session));
    const { accessToken, ...metadata } = session;
    return { ...metadata, encryptedPayload };
  }

  private decodeStoredSession(
    session: StoredSession | null
  ): StoredSession | null {
    if (!session || !session.encryptedPayload) {
      return session;
    }

    if (!this.persistenceConfig.session.decrypt) {
      return null;
    }

    try {
      const decryptedJSON =
        this.persistenceConfig.session.decrypt(session.encryptedPayload);
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

    try {
      const privateKey = decodeRecoveryKey(this.recoveryKey) as Uint8Array<ArrayBuffer>;
      return [keyID, privateKey];
    } catch {
      this.logger.warn("Invalid recovery key format, unable to decode");
      return null;
    }
  }

  private validateConfig(config: MatrixAdapterConfig): void {
    if (!config.baseURL?.trim()) {
      throw new Error("baseURL is required.");
    }
    if (config.persistence?.session?.ttlMs !== undefined && config.persistence.session.ttlMs <= 0) {
      throw new Error("persistence.session.ttlMs must be a positive number.");
    }
    if (
      config.persistence?.sync?.persistIntervalMs !== undefined &&
      config.persistence.sync.persistIntervalMs <= 0
    ) {
      throw new Error("persistence.sync.persistIntervalMs must be a positive number.");
    }
    if (
      config.persistence?.sync?.snapshotTtlMs !== undefined &&
      config.persistence.sync.snapshotTtlMs <= 0
    ) {
      throw new Error("persistence.sync.snapshotTtlMs must be a positive number.");
    }
    if (
      (config.persistence?.session?.encrypt && !config.persistence?.session?.decrypt) ||
      (!config.persistence?.session?.encrypt && config.persistence?.session?.decrypt)
    ) {
      throw new Error(
        "persistence.session.encrypt and persistence.session.decrypt must be provided together."
      );
    }
  }

  private async resolveDeviceID(...candidates: Array<string | undefined>): Promise<string> {
    const configuredDeviceID = normalizeOptionalString(this.deviceID);
    if (configuredDeviceID) {
      this.deviceID = configuredDeviceID;
      return configuredDeviceID;
    }

    for (const candidate of candidates) {
      const normalized = normalizeOptionalString(candidate);
      if (normalized) {
        this.deviceID = normalized;
        await this.persistDeviceID(normalized);
        return normalized;
      }
    }

    const persisted = await this.loadPersistedDeviceID();
    if (persisted) {
      this.deviceID = persisted;
      return persisted;
    }

    const generated = generateDeviceID();
    this.deviceID = generated;
    await this.persistDeviceID(generated);
    return generated;
  }

  private getDeviceIDStorageKey(identityHint?: string): string {
    const basePrefix =
      `${this.persistenceConfig.keyPrefix}:device:${encodeURIComponent(this.baseURL)}`;
    const hint =
      identityHint ??
      this.auth.userID ??
      (this.auth.type === "password" ? `username:${this.auth.username}` : "default");
    return `${basePrefix}:${encodeURIComponent(hint)}`;
  }

  private async loadPersistedDeviceID(): Promise<string | null> {
    if (!this.stateAdapter) {
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
      const normalized = normalizeOptionalString(value);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private async persistDeviceID(deviceID: string, identityHint?: string): Promise<void> {
    if (!this.stateAdapter) {
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
    if (this.stateAdapter && temporaryKey !== canonicalKey) {
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
  const inviteAutoJoinInviterAllowlist = parseEnvList(
    process.env.MATRIX_INVITE_AUTOJOIN_ALLOWLIST
  );
  const inviteAutoJoinEnabled = envBool(
    process.env.MATRIX_INVITE_AUTOJOIN,
    inviteAutoJoinInviterAllowlist.length > 0
  );

  const auth = resolveAuthFromEnv();

  return new MatrixAdapter({
    baseURL,
    auth,
    userName: process.env.MATRIX_BOT_USERNAME ?? "bot",
    deviceID: normalizeOptionalString(process.env.MATRIX_DEVICE_ID),
    commandPrefix: process.env.MATRIX_COMMAND_PREFIX,
    recoveryKey,
    inviteAutoJoin: inviteAutoJoinEnabled
      ? {
          inviterAllowlist: inviteAutoJoinInviterAllowlist,
        }
      : undefined,
    matrixSDKLogLevel:
      parseSDKLogLevel(process.env.MATRIX_SDK_LOG_LEVEL) ?? "error",
  });
}

export type {
  MatrixAdapterConfig,
  MatrixCreateStoreOptions,
  MatrixPersistenceConfig,
  MatrixPersistenceSyncConfig,
  MatrixThreadID,
} from "./types";

function normalizePersistenceConfig(
  config?: MatrixPersistenceConfig
): ResolvedPersistenceConfig {
  return {
    keyPrefix:
      normalizeOptionalString(config?.keyPrefix) ?? DEFAULT_PERSISTENCE_KEY_PREFIX,
    session: {
      decrypt: config?.session?.decrypt,
      encrypt: config?.session?.encrypt,
      ttlMs: config?.session?.ttlMs,
    },
    sync: {
      persistIntervalMs:
        config?.sync?.persistIntervalMs ??
        DEFAULT_MATRIX_STORE_PERSIST_INTERVAL_MS,
      snapshotTtlMs: config?.sync?.snapshotTtlMs,
    },
  };
}

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

function parseEnvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function matrixLocalpart(userID: string): string {
  return userID.startsWith("@") ? userID.slice(1).split(":")[0] ?? userID : userID;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/gu, "\\$1");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\\]])/gu, "\\$1");
}

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return values
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value));
}

function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== "undefined" && globalThis.indexedDB !== null;
}

function isSDKLogLevel(value: string): value is SDKLogLevel {
  return value in MATRIX_SDK_LOG_LEVELS;
}

function parseSDKLogLevel(value: string | undefined): SDKLogLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isSDKLogLevel(normalized) ? normalized : undefined;
}

function evictOldestEntries(
  collection: { size: number; keys(): Iterable<string>; delete(key: string): unknown },
  maxSize = 10_000,
  targetSize = 5_000
): void {
  if (collection.size <= maxSize) return;
  const toDelete = collection.size - targetSize;
  let deleted = 0;
  // Map and Set iteration is insertion ordered, so keys() yields the oldest
  // entries first for the collections used by this adapter.
  for (const key of collection.keys()) {
    if (deleted >= toDelete) break;
    collection.delete(key);
    deleted++;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
