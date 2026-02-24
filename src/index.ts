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
  type MatrixClient,
  type MatrixEvent,
  type Room,
  ClientEvent,
  EventType,
  MsgType,
  RelationType,
  RoomEvent,
} from "matrix-js-sdk";
import type {
  MatrixAuthBootstrapClient,
  MatrixAccessTokenAuthConfig,
  MatrixAdapterConfig,
  MatrixAuthConfig,
  MatrixThreadID,
} from "./types";

const MATRIX_PREFIX = "matrix";
const MATRIX_SESSION_PREFIX = "matrix:session";
const DEFAULT_COMMAND_PREFIX = "/";
const TYPING_TIMEOUT_MS = 30_000;

type MatrixMessageContent = {
  body?: string;
  format?: string;
  formatted_body?: string;
  msgtype?: string;
  [key: string]: unknown;
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
  private readonly sessionConfig: Required<
    Pick<NonNullable<MatrixAdapterConfig["session"]>, "enabled">
  > &
    Pick<
      NonNullable<MatrixAdapterConfig["session"]>,
      "decrypt" | "encrypt" | "key" | "ttlMs"
    >;

  private readonly logger: Logger;
  private chat: ChatInstance | null = null;
  private stateAdapter: StateAdapter | null = null;
  private client: MatrixClient | null = null;
  private started = false;
  private userID: string;
  private deviceID?: string;
  private botUserID?: string;
  private readonly reactionByEventID = new Map<string, StoredReaction>();
  private readonly myReactionByKey = new Map<string, string>();
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
    this.deviceID = config.deviceID;
    this.userName = config.userName ?? "bot";
    this.commandPrefix = config.commandPrefix ?? DEFAULT_COMMAND_PREFIX;
    this.roomAllowlist = config.roomAllowlist
      ? new Set(config.roomAllowlist)
      : undefined;
    this.syncOptions = config.sync;
    this.createClientFn = config.createClient;
    this.createBootstrapClientFn = config.createBootstrapClient;
    this.e2eeConfig = {
      ...config.e2ee,
      enabled: config.e2ee?.enabled ?? Boolean(config.recoveryKey),
      storagePassword:
        config.e2ee?.storagePassword ?? config.recoveryKey,
    };
    this.sessionConfig = {
      decrypt: config.session?.decrypt,
      enabled: config.session?.enabled ?? true,
      encrypt: config.session?.encrypt,
      key: config.session?.key,
      ttlMs: config.session?.ttlMs,
    };
    this.logger = config.logger ?? new ConsoleLogger("info").child("matrix");
  }

  async initialize(chat: ChatInstance): Promise<void> {
    if (this.started) {
      return;
    }

    this.chat = chat;
    this.stateAdapter = chat.getState();

    if (this.createClientFn) {
      this.client = this.createClientFn();
    } else {
      const resolvedAuth = await this.resolveAuth();
      this.userID = resolvedAuth.userID;
      this.botUserID = resolvedAuth.userID;
      this.deviceID = resolvedAuth.deviceID ?? this.deviceID;
      this.client = this.buildClient(resolvedAuth);
    }

    this.client.on(ClientEvent.Sync, (state: string) => {
      this.logger.debug("Matrix sync state", { state });
    });

    this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      void this.onTimelineEvent(event, room, Boolean(toStartOfTimeline));
    });

    await this.maybeInitE2EE();
    await this.client.startClient(this.syncOptions);
    this.started = true;

    this.logger.info("Matrix adapter initialized", {
      userID: this.userID,
      baseURL: this.baseURL,
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
    const roomID = raw.getRoomId();
    if (!roomID) {
      throw new Error("Matrix event missing room ID");
    }

    const threadID = this.threadIDForEvent(raw, roomID);
    const content = raw.getContent<MatrixMessageContent>();
    const text = this.extractText(content);
    const sender = raw.getSender() ?? "unknown";

    return new Message<MatrixEvent>({
      id: raw.getId() ?? `${roomID}:${raw.getTs()}`,
      threadId: threadID,
      text,
      formatted: parseMarkdown(text),
      author: {
        userId: sender,
        userName: sender,
        fullName: sender,
        isBot: sender === this.userID,
        isMe: sender === this.userID,
      },
      metadata: {
        dateSent: new Date(raw.getTs()),
        edited: this.isEdited(raw),
      },
      attachments: this.extractAttachments(content),
      raw,
      isMention: this.isMentioned(content, text),
    });
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

    const response = await this.sendRoomMessage(roomID, rootEventID, {
      "m.new_content": {
        msgtype: baseContent.msgtype,
        body: baseContent.body,
      },
      "m.relates_to": {
        rel_type: RelationType.Replace,
        event_id: messageId,
      },
      msgtype: baseContent.msgtype,
      body: `* ${baseContent.body}`,
    });

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

  async fetchMessages(
    threadId: string,
    options: FetchOptions = {}
  ): Promise<FetchResult<MatrixEvent>> {
    const { roomID, rootEventID } = this.decodeThreadId(threadId);
    const room = this.requireRoom(roomID);

    const messageEvents = room.timeline.filter((event) =>
      this.isMessageEvent(event, roomID, rootEventID)
    );

    const direction = options.direction ?? "backward";
    const limit = options.limit ?? 50;

    if (direction === "forward") {
      const startIndex = options.cursor
        ? messageEvents.findIndex((e) => e.getId() === options.cursor) + 1
        : 0;

      const slice = messageEvents.slice(startIndex, startIndex + limit);
      const last = slice.at(-1)?.getId();
      const hasMore = startIndex + limit < messageEvents.length;

      return {
        messages: slice.map((event) => this.parseMessage(event)),
        nextCursor: hasMore ? last : undefined,
      };
    }

    const endIndex = options.cursor
      ? messageEvents.findIndex((e) => e.getId() === options.cursor)
      : messageEvents.length;

    const boundedEnd = endIndex >= 0 ? endIndex : messageEvents.length;
    const start = Math.max(0, boundedEnd - limit);
    const slice = messageEvents.slice(start, boundedEnd);

    return {
      messages: slice.map((event) => this.parseMessage(event)),
      nextCursor: start > 0 ? messageEvents[start - 1]?.getId() : undefined,
    };
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
    const room = this.requireRoom(roomID);

    const threadMap = new Map<
      string,
      {
        root?: MatrixEvent;
        replyCount: number;
        lastTS?: number;
      }
    >();

    for (const event of room.timeline) {
      if (event.getType() !== EventType.RoomMessage) {
        continue;
      }

      const rootID = event.threadRootId;
      if (!rootID) {
        continue;
      }

      const entry = threadMap.get(rootID) ?? { replyCount: 0 };

      if (event.getId() === rootID) {
        entry.root = event;
      } else {
        entry.replyCount += 1;
      }

      entry.lastTS = Math.max(entry.lastTS ?? 0, event.getTs());
      threadMap.set(rootID, entry);
    }

    const summaries: ThreadSummary<MatrixEvent>[] = [];
    for (const [rootID, entry] of threadMap.entries()) {
      if (!entry.root) {
        continue;
      }

      summaries.push({
        id: this.encodeThreadId({ roomID, rootEventID: rootID }),
        rootMessage: this.parseMessage(entry.root),
        replyCount: entry.replyCount,
        lastReplyAt: entry.lastTS ? new Date(entry.lastTS) : undefined,
      });
    }

    summaries.sort(
      (a, b) =>
        (b.lastReplyAt?.getTime() ?? 0) - (a.lastReplyAt?.getTime() ?? 0)
    );

    const limit = options.limit ?? 50;

    return {
      threads: summaries.slice(0, limit),
      nextCursor: summaries.length > limit ? String(limit) : undefined,
    };
  }

  private async resolveAuth(): Promise<ResolvedAuth> {
    if (this.auth.type === "accessToken") {
      const userID = this.auth.userID ?? (await this.lookupUserIDFromAccessToken(this.auth.accessToken));
      const resolved: ResolvedAuth = {
        accessToken: this.auth.accessToken,
        userID,
        deviceID: this.deviceID,
      };
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
        await this.persistSession(resolved);
        this.logger.info("Reused persisted Matrix session", {
          userID: resolved.userID,
        });
        return resolved;
      } catch (error) {
        this.logger.warn("Persisted Matrix session is invalid. Falling back to password login.", {
          error: String(error),
        });
      }
    }

    const bootstrapClient = this.createBootstrapClient();
    const loginResponse = await bootstrapClient.loginWithPassword(
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
      deviceID: this.deviceID ?? loginResponse.device_id ?? undefined,
    };
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
    return sdk.createClient({
      baseUrl: this.baseURL,
      accessToken: auth.accessToken,
      userId: auth.userID,
      deviceId: auth.deviceID,
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

    return sdk.createClient({
      baseUrl: this.baseURL,
      accessToken: args?.accessToken,
      deviceId: args?.deviceID,
    }) as MatrixAuthBootstrapClient;
  }

  private sendRoomMessage(
    roomID: string,
    rootEventID: string | undefined,
    content: unknown
  ) {
    const client = this.requireClient();
    if (rootEventID) {
      return client.sendEvent(
        roomID,
        rootEventID,
        EventType.RoomMessage,
        content as never
      );
    }

    return client.sendEvent(roomID, EventType.RoomMessage, content as never);
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

    await this.requireClient().initRustCrypto({
      useIndexedDB: this.e2eeConfig.useIndexedDB,
      cryptoDatabasePrefix: this.e2eeConfig.cryptoDatabasePrefix,
      storagePassword: this.e2eeConfig.storagePassword,
      storageKey: this.e2eeConfig.storageKey,
    });

    this.logger.info("Matrix E2EE initialized", {
      useIndexedDB: this.e2eeConfig.useIndexedDB !== false,
      cryptoDatabasePrefix: this.e2eeConfig.cryptoDatabasePrefix,
    });
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
        eventID: event.getId(),
        error: String(error),
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
    if (!room || toStartOfTimeline) {
      return;
    }

    const roomID = room.roomId;
    if (this.roomAllowlist && !this.roomAllowlist.has(roomID)) {
      return;
    }

    if (this.userID && event.getSender() === this.userID) {
      return;
    }

    await this.tryDecryptEvent(event);

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

    chat.processMessage(this, threadID, message);

    const slash = this.parseSlashCommand(message.text);
    if (slash) {
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

    const threadID = this.encodeThreadId({ roomID });
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
      user: {
        userId: sender,
        userName: sender,
        fullName: sender,
        isBot: sender === this.userID,
        isMe: sender === this.userID,
      },
      raw: event,
    });
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
      user: {
        userId: reaction.userID,
        userName: reaction.userID,
        fullName: reaction.userID,
        isBot: reaction.userID === this.userID,
        isMe: reaction.userID === this.userID,
      },
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

    return [
      {
        type: "file" as const,
        url,
        mimeType:
          typeof content.info === "object" &&
          content.info !== null &&
          typeof (content.info as { mimetype?: unknown }).mimetype === "string"
            ? (content.info as { mimetype: string }).mimetype
            : undefined,
      },
    ];
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
  ): { body: string; msgtype: MsgType } {
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

  private myReactionKey(
    threadId: string,
    messageId: string,
    rawEmoji: string
  ): string {
    return `${threadId}::${messageId}::${rawEmoji}`;
  }

  private getSessionStorageKeys(userID?: string): string[] {
    if (this.sessionConfig.key) {
      return [this.sessionConfig.key];
    }

    const basePrefix = `${MATRIX_SESSION_PREFIX}:${encodeURIComponent(this.baseURL)}`;
    const keys = new Set<string>();

    if (userID) {
      keys.add(`${basePrefix}:user:${encodeURIComponent(userID)}`);
    }

    if (this.auth.type === "password") {
      keys.add(`${basePrefix}:username:${encodeURIComponent(this.auth.username)}`);
    }

    return Array.from(keys);
  }

  private async loadPersistedSession(): Promise<StoredSession | null> {
    if (!this.sessionConfig.enabled || !this.stateAdapter) {
      return null;
    }

    const keys = this.getSessionStorageKeys(this.auth.userID);
    for (const key of keys) {
      const raw = await this.stateAdapter.get<StoredSession>(key);
      const session = this.decodeStoredSession(raw);
      if (this.isValidStoredSession(session)) {
        return session;
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

    const keys = this.getSessionStorageKeys(auth.userID);
    await Promise.all(
      keys.map((key) =>
        this.stateAdapter!.set(key, encodedSession, this.sessionConfig.ttlMs)
      )
    );
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
      const parsed = JSON.parse(decryptedJSON) as StoredSession;
      return parsed;
    } catch (error) {
      this.logger.warn("Failed to decrypt persisted Matrix session", {
        error: String(error),
      });
      return null;
    }
  }

  private isValidStoredSession(value: unknown): value is StoredSession {
    if (!value || typeof value !== "object") {
      return false;
    }

    const session = value as Partial<StoredSession>;
    return (
      typeof session.accessToken === "string" &&
      typeof session.userID === "string" &&
      typeof session.baseURL === "string" &&
      session.baseURL === this.baseURL
    );
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
}

export function createMatrixAdapter(config: MatrixAdapterConfig): MatrixAdapter;
export function createMatrixAdapter(): MatrixAdapter;
export function createMatrixAdapter(config?: MatrixAdapterConfig): MatrixAdapter {
  if (config) {
    return new MatrixAdapter({
      ...config,
      deviceID: config.deviceID ?? generateDeviceID(),
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
    deviceID: process.env.MATRIX_DEVICE_ID ?? generateDeviceID(),
    commandPrefix: process.env.MATRIX_COMMAND_PREFIX,
    recoveryKey,
    e2ee: {
      enabled: e2eeEnabled,
      useIndexedDB: envBool(process.env.MATRIX_E2EE_USE_INDEXEDDB, true),
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

function generateDeviceID(length = 10): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";

  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out;
}
