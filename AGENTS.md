# Smart Security Monitor — Agent Notes

## Environment

- **Current time**: 2026-08-04T13:02:28+03:00
- **Working directory**: D:\smart-security-monitor\docs
- **Workspace root folder**: D:\smart-security-monitor

## Project Overview

Smart Security Monitor — video surveillance with real-time face recognition.

**Stack**: React 19 · TypeScript · Express · Prisma (SQLite) · FastAPI · InsightFace (buffalo_l) · FFmpeg · WebSocket

## Key Files

| File | Purpose |
|---|---|
| `server.ts` | Node.js Express backend (171KB) |
| `face_server.py` | Python FastAPI face engine (69KB) |
| `face-engine.ts` | TypeScript face processing (49KB) |
| `src/pages/Settings.tsx` | Settings page (had JSX table/div mismatch — fixed) |
| `src/components/RoiEditor.tsx` | ROI zone editor (rewritten with exclusion zones) |
| `src/api/client.ts` | API client (added normalizePath) |

## Running

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
npm run dev
```

Services:
- Vite dev server: `http://localhost:5173`
- Node.js API: `http://0.0.0.0:3000`
- Python Face Engine: `http://0.0.0.0:8001`

### White Screen Fix (Vite hang)

Vite dev server becomes unresponsive (white screen, HTTP timeouts) when its file watcher
observes the `venv` directory (~40k files) and other heavy dirs. The watcher accumulates
tens of thousands of handles (observed: 36 070 handles / 708 MB), blocking the HTTP event loop.

**Fix** (`vite.config.ts`): added `venv/`, `venv_kraken/`, `venv_new/`, `calibration/`,
`backend/`, `assets/`, `models/` to `watch.ignored`.
**Alternative**: `DISABLE_HMR=true npm run dev` disables watch/HMR entirely.

## Known Issues Fixed

- `Settings.tsx` had an unclosed `<tbody>` wrapping `<div>` elements inside a `<table>`. Removed the `<table>`/`<thead>`/`<tbody>` structure; content is now plain `<div>` elements inside `overflow-x-auto`.
- Snapshot endpoint in `server.ts` was returning static `rus.jpg` always. Fixed to try live FFmpeg snapshot first, then saved snapshots, then fallback.
- `api/client.ts` missing `normalizePath` function for FastAPI trailing slash handling. Added.
- `RoiEditor.tsx` rewritten with exclusion zones support, mode switcher, and metal detector preset.
- White screen on Vite dev server caused by file watcher observing `venv/` (~40k files) and other heavy directories, accumulating 36 070 handles and blocking the HTTP event loop. Fixed by adding `venv/`, `venv_kraken/`, `venv_new/`, `calibration/`, `backend/`, `assets/`, `models/` to `watch.ignored` in `vite.config.ts`.