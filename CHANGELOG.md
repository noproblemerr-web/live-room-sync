# Changelog

## 0.3.0

- Note history: earlier versions of each note are kept on your device (before a friend's change, before a merge, and now and then while you work). Command: "Show history of this note" lets you preview and restore a version.
- Click a friend in the party panel to open the note they are in.
- Join and leave messages ("Bo joined the party"), with a setting to turn them off.
- A new end-to-end test runs two copies of the whole plugin through start, invite, join, allow, sync, history and leave. CI runs it on every change.
- Follow Obsidian's plugin guidelines for the community list: no inline styles (colors use CSS variables), console shows only errors, sentence case text, the history command only appears when a note is open, clearer manifest description, a "Disclosures" section in the README.
- Add `docs/submitting.md` with the steps for the community plugin directory.

## 0.2.0

A friendlier way to share: parties, profiles and approval. **Not compatible with 0.1.x**: update every device.

- New party panel (ribbon icon or status bar) showing who is here, who wants to join, what they are editing and friends you partied with before.
- Profiles: name, emoji picture and color. Your cursor shows your picture and name.
- Invite links (`obsidian://live-room-sync?code=...`) and a join dialog that accepts a code or a link.
- Party codes now end in a check letter, so a mistyped code is caught. Older codes still work ("Join anyway").
- New devices must be allowed (Allow / Block). Devices prove who they are with a signature made from a per-device key, so a name or id cannot be copied. Setting: "Ask before new devices join".
- Renames are now real renames. An edit made on another device during a rename follows the note to its new name instead of bringing the old note back.
- Simpler settings page; technical options are under "Advanced". The settings page redraws when the party changes.
- Status bar reads "Party: ..." and opens the panel when clicked.
- Saving the sync state is delayed a little longer (2.5 s) to do less work while typing; default file limit is 10 MB on phones.
- Fix: a picture deleted on one device could come back (three races in the file sync; see the 0.1.x notes below).
- Fix: after the sync engine stops, no queued work can run any more.
- Fix: minimum Obsidian version is 1.6.6 (the plugin uses `FileManager.trashFile`).
- Declare `@trystero-p2p/nostr` and `@trystero-p2p/core` as dependencies; remove the unused `trystero` and `lib0`; pin the dev tools that used `*`.
- Add CI (type-check, build, smoke test, sync tests) and a tag-triggered release workflow.
- Known issue: the line under a friend's name can show "Online" instead of "Editing <note>".

## 0.1.0

First public release.

- Whole-vault sync (notes, folders, renames, deletes) with a single room code.
- Live typing with named, colored cursors (Yjs + CodeMirror).
- Attachment sync with a size limit (default 25 MB).
- Offline edits merge on reconnect; clashing versions are kept as `(conflict ...)` notes.
- Choice of discovery network: Nostr (default), BitTorrent trackers or MQTT; optional TURN server.
- Commands: copy room code, reconnect, check all files, pause/resume, copy debug log.
