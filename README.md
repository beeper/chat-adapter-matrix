# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs).

This adapter runs over Matrix sync, so you do not need to host a webhook endpoint.

If you use Beeper, this adapter lets your Chat SDK bot work with your Matrix/Beeper conversations (including bridged networks such as WhatsApp, Telegram, Instagram, Signal, and others).

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

## Authentication

Use either access-token auth or username/password auth.

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

Common optional:

- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`
- `MATRIX_RECOVERY_KEY`

Advanced options are available for device/session persistence, E2EE storage, and SDK logging (`MATRIX_SDK_LOG_LEVEL`).

## Running The Example

Copy [`examples/.env.example`](./examples/.env.example) to `examples/.env`, then run:

```bash
npm run example:bun
```

If you need Beeper credentials, generate them interactively:

```bash
npm run token:bun
```

The helper prints:

- `MATRIX_BASE_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`

Then run:

```bash
bun --env-file=examples/.env run examples/bot.ts
```

## Capabilities

- `openDM(userId)` creates or reuses direct rooms using Matrix `m.direct` account data and persisted adapter state.
- `fetchMessage(threadId, messageId)` fetches a single message with thread/channel context validation.
- `fetchChannelMessages(channelId, options)` fetches top-level room timeline messages.
- `fetchMessages(threadId, options)` and `listThreads(channelId, options)` use API-first server pagination via `matrix-js-sdk`.
- `postEphemeral`, `openModal`, and native `stream` are not implemented by this adapter.

## Notes

- `handleWebhook()` returns `501` by design, since this adapter is sync-based.
- Access-token auth resolves identity with `whoami`.
- Password auth sends the configured `device_id` during login.
- For production, use Redis state for stable sessions and device IDs.

For release-specific changes and migration notes, see [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
