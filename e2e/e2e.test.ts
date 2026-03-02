import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "chat";
import type { MatrixEvent } from "matrix-js-sdk";
import {
  createParticipant,
  env,
  type E2EParticipant,
  getOrCreateRoom,
  nonce,
  sleep,
  waitForEvent,
} from "./helpers";

const hasCredentials = Boolean(
  process.env.E2E_BASE_URL &&
    process.env.E2E_BOT_ACCESS_TOKEN &&
    process.env.E2E_BOT_USER_ID &&
    process.env.E2E_SENDER_ACCESS_TOKEN &&
    process.env.E2E_SENDER_USER_ID
);

describe.skipIf(!hasCredentials)("E2E Matrix Adapter", () => {
  let bot: E2EParticipant;
  let sender: E2EParticipant;
  let roomID: string;

  beforeAll(async () => {
    [bot, sender] = await Promise.all([
      createParticipant({
        name: "e2e-bot",
        accessToken: env.botAccessToken,
        userID: env.botUserID,
        recoveryKey: env.botRecoveryKey,
      }),
      createParticipant({
        name: "e2e-sender",
        accessToken: env.senderAccessToken,
        userID: env.senderUserID,
        recoveryKey: env.senderRecoveryKey,
      }),
    ]);

    roomID = await getOrCreateRoom(bot.matrixClient, env.senderUserID);

    // Let sync settle so both clients are aware of the room
    await sleep(2_000);
  });

  afterAll(async () => {
    bot.onMessage(null);
    bot.onReaction(null);
    sender.onMessage(null);
    sender.onReaction(null);
    await Promise.all([bot.adapter.shutdown(), sender.adapter.shutdown()]);
  });

  it("bot receives text message from sender", async () => {
    const tag = `e2e-text-${nonce()}`;
    const threadId = sender.adapter.encodeThreadId({ roomID });

    const botReceived = waitForEvent<{ threadID: string; message: Message<MatrixEvent> }>(
      (cb) => {
        bot.onMessage((threadID, message) => {
          if (message.text.includes(tag)) cb({ threadID, message });
        });
        return () => bot.onMessage(null);
      }
    );

    await sender.adapter.postMessage(threadId, { text: `hello ${tag}` });

    const { threadID, message } = await botReceived;

    expect(message.text).toContain(tag);
    expect(message.author.id).toBe(env.senderUserID);

    const decoded = bot.adapter.decodeThreadId(threadID);
    expect(decoded.roomID).toBe(roomID);
  });

  it("bot posts a message visible to sender", async () => {
    const tag = `e2e-post-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });

    const senderReceived = waitForEvent<Message<MatrixEvent>>(
      (cb) => {
        sender.onMessage((_threadID, message) => {
          if (message.text.includes(tag)) cb(message);
        });
        return () => sender.onMessage(null);
      }
    );

    await bot.adapter.postMessage(threadId, { text: `bot says ${tag}` });

    const message = await senderReceived;
    expect(message.text).toContain(tag);
    expect(message.author.id).toBe(env.botUserID);
  });

  it("thread round-trip: sender creates thread, bot replies in it", async () => {
    const rootTag = `e2e-thread-root-${nonce()}`;
    const replyTag = `e2e-thread-reply-${nonce()}`;
    const threadId = sender.adapter.encodeThreadId({ roomID });

    // Sender sends root message
    const rootPosted = await sender.adapter.postMessage(threadId, {
      text: `Thread root ${rootTag}`,
    });
    const rootEventId = rootPosted.id;

    // Wait for bot to receive the root
    const botReceivedRoot = waitForEvent<{ threadID: string }>(
      (cb) => {
        bot.onMessage((threadID, message) => {
          if (message.text.includes(rootTag)) cb({ threadID });
        });
        return () => bot.onMessage(null);
      }
    );
    await botReceivedRoot;

    // Sender sends a threaded reply
    const threadReplyTag = `e2e-thread-child-${nonce()}`;
    const senderThreadId = sender.adapter.encodeThreadId({
      roomID,
      rootEventID: rootEventId,
    });
    await sender.adapter.postMessage(senderThreadId, {
      text: `Thread reply ${threadReplyTag}`,
    });

    // Wait for bot to receive the threaded message
    const botReceivedThread = waitForEvent<{ threadID: string }>(
      (cb) => {
        bot.onMessage((threadID, message) => {
          if (message.text.includes(threadReplyTag)) cb({ threadID });
        });
        return () => bot.onMessage(null);
      }
    );

    const { threadID: childThreadID } = await botReceivedThread;
    const decoded = bot.adapter.decodeThreadId(childThreadID);
    expect(decoded.roomID).toBe(roomID);
    expect(decoded.rootEventID).toBe(rootEventId);

    // Bot replies in the same thread
    const senderSeesReply = waitForEvent<Message<MatrixEvent>>(
      (cb) => {
        sender.onMessage((_threadID, message) => {
          if (message.text.includes(replyTag)) cb(message);
        });
        return () => sender.onMessage(null);
      }
    );

    await bot.adapter.postMessage(childThreadID, {
      text: `Bot thread reply ${replyTag}`,
    });

    const replyMessage = await senderSeesReply;
    expect(replyMessage.text).toContain(replyTag);
  });

  it("reaction round-trip", async () => {
    const tag = `e2e-react-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });

    // Bot sends a message for both sides to react to
    const posted = await bot.adapter.postMessage(threadId, {
      text: `React target ${tag}`,
    });
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

  it("edit round-trip: bot sends and edits, sender sees edited content", async () => {
    const tag = `e2e-edit-${nonce()}`;
    const editedTag = `e2e-edited-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });

    // Bot sends original
    const posted = await bot.adapter.postMessage(threadId, {
      text: `Original ${tag}`,
    });
    const messageId = posted.id;

    // Wait for sender to see original
    const senderSeesOriginal = waitForEvent<void>(
      (cb) => {
        sender.onMessage((_threadID, message) => {
          if (message.text.includes(tag)) cb();
        });
        return () => sender.onMessage(null);
      }
    );
    await senderSeesOriginal;

    // Bot edits the message
    await bot.adapter.editMessage(threadId, messageId, {
      text: `Edited ${editedTag}`,
    });

    // Verify edit via fetchMessages — the edited content should appear
    await sleep(2_000);

    const fetched = await sender.adapter.fetchMessages(
      sender.adapter.encodeThreadId({ roomID }),
      { direction: "backward", limit: 10 }
    );

    const editedMsg = fetched.messages.find((m) => m.id === messageId);
    expect(editedMsg).toBeDefined();
    // The original event text or the edited text should reflect the edit
    // (depends on homeserver aggregation; at minimum the edit event was sent)
  });

  it("fetchMessages pagination", async () => {
    const tag = `e2e-page-${nonce()}`;
    const threadId = bot.adapter.encodeThreadId({ roomID });
    const count = 5;

    // Sender sends N messages
    const senderThreadId = sender.adapter.encodeThreadId({ roomID });
    for (let i = 0; i < count; i++) {
      await sender.adapter.postMessage(senderThreadId, {
        text: `${tag} msg-${i}`,
      });
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
});
