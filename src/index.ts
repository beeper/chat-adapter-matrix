import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
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
  Message,
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
} from "matrix-js-sdk/lib/@types/events";
import type { MediaEventContent } from "matrix-js-sdk/lib/@types/media";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { logger as matrixSDKLogger } from "matrix-js-sdk/lib/logger";
import {
  DEFAULT_COMMAND_PREFIX,
  FAST_SYNC_DEFAULTS,
  type ResolvedPersistenceConfig,
  type SDKLogLevel,
  createMatrixAdapterConfigFromEnv,
  normalizePersistenceConfig,
  validateConfig,
} from "./config";
import {
  channelIdFromThreadId,
  decodeCursorV1,
  decodeThreadId,
  encodeCursorV1,
  encodeThreadId,
  toSDKDirection,
  type CursorDirection,
  type CursorKind,
  type CursorV1Payload,
} from "./history/cursor";
import {
  isMentioned,
  parseMatrixContent,
  type MatrixMessageContent,
  type ParsedMatrixContent,
} from "./messages/inbound";
import {
  applyThreadReplyMetadata,
  binarySize,
  collectLinkOnlyAttachmentLines,
  defaultAttachmentName,
  extractAttachmentsFromMessage,
  extractFilesFromMessage,
  extractReplyEventID,
  isTooLargeMatrixError,
  mergeTextAndLinks,
  messageTypeForAttachment,
  messageTypeForMimeType,
  normalizeFileUpload,
  normalizeUploadData,
  readAttachmentData,
  splitOversizedTextContent,
  toRoomMessageContent,
  type MatrixMediaMsgType,
  type MatrixOutboundMessageContent,
  type MatrixRoomMessageContent,
  type MatrixTextMessageContent,
  type OutboundUpload,
} from "./messages/outbound";
import {
  evictOldestEntries,
  generateDeviceID,
  hasIndexedDB,
  isRecord,
  matrixLocalpart,
  normalizeOptionalString,
  normalizeStringList,
  readStringValue,
} from "./shared/utils";
import { ChatStateMatrixStore } from "./store/chat-state-matrix-store";
import type {
  MatrixAuthBootstrapClient,
  MatrixAdapterConfig,
  MatrixAuthConfig,
  MatrixCreateStoreOptions,
  MatrixThreadID,
} from "./types";

const TYPING_TIMEOUT_MS = 30_000;
const MATRIX_SDK_LOG_LEVELS: Record<SDKLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};
let matrixSDKLogConfigured = false;

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

type DirectAccountData = Record<string, string[]>;

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

type SentRoomMessage = {
  response: Awaited<ReturnType<MatrixClient["sendEvent"]>>;
  sentContent: MatrixOutboundMessageContent;
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
    validateConfig(config);
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
    return encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): MatrixThreadID {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
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
    const replyEventID = extractReplyEventID(message);
    const contents = await this.toRoomMessageContents(message);
    const [firstContent, ...extraContents] = contents;
    if (!firstContent) {
      throw new Error("Cannot post an empty Matrix message.");
    }
    const { response, sentContent } = await this.sendRoomMessage(
      roomID,
      rootEventID,
      replyEventID,
      firstContent,
    );
    for (const content of extraContents) {
      await this.sendRoomMessage(roomID, rootEventID, null, content);
    }

    return {
      id: response.event_id,
      threadId,
      raw: this.resolveSentEvent(roomID, response.event_id, {
        content: sentContent,
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
    const baseContent = toRoomMessageContent(message);
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

    const { response, sentContent } = await this.sendRoomMessage(
      roomID,
      rootEventID,
      null,
      editContent
    );

    return {
      id: response.event_id,
      threadId,
      raw: this.resolveSentEvent(roomID, response.event_id, {
        content: sentContent,
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
      ? decodeCursorV1(
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
          ? encodeCursorV1({
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
        ? encodeCursorV1({
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
    const room = this.requireRoom(roomID);
    const limit = options.limit ?? 50;
    const cursor = options.cursor
      ? decodeCursorV1(options.cursor, "thread_list", roomID, undefined, "backward")
      : null;
    const listResponse = await this.requireClient().createThreadListMessagesRequest(
      roomID,
      cursor?.token ?? null,
      limit,
      Direction.Backward,
      ThreadFilterType.All
    );
    const events = await this.mapRawEvents(listResponse.chunk ?? [], roomID);
    room.processThreadRoots(events, true);
    const summaries: ThreadSummary<MatrixEvent>[] = [];

    for (const rootEvent of events) {
      const rootID = rootEvent.getId();
      if (!rootID || rootEvent.getType() !== EventType.RoomMessage) {
        continue;
      }

      const localRootEvent = room.findEventById(rootID);
      const summaryRootEvent = localRootEvent ?? rootEvent;
      const bundled =
        summaryRootEvent.getServerAggregatedRelation<IThreadBundledRelationship>(
          THREAD_RELATION_TYPE.name
        ) ??
        rootEvent.getServerAggregatedRelation<IThreadBundledRelationship>(
          THREAD_RELATION_TYPE.name
        );
      const roomThread = room.getThread(rootID);
      const latestReply = roomThread?.replyToEvent;
      let latestTS = latestReply?.getTs() ?? bundled?.latest_event?.origin_server_ts;
      let replyCount = Math.max(roomThread?.length ?? 0, bundled?.count ?? 0);

      if (replyCount === 0 && typeof latestTS !== "number") {
        const fallback = await this.fetchLatestThreadReplySummary(roomID, rootID);
        replyCount = Math.max(replyCount, fallback.replyCount);
        latestTS = latestTS ?? fallback.latestReplyTS;
      }

      const threadID = this.encodeThreadId({ roomID, rootEventID: rootID });

      summaries.push({
        id: threadID,
        rootMessage: this.parseMessageInternal(summaryRootEvent, threadID),
        replyCount,
        lastReplyAt: typeof latestTS === "number" ? new Date(latestTS) : undefined,
      });
    }

    return {
      threads: summaries,
      nextCursor: listResponse.end
        ? encodeCursorV1({
            kind: "thread_list",
            dir: "backward",
            token: listResponse.end,
            roomID,
          })
        : undefined,
    };
  }

  private async fetchLatestThreadReplySummary(
    roomID: string,
    rootEventID: string
  ): Promise<{ replyCount: number; latestReplyTS?: number }> {
    const response = await this.fetchThreadMessagesPage({
      roomID,
      rootEventID,
      includeRoot: false,
      limit: 1,
      direction: "backward",
      fromToken: null,
    });
    const latestReply = response.events.at(-1);

    return latestReply
      ? {
          replyCount: 1,
          latestReplyTS: latestReply.getTs(),
        }
      : { replyCount: 0 };
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
    const parsed = parseMatrixContent(effectiveContent);
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
      isMention: isMentioned({
        content: effectiveContent,
        parsed,
        userID: this.userID,
        userName: this.userName,
      }),
    });
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
      toSDKDirection(args.direction)
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
        dir: toSDKDirection(args.direction),
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

    const userID = this.auth.userID ?? loginResponse.user_id;
    if (!userID) {
      throw new Error("Password login succeeded but no user ID was returned.");
    }

    let authDeviceID = normalizeOptionalString(loginResponse.device_id);
    if (!authDeviceID) {
      const whoami = await this.lookupWhoAmIFromAccessToken(loginResponse.access_token);
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
    replyEventID: string | null | undefined,
    content: MatrixOutboundMessageContent
  ): Promise<SentRoomMessage> {
    const threadContent = applyThreadReplyMetadata(content, rootEventID, replyEventID);

    try {
      const response = await this.performSendRoomMessage(roomID, rootEventID, threadContent);
      void this.maybePersistSecretsBundle();
      return {
        response,
        sentContent: threadContent,
      };
    } catch (error) {
      if (isTooLargeMatrixError(error)) {
        const splitContents = splitOversizedTextContent(threadContent);
        if (splitContents.length > 0) {
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

          let firstSentMessage: SentRoomMessage | undefined;
          for (const splitContent of splitContents) {
            const chunkWithMeta = applyThreadReplyMetadata(
              splitContent,
              rootEventID,
              replyEventID
            );
            const response = await this.performSendRoomMessage(roomID, rootEventID, chunkWithMeta);
            void this.maybePersistSecretsBundle();
            firstSentMessage ??= {
              response,
              sentContent: chunkWithMeta,
            };
          }

          if (firstSentMessage) {
            return firstSentMessage;
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
    const textContent = toRoomMessageContent(message);
    const attachments = extractAttachmentsFromMessage(message);
    const uploads = await this.collectUploads(message, attachments);
    const linkLines = collectLinkOnlyAttachmentLines(attachments);
    const textBody = mergeTextAndLinks(textContent, linkLines);
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
    if (!force && Date.now() - this.lastSecretsBundlePersistAt < 60_000) {
      return;
    }

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
      if (this.processedTimelineEventIDs.size > 10_000) {
        evictOldestEntries(this.processedTimelineEventIDs);
      }
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
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.requireClient().joinRoom(roomID);
        return;
      } catch (error) {
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

      if (this.reactionByEventID.size > 10_000) {
        evictOldestEntries(this.reactionByEventID);
      }
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
        const mediaType = messageTypeForMimeType(mimeType);
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

  private async collectUploads(
    message: AdapterPostableMessage,
    attachments: Attachment[]
  ): Promise<OutboundUpload[]> {
    const uploads: OutboundUpload[] = [];
    const files = extractFilesFromMessage(message, this.logger);
    for (const file of files) {
      uploads.push({
        data: normalizeUploadData(file.data),
        fileName: file.filename,
        info: {
          mimetype: normalizeOptionalString(file.mimeType),
          size: binarySize(file.data),
        },
        msgtype: messageTypeForMimeType(normalizeOptionalString(file.mimeType)),
      });
    }

    const attachmentUploads = await Promise.all(
      attachments.map(async (attachment): Promise<OutboundUpload | null> => {
        const data = await readAttachmentData(attachment);
        if (!data) {
          return null;
        }
        const fileName =
          normalizeOptionalString(attachment.name) ??
          defaultAttachmentName(attachment);
        return {
          data: normalizeUploadData(data),
          fileName,
          info: {
            h: attachment.height,
            mimetype: normalizeOptionalString(attachment.mimeType),
            size: attachment.size ?? binarySize(data),
            w: attachment.width,
          },
          msgtype: messageTypeForAttachment(attachment),
          type: attachment.type,
        };
      })
    );
    for (const upload of attachmentUploads) {
      if (upload) {
        uploads.push(upload);
      }
    }

    return uploads;
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
      content: MatrixOutboundMessageContent;
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

  private getSessionStorageKey(userID: string): string {
    return `${this.persistenceSessionPrefix}:user:${encodeURIComponent(userID)}`;
  }

  private getSessionUsernameTemporaryKey(): string | null {
    if (this.auth.type !== "password") {
      return null;
    }
    return `${this.persistenceSessionPrefix}:username:${encodeURIComponent(this.auth.username)}`;
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
      matrixSDKLogConfigured = true;
    }
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

  return new MatrixAdapter(createMatrixAdapterConfigFromEnv());
}

export type {
  MatrixAdapterConfig,
  MatrixCreateStoreOptions,
  MatrixPersistenceConfig,
  MatrixPersistenceSyncConfig,
  MatrixThreadID,
} from "./types";
