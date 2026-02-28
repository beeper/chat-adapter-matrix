# Changelog

## 1.0.0

### Breaking Changes

- Pagination cursors now use opaque `mxv1:<base64url-json>` values across `fetchMessages`, `fetchChannelMessages`, and `listThreads`.
- Legacy cursors are now rejected with `Invalid cursor format. Expected mxv1 cursor.`. Stored cursors from older versions must be cleared on upgrade.

### New

- Added `openDM(userId)` with persisted mapping and `m.direct` reuse/create behavior.
- Added `fetchMessage(threadId, messageId)` for context-aware single-message fetch.
- Added `fetchChannelMessages(channelId, options)` for top-level channel timeline history.

### Changes

- Reworked `fetchMessages(threadId, options)` to API-first server pagination via `matrix-js-sdk`:
  - Room timeline pages now use `/messages` through the SDK.
  - Thread pages now use `/relations` through the SDK.
  - Thread pages include the root message on the first page.
- Reworked `listThreads(channelId, options)` to use server-backed thread listing via the SDK `/threads` path.

### Fixes

- Message and thread history retrieval no longer depends on local `room.timeline` availability for correctness.

## 0.1.0

- Initial release.
