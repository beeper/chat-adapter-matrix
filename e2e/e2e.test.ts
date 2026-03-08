import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringifyMarkdown, type Message } from "chat";
import { EventType, RoomEvent, RoomMemberEvent, type MatrixEvent } from "matrix-js-sdk";
import {
  createIsolatedRoom,
  createParticipant,
  createParticipantFromSession,
  env,
  type E2EParticipant,
  getOrCreateRoom,
  nonce,
  shutdownParticipant,
  sleep,
  waitForEvent,
  waitForEncryptedRoom,
  waitForFetchedMessage,
  waitForJoinedMemberCount,
  waitForMatchingMessage,
  waitForRoom,
} from "./helpers";

const hasCoreCredentials = Boolean(
  process.env.E2E_BASE_URL &&
    process.env.E2E_BOT_LOGIN_TOKEN &&
    process.env.E2E_SENDER_LOGIN_TOKEN
);

const hasRecoveryCredentials = Boolean(
  process.env.E2E_BOT_RECOVERY_KEY && process.env.E2E_SENDER_RECOVERY_KEY
);

describe.skipIf(!hasCoreCredentials)("E2E Matrix Adapter", () => {
  let bot: E2EParticipant;
  let sender: E2EParticipant;
  let roomID: string;

  beforeAll(async () => {
    [bot, sender] = await Promise.all([
      createParticipant({
        name: "e2e-bot",
        loginToken: env.botLoginToken,
        recoveryKey: env.botRecoveryKey,
      }),
      createParticipant({
        name: "e2e-sender",
        loginToken: env.senderLoginToken,
        recoveryKey: env.senderRecoveryKey,
      }),
    ]);

    roomID = await getOrCreateRoom(bot.matrixClient, sender.userID);
    await Promise.all([
      waitForEncryptedRoom(bot.matrixClient, roomID, 30_000),
      waitForEncryptedRoom(sender.matrixClient, roomID, 30_000),
      waitForJoinedMemberCount(bot.matrixClient, roomID, 2, 30_000),
      waitForJoinedMemberCount(sender.matrixClient, roomID, 2, 30_000),
    ]);

    const sharedThreadId = bot.adapter.encodeThreadId({ roomID });
    const botWarmupTag = `e2e-warmup-bot-${nonce()}`;
    const botWarmup = await bot.adapter.postMessage(sharedThreadId, botWarmupTag);
    await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      botWarmup.id,
      (message) => message.text.includes(botWarmupTag),
      45_000
    );

    const senderWarmupTag = `e2e-warmup-sender-${nonce()}`;
    const senderWarmup = await sender.adapter.postMessage(
      sender.adapter.encodeThreadId({ roomID }),
      senderWarmupTag
    );
    await waitForFetchedMessage(
      bot.adapter,
      sharedThreadId,
      senderWarmup.id,
      (message) => message.text.includes(senderWarmupTag),
      45_000
    );

    await sleep(1_000);
  });

  afterAll(async () => {
    const shutdowns = [bot ? shutdownParticipant(bot) : undefined, sender ? shutdownParticipant(sender) : undefined].filter(
      (value): value is Promise<void> => Boolean(value)
    );
    await Promise.all(shutdowns);
  });

  it("bot receives text message from sender", async () => {
    const tag = `e2e-text-${nonce()}`;
    const threadId = sender.adapter.encodeThreadId({ roomID });
    const posted = await sender.adapter.postMessage(threadId, `hello ${tag}`);
    const message = await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID }),
      posted.id,
      (candidate) => candidate.text.includes(tag)
    );

    expect(message.text).toContain(tag);
    expect(message.author.userId).toBe(sender.userID);
    expect(message.raw.isEncrypted()).toBe(true);
    expect(message.raw.getWireType()).toBe(EventType.RoomMessageEncrypted);
    expect(message.raw.getRoomId()).toBe(roomID);
  });

  it("bot posts a message visible to sender", async () => {
    const tag = `e2e-post-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const posted = await bot.adapter.postMessage(threadId, `bot says ${tag}`);
    const message = await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      posted.id,
      (candidate) => candidate.text.includes(tag)
    );
    expect(message.text).toContain(tag);
    expect(message.author.userId).toBe(bot.userID);
  });

  it("preserves rich text and mention semantics across encrypted delivery", async () => {
    const tag = `e2e-format-${nonce()}`;
    const localpart = bot.userID.slice(1).split(":")[0];
    const threadId = sender.adapter.encodeThreadId({ roomID });
    const posted = await sender.adapter.postMessage(threadId, {
      markdown: `Hello **${tag}** <@${bot.userID}>`,
    });
    const message = await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID }),
      posted.id,
      (candidate) => candidate.text.includes(tag) && candidate.isMention === true,
      45_000
    );

    expect(message.text).toContain(`Hello ${tag} @${localpart}`);
    expect(message.isMention).toBe(true);
    expect(stringifyMarkdown(message.formatted).trim()).toContain(`**${tag}**`);
    expect(stringifyMarkdown(message.formatted)).toContain(`@${localpart}`);
  });

  it("thread round-trip: sender creates thread, bot replies in it", async () => {
    const rootTag = `e2e-thread-root-${nonce()}`;
    const replyTag = `e2e-thread-reply-${nonce()}`;
    const threadId = sender.adapter.encodeThreadId({ roomID });

    // Sender sends root message
    const rootPosted = await sender.adapter.postMessage(
      threadId,
      `Thread root ${rootTag}`
    );
    const rootEventId = rootPosted.id;
    await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID }),
      rootEventId,
      (message) => message.text.includes(rootTag)
    );

    // Sender sends a threaded reply
    const threadReplyTag = `e2e-thread-child-${nonce()}`;
    const senderThreadId = sender.adapter.encodeThreadId({
      roomID,
      rootEventID: rootEventId,
    });
    await sender.adapter.postMessage(
      senderThreadId,
      `Thread reply ${threadReplyTag}`
    );

    const childThreadID = bot.adapter.encodeThreadId({
      roomID,
      rootEventID: rootEventId,
    });
    await waitForMatchingMessage(
      bot.adapter,
      childThreadID,
      (message) => message.text.includes(threadReplyTag)
    );
    const decoded = bot.adapter.decodeThreadId(childThreadID);
    expect(decoded.roomID).toBe(roomID);
    expect(decoded.rootEventID).toBe(rootEventId);

    // Bot replies in the same thread
    const replyPosted = await bot.adapter.postMessage(
      childThreadID,
      `Bot thread reply ${replyTag}`
    );
    const replyMessage = await waitForFetchedMessage(
      sender.adapter,
      senderThreadId,
      replyPosted.id,
      (message) => message.text.includes(replyTag)
    );
    expect(replyMessage.text).toContain(replyTag);
  });

  it("reaction round-trip", async () => {
    const tag = `e2e-react-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });

    // Bot sends a message for both sides to react to
    const posted = await bot.adapter.postMessage(threadId, `React target ${tag}`);
    const messageId = posted.id;

    await sleep(500);

    // Bot adds reaction — sender should see it
    const senderSeesReaction = waitForEvent<{ rawEmoji: string; added: boolean }>(
      (cb) => {
        sender.onReaction((data) => {
          if (data.messageId === messageId && data.added) {
            cb({ rawEmoji: data.rawEmoji, added: data.added });
          }
        });
        return () => sender.onReaction(null);
      }
    );

    await bot.adapter.addReaction(threadId, messageId, "👍");

    const senderReaction = await senderSeesReaction;
    expect(senderReaction.rawEmoji).toBe("👍");
    expect(senderReaction.added).toBe(true);

    // Sender adds reaction — bot should receive via onReaction
    const botSeesReaction = waitForEvent<{ rawEmoji: string; added: boolean }>(
      (cb) => {
        bot.onReaction((data) => {
          if (data.messageId === messageId && data.added) {
            cb({ rawEmoji: data.rawEmoji, added: data.added });
          }
        });
        return () => bot.onReaction(null);
      }
    );

    const senderThreadId = sender.adapter.encodeThreadId({ roomID });
    await sender.adapter.addReaction(senderThreadId, messageId, "🎉");

    const botReaction = await botSeesReaction;
    expect(botReaction.rawEmoji).toBe("🎉");
    expect(botReaction.added).toBe(true);
  });

  it("reaction removal round-trip", async () => {
    const tag = `e2e-unreact-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const posted = await bot.adapter.postMessage(
      threadId,
      `Reaction remove target ${tag}`
    );
    const messageId = posted.id;

    const senderSawAdd = waitForEvent<{ rawEmoji: string; added: boolean }>((cb) => {
      sender.onReaction((data) => {
        if (data.messageId === messageId && data.rawEmoji === "🔥" && data.added) {
          cb({ rawEmoji: data.rawEmoji, added: data.added });
        }
      });
      return () => sender.onReaction(null);
    });

    await bot.adapter.addReaction(threadId, messageId, "🔥");
    await senderSawAdd;

    const senderSawRemoval = waitForEvent<{ rawEmoji: string; added: boolean }>((cb) => {
      sender.onReaction((data) => {
        if (data.messageId === messageId && data.rawEmoji === "🔥" && !data.added) {
          cb({ rawEmoji: data.rawEmoji, added: data.added });
        }
      });
      return () => sender.onReaction(null);
    });

    await bot.adapter.removeReaction(threadId, messageId, "🔥");

    const removal = await senderSawRemoval;
    expect(removal.rawEmoji).toBe("🔥");
    expect(removal.added).toBe(false);
  });

  it("edit round-trip: bot sends and edits, sender sees edited content", async () => {
    const tag = `e2e-edit-${nonce()}`;
    const editedTag = `e2e-edited-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    // Bot sends original
    const posted = await bot.adapter.postMessage(threadId, `Original ${tag}`);
    const messageId = posted.id;
    await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      messageId,
      (message) => message.text.includes(tag)
    );

    // Bot edits the message
    await bot.adapter.editMessage(threadId, messageId, {
      markdown: `Edited **${editedTag}**`,
    });
    const editedMessage = await waitForMatchingMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      (message) =>
        message.id === messageId &&
        message.text.includes(editedTag) &&
        !message.text.includes(tag),
      45_000
    );

    expect(editedMessage.text).toContain(editedTag);
    expect(editedMessage.text).not.toContain(tag);
    expect(stringifyMarkdown(editedMessage.formatted).trim()).toContain(
      `**${editedTag}**`
    );

    const fetched = await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      messageId,
      (message) =>
        message.text.includes(editedTag) &&
        !message.text.includes(tag),
      45_000
    );
    expect(fetched.text).toContain(editedTag);
    expect(fetched.text).not.toContain(tag);
    expect(stringifyMarkdown(fetched.formatted).trim()).toContain(`**${editedTag}**`);
  });

  it("strips Matrix reply fallback from fetched reply messages", async () => {
    const rootTag = `e2e-reply-root-${nonce()}`;
    const replyTag = `e2e-reply-visible-${nonce()}`;
    const threadId = sender.adapter.encodeThreadId({ roomID });
    const rootPosted = await sender.adapter.postMessage(threadId, `Reply root ${rootTag}`);
    await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID }),
      rootPosted.id,
      (message) => message.text.includes(rootTag)
    );

    const replyResponse = await sender.matrixClient.sendEvent(roomID, EventType.RoomMessage, {
      msgtype: "m.text",
      body: `> <${bot.userID}> Reply root ${rootTag}\n> quoted\n\nVisible ${replyTag}`,
      format: "org.matrix.custom.html",
      formatted_body:
        `<mx-reply><blockquote><a href="https://matrix.to/#/${encodeURIComponent(roomID)}/${encodeURIComponent(rootPosted.id)}">In reply to</a>` +
        ` <a href="https://matrix.to/#/${encodeURIComponent(bot.userID)}">${bot.userID}</a><br>Reply root ${rootTag}</blockquote></mx-reply>` +
        `<p>Visible ${replyTag}</p>`,
      "m.relates_to": {
        "m.in_reply_to": {
          event_id: rootPosted.id,
        },
      },
    });

    const replyMessage = await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID }),
      replyResponse.event_id,
      (message) => message.text.includes(replyTag),
      45_000
    );

    expect(replyMessage.text).toBe(`Visible ${replyTag}`);
    expect(stringifyMarkdown(replyMessage.formatted).trim()).toBe(`Visible ${replyTag}`);
  });

  it("fetchMessages pagination", async () => {
    const tag = `e2e-page-${nonce()}`;
    const paginationRoomID = await createIsolatedRoom(
      bot.matrixClient,
      sender.matrixClient,
      sender.userID,
      `pagination-${tag}`,
      45_000
    );
    const threadId = bot.adapter.encodeThreadId({ roomID: paginationRoomID });
    const count = 5;

    // Sender sends N messages
    const senderThreadId = sender.adapter.encodeThreadId({ roomID: paginationRoomID });
    for (let i = 0; i < count; i++) {
      await sender.adapter.postMessage(senderThreadId, `${tag} msg-${i}`);
      await sleep(200);
    }

    // Let sync propagate
    await sleep(2_000);

    // Fetch with a small page size
    const page1 = await bot.adapter.fetchMessages(threadId, {
      direction: "backward",
      limit: 3,
    });

    expect(page1.messages.length).toBeGreaterThanOrEqual(1);
    expect(page1.messages.length).toBeLessThanOrEqual(3);

    // If there's a next cursor, fetch more
    if (page1.nextCursor) {
      const page2 = await bot.adapter.fetchMessages(threadId, {
        direction: "backward",
        limit: 3,
        cursor: page1.nextCursor,
      });

      expect(page2.messages.length).toBeGreaterThanOrEqual(1);

      // No overlap between pages
      const page1Ids = new Set(page1.messages.map((m) => m.id));
      for (const m of page2.messages) {
        expect(page1Ids.has(m.id)).toBe(false);
      }
    }
  });

  it("restarts on the same session and catches up paginated room history", async () => {
    const offlineCount = 6;
    const restartTag = `e2e-restart-${nonce()}`;
    const restartRoomID = await createIsolatedRoom(
      bot.matrixClient,
      sender.matrixClient,
      sender.userID,
      `restart-${restartTag}`,
      45_000
    );
    const roomThreadId = sender.adapter.encodeThreadId({ roomID: restartRoomID });
    const botSession = bot.session;
    const botState = bot.state;

    const baseline = await sender.adapter.postMessage(
      roomThreadId,
      `Restart baseline ${restartTag}`
    );
    await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID: restartRoomID }),
      baseline.id,
      (message) => message.text.includes(restartTag)
    );

    await shutdownParticipant(bot);

    const offlinePosts = [];
    for (let index = 0; index < offlineCount; index += 1) {
      offlinePosts.push(
        await sender.adapter.postMessage(
          roomThreadId,
          `Restart offline ${restartTag}-${index.toString().padStart(2, "0")}`
        )
      );
    }

    bot = await createParticipantFromSession({
      name: "e2e-bot-restarted",
      recoveryKey: env.botRecoveryKey,
      session: botSession,
      state: botState,
    });

    await Promise.all([
      waitForEncryptedRoom(bot.matrixClient, restartRoomID, 45_000),
      waitForJoinedMemberCount(bot.matrixClient, restartRoomID, 2, 45_000),
    ]);

    const latestOffline = offlinePosts[offlinePosts.length - 1];
    const caughtUpMessage = await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID: restartRoomID }),
      latestOffline.id,
      (message) => message.text.includes(restartTag),
      60_000
    );
    expect(caughtUpMessage.text).toContain(restartTag);

    const liveTag = `Restart live ${restartTag}`;
    const botSawLiveMessage = waitForEvent<Message<MatrixEvent>>((cb) => {
      bot.onMessage((incomingThreadId, message) => {
        if (
          incomingThreadId === bot.adapter.encodeThreadId({ roomID: restartRoomID }) &&
          message.text.includes(liveTag)
        ) {
          cb(message);
        }
      });
      return () => bot.onMessage(null);
    }, 45_000);

    const livePosted = await sender.adapter.postMessage(roomThreadId, liveTag);
    const liveMessage = await botSawLiveMessage;
    expect(liveMessage.id).toBe(livePosted.id);
    expect(liveMessage.text).toContain(liveTag);

    const fetchedIds = new Set<string>();
    const offlinePostIds = new Set(offlinePosts.map((post) => post.id));
    let cursor: string | undefined;

    while (true) {
      const page = await bot.adapter.fetchMessages(
        bot.adapter.encodeThreadId({ roomID: restartRoomID }),
        {
          direction: "backward",
          limit: 5,
          cursor,
        }
      );
      for (const message of page.messages) {
        fetchedIds.add(message.id);
      }

      if ([...offlinePostIds].every((id) => fetchedIds.has(id))) {
        break;
      }

      cursor = page.nextCursor;
      if (!cursor) {
        break;
      }
    }

    expect(fetchedIds.has(livePosted.id)).toBe(true);
    expect(offlinePosts.every((post) => fetchedIds.has(post.id))).toBe(true);
  });

  it("fetches a single message and sees deletion via redaction", async () => {
    const tag = `e2e-delete-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const posted = await bot.adapter.postMessage(threadId, `Delete target ${tag}`);

    const initial = await sender.adapter.fetchMessage(threadId, posted.id);
    expect(initial).toBeTruthy();
    const initialMessage = await waitForFetchedMessage(
      sender.adapter,
      threadId,
      posted.id,
      (message) => message.text.includes(tag)
    );
    expect(initialMessage.text).toContain(tag);

    const senderRoom = await waitForRoom(sender.matrixClient, roomID);
    const sawRedaction = waitForEvent<MatrixEvent>((cb) => {
      const handler = (event: MatrixEvent, room: unknown) => {
        if (room !== senderRoom) {
          return;
        }
        if (event.getAssociatedId() === posted.id) {
          cb(event);
        }
      };

      senderRoom.on(RoomEvent.Redaction, handler);
      return () => senderRoom.off(RoomEvent.Redaction, handler);
    });

    await bot.adapter.deleteMessage(threadId, posted.id);
    await sawRedaction;

    const deleted = await sender.adapter.fetchMessage(threadId, posted.id);
    expect(deleted).toBeNull();
  });

  it("creates a DM, reuses it, and posts through postChannelMessage", async () => {
    const dmThreadId = await bot.adapter.openDM(sender.userID);
    const dmThreadIdAgain = await bot.adapter.openDM(sender.userID);
    expect(dmThreadIdAgain).toBe(dmThreadId);

    const decoded = bot.adapter.decodeThreadId(dmThreadId);
    await waitForRoom(bot.matrixClient, decoded.roomID);
    await waitForRoom(sender.matrixClient, decoded.roomID);
    await waitForJoinedMemberCount(bot.matrixClient, decoded.roomID, 2, 30_000);
    await waitForJoinedMemberCount(sender.matrixClient, decoded.roomID, 2, 30_000);

    const dmChannelId = bot.adapter.channelIdFromThreadId(dmThreadId);
    const channelInfo = await bot.adapter.fetchChannelInfo(dmChannelId);
    expect(channelInfo.id).toBe(dmChannelId);
    expect(channelInfo.isDM).toBe(true);
    expect(channelInfo.metadata?.roomID).toBe(decoded.roomID);
    expect((channelInfo.memberCount ?? 0) >= 2).toBe(true);

    const tag = `e2e-dm-${nonce()}`;
    const posted = await bot.adapter.postChannelMessage(dmChannelId, `DM hello ${tag}`);
    const message = await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID: decoded.roomID }),
      posted.id,
      (candidate) => candidate.text.includes(tag)
    );
    expect(message.author.userId).toBe(bot.userID);
    expect(message.text).toContain(tag);
  });

  it("fetches channel info, channel messages, thread info, and thread lists", async () => {
    const rootTag = `e2e-thread-list-root-${nonce()}`;
    const replyTag = `e2e-thread-list-reply-${nonce()}`;
    const threadListRoomID = await createIsolatedRoom(
      bot.matrixClient,
      sender.matrixClient,
      sender.userID,
      `thread-list-${rootTag}`,
      45_000
    );
    const channelId = bot.adapter.channelIdFromThreadId(
      bot.adapter.encodeThreadId({ roomID: threadListRoomID })
    );

    const roomInfo = await bot.adapter.fetchChannelInfo(channelId);
    expect(roomInfo.id).toBe(channelId);
    expect(roomInfo.isDM).toBe(false);
    expect((roomInfo.memberCount ?? 0) >= 2).toBe(true);
    expect(roomInfo.metadata?.roomID).toBe(threadListRoomID);

    const rootPosted = await sender.adapter.postMessage(
      sender.adapter.encodeThreadId({ roomID: threadListRoomID }),
      `Thread root ${rootTag}`
    );

    const threadId = sender.adapter.encodeThreadId({
      roomID: threadListRoomID,
      rootEventID: rootPosted.id,
    });
    await sender.adapter.postMessage(threadId, `Thread reply ${replyTag}`);

    await waitForFetchedMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID: threadListRoomID }),
      rootPosted.id,
      (message) => message.text.includes(rootTag)
    );
    await waitForMatchingMessage(
      bot.adapter,
      bot.adapter.encodeThreadId({ roomID: threadListRoomID, rootEventID: rootPosted.id }),
      (message) => message.text.includes(replyTag)
    );

    const channelMessages = await bot.adapter.fetchChannelMessages(channelId, {
      direction: "backward",
      limit: 20,
    });
    expect(channelMessages.messages.some((message) => message.id === rootPosted.id)).toBe(true);
    expect(
      channelMessages.messages.some((message) => message.text.includes(replyTag))
    ).toBe(false);

    const threadInfo = await bot.adapter.fetchThread(threadId);
    expect(threadInfo.id).toBe(threadId);
    expect(threadInfo.channelId).toBe(channelId);
    expect(threadInfo.isDM).toBe(false);
    expect(threadInfo.metadata?.roomID).toBe(threadListRoomID);

    const threads = await bot.adapter.listThreads(channelId, { limit: 20 });
    const summary = threads.threads.find((thread) => thread.id === threadId);
    expect(summary).toBeTruthy();
    expect(summary?.rootMessage.id).toBe(rootPosted.id);
    expect(summary?.rootMessage.text).toContain(rootTag);
    expect((summary?.replyCount ?? 0) >= 1).toBe(true);
  });

  it("includes live room metadata in channel and thread info", async () => {
    const topic = `Adapter metadata ${nonce()}`;
    await bot.matrixClient.sendStateEvent(
      roomID,
      EventType.RoomTopic,
      { topic },
      ""
    );
    await sleep(1_000);

    const channelId = bot.adapter.channelIdFromThreadId(bot.adapter.encodeThreadId({ roomID }));
    const rootPosted = await bot.adapter.postMessage(
      bot.adapter.encodeThreadId({ roomID }),
      `Metadata root ${nonce()}`
    );
    const threadId = bot.adapter.encodeThreadId({
      roomID,
      rootEventID: rootPosted.id,
    });

    const [channelInfo, threadInfo] = await Promise.all([
      bot.adapter.fetchChannelInfo(channelId),
      bot.adapter.fetchThread(threadId),
    ]);

    expect(channelInfo.metadata?.roomID).toBe(roomID);
    expect(channelInfo.metadata?.topic).toBe(topic);
    expect(channelInfo.metadata?.encrypted).toBe(true);
    expect(threadInfo.metadata?.roomID).toBe(roomID);
    expect(threadInfo.metadata?.topic).toBe(topic);
    expect(threadInfo.metadata?.encrypted).toBe(true);
  });

  it("uploads a file attachment and fetches it back", async () => {
    const tag = `e2e-file-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const expectedContents = `attachment payload ${tag}`;
    const posted = await bot.adapter.postMessage(threadId, {
      files: [
        {
          filename: `${tag}.txt`,
          mimeType: "text/plain",
          data: Buffer.from(expectedContents, "utf8"),
        },
      ],
    });

    const attachmentMessage = await waitForMatchingMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      (message) =>
          message.id === posted.id &&
        message.author.userId === bot.userID &&
        message.attachments.some((attachment) => attachment.name === `${tag}.txt`),
      45_000
    );
    expect(attachmentMessage.attachments).toHaveLength(1);
    expect(attachmentMessage.attachments[0]?.url.startsWith("mxc://")).toBe(true);
    expect(attachmentMessage.raw.isEncrypted()).toBe(true);

    const liveAttachment = attachmentMessage.attachments[0];
    expect(typeof liveAttachment?.fetchData).toBe("function");
    const liveAttachmentData = await liveAttachment?.fetchData?.();
    expect(liveAttachmentData?.toString("utf8")).toBe(expectedContents);

    const fetched = await sender.adapter.fetchMessage(threadId, attachmentMessage.id);
    expect(fetched).toBeTruthy();
    expect(fetched?.attachments).toHaveLength(1);
    expect(fetched?.attachments[0]?.url.startsWith("mxc://")).toBe(true);
    expect(fetched?.raw.isEncrypted()).toBe(true);

    const fetchedAttachment = fetched?.attachments[0];
    expect(typeof fetchedAttachment?.fetchData).toBe("function");
    const fetchedAttachmentData = await fetchedAttachment?.fetchData?.();
    expect(fetchedAttachmentData?.toString("utf8")).toBe(expectedContents);
  });

  it.skipIf(!hasRecoveryCredentials)(
    "restores historical encrypted messages on a fresh device using recovery key",
    async () => {
    await shutdownParticipant(sender);

    const tag = `e2e-recovery-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const posted = await bot.adapter.postMessage(threadId, `Historical ${tag}`);

    const restoredSender = await createParticipant({
      name: "e2e-sender-restored",
      loginToken: env.senderLoginToken,
      recoveryKey: env.senderRecoveryKey,
    });
    sender = restoredSender;

    await Promise.all([
      waitForEncryptedRoom(sender.matrixClient, roomID, 45_000),
      waitForJoinedMemberCount(sender.matrixClient, roomID, 2, 45_000),
    ]);

    const restoredMessage = await waitForFetchedMessage(
      sender.adapter,
      sender.adapter.encodeThreadId({ roomID }),
      posted.id,
      (message) => message.text.includes(tag),
      60_000
    );

    expect(restoredMessage.text).toContain(tag);
    expect(restoredMessage.author.userId).toBe(bot.userID);
    expect(restoredMessage.raw.isEncrypted()).toBe(true);
    }
  );

  it("emits typing notifications", async () => {
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const senderRoom = await waitForRoom(sender.matrixClient, roomID);
    const botMember = senderRoom.getMember(bot.userID);
    expect(botMember).toBeTruthy();

    const senderSawTyping = waitForEvent<void>((cb) => {
      const member = senderRoom.getMember(bot.userID);
      if (!member) {
        throw new Error(`Missing room member ${bot.userID}`);
      }

      const handler = (_event: MatrixEvent, updatedMember: typeof member) => {
        if (updatedMember.userId === bot.userID && updatedMember.typing) {
          cb();
        }
      };

      member.on(RoomMemberEvent.Typing, handler);
      return () => member.off(RoomMemberEvent.Typing, handler);
    }, 20_000);

    await bot.adapter.startTyping(threadId);
    await senderSawTyping;
  });
});
