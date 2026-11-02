# Changelog

## Unreleased

- Fix: after the sync engine stops, no queued work can run any more (the guard in `queue()` could never trigger).
- Fix: minimum Obsidian version is now 1.6.6, because the plugin uses `FileManager.trashFile`.
- Declare `@trystero-p2p/nostr` and `@trystero-p2p/core` as dependencies (they were imported but not listed). Remove the unused `trystero` and `lib0`. Pin the dev tools that used `*`.
- `npm test` exits cleanly when the tests finish.
- Add CI (type-check, build, smoke test, sync tests) and a tag-triggered release workflow.
- README: privacy and room-code notes.

## 0.1.0

First public release.

- Whole-vault sync (notes, folders, renames, deletes) with a single room code.
- Live typing with named, colored cursors (Yjs + CodeMirror).
- Attachment sync with a size limit (default 25 MB).
- Offline edits merge on reconnect; clashing versions are kept as `(conflict ...)` notes.
- Choice of discovery network: Nostr (default), BitTorrent trackers or MQTT; optional TURN server.
- Commands: copy room code, reconnect, check all files, pause/resume, copy debug log.
