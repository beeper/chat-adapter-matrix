# Changelog

## 0.1.0

- Initial release of `@beeper/chat-adapter-matrix`
- Added Matrix sync-driven `Adapter` implementation
- Added inbound message, reaction, and slash-command handling
- Added outbound post/edit/delete/reaction/typing support
- Added thread/channel fetch helpers and tests
- Added optional Matrix E2EE support (Rust crypto init + encrypted event decryption)
- Renamed package metadata to `@beeper/chat-adapter-matrix` and repository to `beeper/chat-adapter-matrix`
- Added auto-generated Matrix `deviceID` when not provided
- Added `recoveryKey`/`MATRIX_RECOVERY_KEY` support to auto-enable E2EE
- Added typed username/password login support (`auth.type = "password"`)
- Made `userID` optional for access-token auth and resolve it via Matrix `whoami` when omitted
- Added `sample-messages.md` with Matrix payload examples for adapter debugging
- Added Bun example env-file loading and improved `.env` ignore patterns for repo cleanliness
