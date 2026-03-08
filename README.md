# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs). It runs over Matrix sync instead of webhooks and works with Beeper conversations and bridged networks such as WhatsApp, Telegram, Instagram, and Signal.

## Installation

Requires Node.js `>=22`.

```bash
pnpm add chat @beeper/chat-adapter-matrix
```

## Usage

`createMatrixAdapter()` reads its config from environment variables when called without arguments.

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";

const matrix = createMatrixAdapter();

const bot = new Chat({
  userName: process.env.MATRIX_BOT_USERNAME ?? "beeper-bot",
  state: createMemoryState(),
  adapters: { matrix },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}. Mention me or run /ping.`);
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});

await bot.initialize();
```

Chat SDK concepts such as `Chat`, `Thread`, `Message`, subscriptions, and handlers work the same here. See the upstream docs for the core API:

- [Getting Started](https://chat-sdk.dev/docs/getting-started)
- [Usage](https://chat-sdk.dev/docs/usage)
- [Threads, Messages, and Channels](https://chat-sdk.dev/docs/threads-messages-channels)
- [Direct Messages](https://chat-sdk.dev/docs/direct-messages)

## Authentication

### Access token

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
});
```

### Username/password

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "password",
    username: process.env.MATRIX_USERNAME!,
    password: process.env.MATRIX_PASSWORD!,
    userID: process.env.MATRIX_USER_ID,
  },
});
```

## Defaults

- Persistence behavior is active whenever Chat provides a `state` adapter.
- Redis or another durable state adapter is recommended for restart durability.
- `deviceID` is inferred from auth when possible, then reused from state, and only generated as a last resort.
- `recoveryKey` enables E2EE.
- `inviteAutoJoin: {}` enables invite auto-join.

## Common Options

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
  recoveryKey: process.env.MATRIX_RECOVERY_KEY,
  commandPrefix: "/",
  roomAllowlist: ["!room:beeper.com"],
  inviteAutoJoin: {
    inviterAllowlist: ["@alice:beeper.com", "@ops:beeper.com"],
  },
  matrixSDKLogLevel: "error",
});
```

Advanced tuning stays in code config:

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
  e2ee: {
    useIndexedDB: false,
    cryptoDatabasePrefix: "beeper-matrix-bot",
  },
  persistence: {
    keyPrefix: "my-bot",
    session: {
      ttlMs: 86_400_000,
    },
    sync: {
      persistIntervalMs: 10_000,
    },
  },
});
```

## Environment Variables

`createMatrixAdapter()` with no arguments uses only these env vars:

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_BASE_URL` | Yes | Matrix homeserver base URL |
| `MATRIX_ACCESS_TOKEN` | Yes* | Access token for access-token auth |
| `MATRIX_USERNAME` | Yes* | Username for password auth |
| `MATRIX_PASSWORD` | Yes* | Password for password auth |
| `MATRIX_USER_ID` | No | User ID hint |
| `MATRIX_DEVICE_ID` | No | Explicit device ID override |
| `MATRIX_RECOVERY_KEY` | No | Enables E2EE and key-backup bootstrap |
| `MATRIX_BOT_USERNAME` | No | Mention-detection username |
| `MATRIX_COMMAND_PREFIX` | No | Slash command prefix. Defaults to `/` |
| `MATRIX_INVITE_AUTOJOIN` | No | Enable invite auto-join |
| `MATRIX_INVITE_AUTOJOIN_ALLOWLIST` | No | Comma-separated Matrix user IDs allowed to invite the bot |
| `MATRIX_SDK_LOG_LEVEL` | No | Matrix SDK log level |

\*Use either `MATRIX_ACCESS_TOKEN`, or `MATRIX_USERNAME` plus `MATRIX_PASSWORD`.

## Thread Model

- A Matrix room is a Chat SDK channel.
- Top-level room messages belong to the channel timeline.
- Matrix threaded replies map to Chat SDK threads using `roomID + rootEventID`.
- `openDM(userId)` reuses existing direct rooms when possible and creates one when needed.

## Features

| Feature | Supported |
|---------|-----------|
| Mentions | Yes |
| Rich text | Yes, via Matrix `formatted_body` and `m.mentions` |
| Thread replies | Yes |
| Reactions (add/remove) | Yes |
| Message edits | Yes |
| Message deletes | Yes |
| Typing indicator | Yes |
| Direct messages | Yes |
| File uploads | Yes |
| Message history | Yes |
| Channel and thread metadata | Yes |
| E2EE | Yes |
| Invite auto-join | Yes |
| Slash commands | Prefix-parsed from message text |
| Webhooks | No, this adapter uses sync polling |
| Cards | No |
| Modals | No |
| Ephemeral messages | No |
| Native streaming | No |

## Persistence

For production, pair the adapter with a durable Chat state adapter such as Redis.

```ts
import { Chat } from "chat";
import { createRedisState } from "@chat-adapter/state-redis";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";

const matrix = createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
  recoveryKey: process.env.MATRIX_RECOVERY_KEY,
});

const bot = new Chat({
  userName: process.env.MATRIX_BOT_USERNAME ?? "beeper-bot",
  state: createRedisState({ url: process.env.REDIS_URL! }),
  adapters: { matrix },
});
```

Persistence covers:

- generated or inferred device IDs
- password login sessions
- DM room mappings
- Matrix sync snapshots
- E2EE secrets bundles when E2EE is enabled

## Message and History APIs

The adapter supports:

- `fetchMessage(threadId, messageId)`
- `fetchMessages(threadId, options)`
- `fetchChannelMessages(channelId, options)`
- `fetchThread(threadId)`
- `fetchChannelInfo(channelId)`
- `listThreads(channelId, options)`
- `openDM(userId)`

## Limitations

- `handleWebhook()` returns `501` by design because Matrix uses sync polling here.
- Cards, modals, and ephemeral messages are not implemented.
- Native streaming is not implemented at the adapter layer.
- Slash commands are parsed from plain text messages; Matrix does not provide native slash command events.

## Examples

- [`examples/bot.ts`](./examples/bot.ts) uses in-memory state for local development.
- [`examples/bot.redis.ts`](./examples/bot.redis.ts) uses Redis-backed state for restart durability.
- [`examples/.env.example`](./examples/.env.example) lists the supported env vars for the examples.
- [`scripts/get-access-token.ts`](./scripts/get-access-token.ts) helps generate Beeper credentials interactively.

For release-specific changes, see [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
