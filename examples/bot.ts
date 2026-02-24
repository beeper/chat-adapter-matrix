import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "../src/index";

const matrix = createMatrixAdapter();

const bot = new Chat({
  userName: process.env.BOT_USER_NAME ?? "beeper-bot",
  state: createMemoryState(),
  adapters: {
    matrix,
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(
    `Hi ${message.author.userName}. Mention me or run /ping in this thread.`
  );
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.isMention) {
    await thread.post("I am here.");
  }
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});

await bot.initialize();
console.log("Matrix adapter bot started via sync.");

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await matrix.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await matrix.shutdown();
  process.exit(0);
});
