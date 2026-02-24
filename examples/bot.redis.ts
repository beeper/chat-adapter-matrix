import { Chat, ConsoleLogger } from "chat";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMatrixAdapter } from "../src/index";

const redisURL = process.env.REDIS_URL;
if (!redisURL) {
  throw new Error("Set REDIS_URL for the Redis-backed example.");
}

const logger = new ConsoleLogger(
  (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ??
    "info"
);

const matrix = createMatrixAdapter();

const bot = new Chat({
  userName: process.env.BOT_USER_NAME ?? "beeper-bot",
  logger,
  state: createRedisState({ url: redisURL }),
  adapters: {
    matrix,
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}. Redis-backed state is active.`);
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});

await bot.initialize();
console.log("Matrix adapter bot (Redis state) started via sync.");

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
