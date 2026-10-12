# Mystery Channel

Mystery Channel turns a folder of locally stored programmes into a personal,
offline-first TV channel. It chooses a programme at random while preserving
episode order and watch progress.

## Features

- Plays the earliest unfinished episode from a randomly selected programme.
- Resumes partially watched episodes and marks them complete at a configurable threshold.
- Recognizes common episode formats such as `S01E02`, `1x02`, and date-based episodes.
- Watches library folders for changes without deleting media or viewing history.
- Keeps progress when files are safely moved or renamed.
- Supports exclusions, backup and restore, external playback, and preview-first renaming.
- Works locally with no account, analytics, advertising, or cloud dependency.

## Library layout

```text
Shows/
  Doctor Who/
    Season 01/
      Doctor Who S01E01.mkv
      Doctor Who S01E02.mkv
  The Office/
    The Office 1x01.mp4
    The Office 1x02.mp4
```

Ambiguous filenames remain visible and are marked for manual review instead of
being silently put into a potentially incorrect order.

## Run from source

Requirements: Windows, Node.js 22 or newer, and npm.

```powershell
git clone https://github.com/YOUR-USERNAME/mystery-channel.git
cd mystery-channel
npm install
npm run dev
```

The SQLite progress database is stored in the current Windows user's application-data
folder, not in this repository.

## Tests

```powershell
npm run typecheck
npm test
npm run smoke
```

`npm test` temporarily rebuilds the SQLite native module for the system Node.js
runtime and restores the Electron build afterward. `npm run smoke` launches the
Electron main process against an isolated synthetic library and writes captures
to `artifacts/`.

## Build the Windows installer

```powershell
npm run build
```

The installer is written to `release/`. Build output is intentionally excluded
from Git; attach an installer to a GitHub Release instead of committing it to
the repository.

## Privacy and safety

Mystery Channel never deletes media. It changes filenames only after a rename
preview is explicitly confirmed. Some codecs may not play inside Electron;
**Open externally** uses the default system player, and externally played
episodes must be marked watched manually.

## Publishing

See [docs/GITHUB_UPLOAD.md](docs/GITHUB_UPLOAD.md) for step-by-step GitHub setup
and upload instructions.
