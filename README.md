# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs). Build Chat SDK bots that run over Matrix sync instead of webhooks, including Beeper conversations and bridged networks such as WhatsApp, Telegram, Instagram, and Signal.

## Installation

Requires Node.js `>=22`.

```bash
pnpm add chat @beeper/chat-adapter-matrix
```

## Usage

`createMatrixAdapter()` can read its configuration from environment variables, similar to the upstream Chat SDK adapters.

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";

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
  await thread.post(`Hi ${message.author.userName}. Mention me or run /ping.`);
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});

await bot.initialize();

process.on("SIGINT", async () => {
  await matrix.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await matrix.shutdown();
  process.exit(0);
});
```

Chat SDK concepts such as `Chat`, `Thread`, `Message`, subscriptions, and handlers work the same here. See the upstream docs for the core API:

- [Getting Started](https://chat-sdk.dev/docs/getting-started)
- [Usage](https://chat-sdk.dev/docs/usage)
- [Threads, Messages, and Channels](https://chat-sdk.dev/docs/threads-messages-channels)
- [Direct Messages](https://chat-sdk.dev/docs/direct-messages)

## Authentication

### Access token

Best when you already have a Matrix or Beeper access token.

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

Best when you want the adapter to log in and reuse persisted sessions between restarts.

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

## Thread Model

- A Matrix room is a Chat SDK channel.
- Top-level room messages belong to the channel timeline.
- Matrix threaded replies map to Chat SDK threads using `roomID + rootEventID`.
- `openDM(userId)` reuses existing direct rooms from Matrix account data when possible and creates one when needed.

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

## Configuration

### Adapter options

| Option | Required | Description |
|--------|----------|-------------|
| `baseURL` | Yes | Matrix homeserver base URL |
| `auth` | Yes | Access token or password auth config |
| `userName` | No | Bot name used for mention detection. Defaults to `MATRIX_BOT_USERNAME`, then `MOM_BOT_USERNAME`, then `"bot"` |
| `deviceID` | No | Device ID to use. If omitted, one is generated and persisted by default |
| `commandPrefix` | No | Prefix used to parse slash-style commands from message text. Defaults to `/` |
| `roomAllowlist` | No | Restrict processing to specific room IDs |
| `inviteAutoJoin` | No | Auto-join incoming invites, optionally with inviter allowlisting |
| `logger` | No | Custom Chat SDK logger |
| `deviceIDPersistence` | No | Control generated device ID persistence in Chat SDK state |
| `session` | No | Control persisted session reuse for password auth |
| `matrixStore` | No | Persist Matrix sync state in the Chat SDK state adapter |
| `e2ee` | No | Configure Matrix Rust crypto storage |
| `recoveryKey` | No | Recovery key for key backup bootstrap |
| `matrixSDKLogLevel` | No | Matrix SDK log level: `trace`, `debug`, `info`, `warn`, or `error` |
| `createClient` | No | Override Matrix client creation |
| `createBootstrapClient` | No | Override auth bootstrap client creation |
| `createStore` | No | Override Matrix sync store creation |

### Environment variables

When you call `createMatrixAdapter()` without arguments, these env vars are used:

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_BASE_URL` | Yes | Matrix homeserver base URL |
| `MATRIX_ACCESS_TOKEN` | Yes* | Access token for access-token auth |
| `MATRIX_USERNAME` | Yes* | Username for password auth |
| `MATRIX_PASSWORD` | Yes* | Password for password auth |
| `MATRIX_USER_ID` | No | User ID hint. Recommended for stable state scoping |
| `MATRIX_BOT_USERNAME` | No | Mention-detection username |
| `MATRIX_DEVICE_ID` | No | Explicit device ID |
| `MATRIX_DEVICE_ID_PERSIST_ENABLED` | No | Enable generated device ID persistence. Defaults to `true` |
| `MATRIX_DEVICE_ID_PERSIST_KEY` | No | Override the device ID persistence key |
| `MATRIX_COMMAND_PREFIX` | No | Slash command prefix. Defaults to `/` |
| `MATRIX_INVITE_AUTOJOIN_ENABLED` | No | Enable invite auto-join. Defaults to `true` when an allowlist is set, otherwise `false` |
| `MATRIX_INVITE_AUTOJOIN_ALLOWLIST` | No | Comma-separated Matrix user IDs allowed to invite the bot |
| `MATRIX_RECOVERY_KEY` | No | Recovery key for Matrix key backup |
| `MATRIX_E2EE_ENABLED` | No | Enable E2EE. Defaults to `true` when `MATRIX_RECOVERY_KEY` is set |
| `MATRIX_E2EE_USE_INDEXEDDB` | No | Request IndexedDB-backed crypto storage when available |
| `MATRIX_E2EE_DB_PREFIX` | No | Crypto database prefix |
| `MATRIX_E2EE_STORAGE_PASSWORD` | No | Crypto storage password. Defaults to `MATRIX_RECOVERY_KEY` |
| `MATRIX_E2EE_STORAGE_KEY_BASE64` | No | Base64-encoded crypto storage key |
| `MATRIX_SESSION_ENABLED` | No | Enable persisted password sessions. Defaults to `true` |
| `MATRIX_SESSION_KEY` | No | Override the persisted session state key |
| `MATRIX_SESSION_TTL_MS` | No | TTL for persisted session entries |
| `MATRIX_SDK_LOG_LEVEL` | No | Matrix SDK log level. Defaults to `error` |

\*Use either `MATRIX_ACCESS_TOKEN`, or `MATRIX_USERNAME` plus `MATRIX_PASSWORD`.

## Persistence and E2EE

For production, pair the adapter with a persistent Chat SDK state adapter such as Redis.

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
  matrixStore: {
    enabled: true,
  },
  e2ee: {
    enabled: true,
    persistSecretsBundle: true,
  },
});

const bot = new Chat({
  userName: "beeper-bot",
  state: createRedisState({ url: process.env.REDIS_URL! }),
  adapters: { matrix },
});
```

What persistence covers:

- Generated device IDs can be reused across restarts.
- Password login sessions are reused by default.
- `matrixStore.enabled` persists sync snapshots so the SDK can resume faster.
- `persistSecretsBundle` stores exported E2EE secrets in Chat SDK state for later import.

## Invite Auto-Join

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
  inviteAutoJoin: {
    enabled: true,
    inviterAllowlist: ["@alice:beeper.com", "@ops:beeper.com"],
  },
});
```

Behavior:

- Only invites targeting the bot user are considered.
- If `roomAllowlist` is set, the room must be allowed.
- If `inviterAllowlist` is set, the inviter must be allowed.
- Rate-limited joins are retried automatically.

## Message and History APIs

The adapter supports the broader Chat SDK message APIs beyond basic posting:

- `fetchMessage(threadId, messageId)`
- `fetchMessages(threadId, options)`
- `fetchChannelMessages(channelId, options)`
- `fetchThread(threadId)`
- `fetchChannelInfo(channelId)`
- `listThreads(channelId, options)`
- `openDM(userId)`

Inbound `formatted_body` is normalized into Chat SDK rich text, reply fallbacks are stripped from visible text, and outbound markdown plus Chat SDK mention placeholders are rendered back to Matrix HTML and pill mentions.

## Limitations

- `handleWebhook()` returns `501` by design because Matrix uses sync polling here.
- Cards, modals, and ephemeral messages are not implemented.
- Native streaming is not implemented at the adapter layer.
- Slash commands are parsed from plain text messages; Matrix does not provide native slash command events.

## Examples

- [`examples/bot.ts`](./examples/bot.ts) uses in-memory state for local development.
- [`examples/bot.redis.ts`](./examples/bot.redis.ts) uses Redis-backed state.
- [`examples/.env.example`](./examples/.env.example) lists the env vars used by the examples.
- [`scripts/get-access-token.ts`](./scripts/get-access-token.ts) helps generate Beeper credentials interactively.

For release-specific changes, see [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
