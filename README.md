# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs).

## Installation

```bash
npm install chat @beeper/chat-adapter-matrix matrix-js-sdk
```

## Quick Start

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";

const bot = new Chat({
  userName: "beeper-bot",
  state: createMemoryState(),
  adapters: {
    matrix: createMatrixAdapter({
      baseURL: process.env.MATRIX_BASE_URL!,
      auth: {
        type: "accessToken",
        accessToken: process.env.MATRIX_ACCESS_TOKEN!,
        userID: process.env.MATRIX_USER_ID,
      },
      recoveryKey: process.env.MATRIX_RECOVERY_KEY,
      commandPrefix: "/",
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}`);
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});
```

## Auth Modes

- Access token:
```ts
auth: { type: "accessToken", accessToken: process.env.MATRIX_ACCESS_TOKEN! }
```
- Username/password:
```ts
auth: { type: "password", username: process.env.MATRIX_USERNAME!, password: process.env.MATRIX_PASSWORD! }
```

## Features

- Matrix sync-based inbound event ingestion (no webhook dependency)
- Message, mention, slash command, and reaction mapping
- Slash command parsing from text messages (default `/` prefix)
- Outbound post/edit/delete/reaction/typing support
- E2EE support (Rust crypto + inbound decrypt)
- Recovery-key-based key-backup loading during E2EE init
- Stable `deviceID` persistence via Chat state when none is provided
- Session persistence via Chat state adapter
- Sample event payloads in [`sample-messages.md`](./sample-messages.md)

## Environment

- `MATRIX_BASE_URL`
- Access token mode: `MATRIX_ACCESS_TOKEN` (`MATRIX_USER_ID` optional)
- Password mode: `MATRIX_USERNAME`, `MATRIX_PASSWORD` (`MATRIX_USER_ID` optional)
- `MATRIX_DEVICE_ID` (optional)
- `MATRIX_DEVICE_ID_PERSIST_ENABLED` (`true`/`false`, default `true`)
- `MATRIX_DEVICE_ID_PERSIST_KEY` (optional)
- `MATRIX_RECOVERY_KEY` (enables E2EE when present)
- `MATRIX_E2EE_ENABLED` (`true`/`false`, optional override)
- `MATRIX_E2EE_USE_INDEXEDDB` (`true`/`false`, default `true` only when `indexedDB` exists in runtime)
- `MATRIX_E2EE_DB_PREFIX` (optional)
- `MATRIX_E2EE_STORAGE_PASSWORD` (optional)
- `MATRIX_E2EE_STORAGE_KEY_BASE64` (optional)
- `MATRIX_SESSION_ENABLED` (`true`/`false`, default `true`)
- `MATRIX_SESSION_KEY` (optional)
- `MATRIX_SESSION_TTL_MS` (optional)

## Examples

Copy [`examples/.env.example`](./examples/.env.example) to `examples/.env`, then run:

```bash
npm run example:bun
npm run example:bun:redis
```

Direct Bun command:

```bash
bun --env-file=examples/.env run examples/bot.ts
```

## Notes

- `handleWebhook()` returns `501` by design (Matrix uses sync polling).
- Session durability depends on your Chat state backend (use Redis in production).
- Session and generated deviceID stability depend on your Chat state backend (use Redis in production).
- If `session.encrypt` is set, `session.decrypt` is also required.
- With `MATRIX_RECOVERY_KEY`, adapter provides secret-storage key callbacks and attempts key-backup activation.
- Default sync mode is optimized for faster startup on large accounts (`initialSyncLimit=1`, `lazyLoadMembers=true`, `disablePresence=true`, `pollTimeout=10000`) unless `sync` is explicitly provided.

## Shutdown

Stop sync cleanly on process exit:

```ts
const matrix = createMatrixAdapter();
process.on("SIGINT", async () => {
  await matrix.shutdown();
  process.exit(0);
});
```

## License

MIT
