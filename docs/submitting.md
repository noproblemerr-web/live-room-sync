# Submitting to the Obsidian community plugin directory

This checklist is for the person who owns the repository. The plugin is ready for it; the last steps need your Obsidian account, so they have to be done by you.

## What is already in place

- `README.md`, `LICENSE` and `manifest.json` at the root of the repository.
- A GitHub release whose tag matches `version` in `manifest.json` (for example `0.3.0`), with `main.js`, `manifest.json` and `styles.css` attached. Pushing a tag does this for you (`.github/workflows/release.yml`).
- `id` is `live-room-sync` (it must not contain "obsidian" and must be unique).
- Version uses `x.y.z`, and `versions.json` lists the minimum Obsidian version (1.7.2).
- README has a "Disclosures" section about network use, accounts, telemetry, files and the clipboard.
- The plugin follows Obsidian's plugin guidelines: no global `app`, no `innerHTML`, no inline styles (colors use CSS variables), only errors in the console, sentence case text, no default hotkeys, and cleanup through `registerEvent` and `registerInterval`.

## What you do

1. Sign in at https://community.obsidian.md with your Obsidian account.
2. Link your GitHub account to your profile, so the directory can check you own the repository.
3. Choose "Add a plugin" and enter `noproblemerr-web/live-room-sync`.
4. Wait for the automated review. If it reports errors, fix them, bump the version in `manifest.json`, push a new tag, and resubmit.

The directory reads `manifest.json` from the default branch, so make sure it is committed and matches the latest release before you submit. Check the current steps on https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin, because Obsidian may change the process.
