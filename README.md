# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs). Uses Matrix sync (no webhook server required).

If you are using Beeper, you can use Chat SDK with your Beeper Cloud accounts and Matrix chats. This lets you use Chat SDK with WhatsApp, Telegram, Instagram, Signal, X Chat, and more. For bridged chats, we recommend personal usage, since some networks may limit automated activity.

## Installation

```bash
npm install chat @beeper/chat-adapter-matrix matrix-js-sdk
```

## Usage

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
      },
      recoveryKey: process.env.MATRIX_RECOVERY_KEY,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}`);
});
```

## Auth

Access token:

```ts
auth: { type: "accessToken", accessToken: process.env.MATRIX_ACCESS_TOKEN! };
```

Username/password:

```ts
auth: {
  type: "password",
  username: process.env.MATRIX_USERNAME!,
  password: process.env.MATRIX_PASSWORD!,
};
```

## Environment

Required:

- `MATRIX_BASE_URL`
- Access token mode: `MATRIX_ACCESS_TOKEN`
- Password mode: `MATRIX_USERNAME`, `MATRIX_PASSWORD`

Optional:

- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`
- `MATRIX_DEVICE_ID_PERSIST_ENABLED`
- `MATRIX_DEVICE_ID_PERSIST_KEY`
- `MATRIX_RECOVERY_KEY`
- `MATRIX_E2EE_ENABLED`
- `MATRIX_E2EE_USE_INDEXEDDB`
- `MATRIX_E2EE_DB_PREFIX`
- `MATRIX_E2EE_STORAGE_PASSWORD`
- `MATRIX_E2EE_STORAGE_KEY_BASE64`
- `MATRIX_SESSION_ENABLED`
- `MATRIX_SESSION_KEY`
- `MATRIX_SESSION_TTL_MS`
- `MATRIX_SDK_LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`)

## Examples

Copy [`examples/.env.example`](./examples/.env.example) to `examples/.env`, then run:

```bash
npm run example:bun
```

Generate a Beeper access token interactively:

```bash
npm run token:bun
```

## Get a Beeper Access Token

Use the interactive helper:

```bash
npm run token:bun
```

It prints:

- `MATRIX_BASE_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`

Paste those values into `examples/.env` or your deployment secrets.

or:

```bash
bun --env-file=examples/.env run examples/bot.ts
```

## Notes

- `handleWebhook()` returns `501` by design.
- Access-token auth resolves identity with `whoami`.
- Password auth sends configured `device_id` during login.
- Use Redis state in production for stable sessions and device IDs.

## License

MIT
