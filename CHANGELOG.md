# Changelog

## 1.0.0

- Major: switched pagination cursors to opaque `mxv1:<base64url-json>` format across `fetchMessages`, `fetchChannelMessages`, and `listThreads`.
- Breaking: legacy cursors are rejected (`Invalid cursor format. Expected mxv1 cursor.`). Stored cursors from older versions must be cleared.
- Added `openDM(userId)` with persisted mapping + `m.direct` reuse/create behavior.
- Added `fetchMessage(threadId, messageId)` for context-aware single-message fetch.
- Added `fetchChannelMessages(channelId, options)` for top-level timeline history.
- Reworked `fetchMessages(threadId, options)` to API-first server pagination via `matrix-js-sdk`:
  - Room timeline pages use `/messages` API through SDK.
  - Thread pages use `/relations` API through SDK.
  - Thread pages include root on first page.
- Reworked `listThreads(channelId, options)` to server-backed thread listing via SDK `/threads` support.
- Kept intentionally unsupported in this release: `postEphemeral`, `openModal`, and native `stream`.

## 0.1.0

- Initial release.
