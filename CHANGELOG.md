# Changelog

## 0.1.0

First public release.

- Whole-vault sync (notes, folders, renames, deletes) with a single room code.
- Live typing with named, colored cursors (Yjs + CodeMirror).
- Attachment sync with a size limit (default 25 MB).
- Offline edits merge on reconnect; clashing versions are kept as `(conflict ...)` notes.
- Choice of discovery network: Nostr (default), BitTorrent trackers or MQTT; optional TURN server.
- Commands: copy room code, reconnect, check all files, pause/resume, copy debug log.
