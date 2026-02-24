# Screen & Webcam Recorder (Electron + TypeScript)

A desktop app that lets users:
- view available screens/windows,
- select one source to record,
- optionally record webcam in parallel,
- save each recording session under `videos/<uuid>/` with separate files:
  - `screen.webm`
  - `webcam.webm` (if enabled)

## Features

- Source picker for all screens/windows with thumbnails
- Screen live preview
- Optional webcam preview and recording toggle
- One-click start/stop recording
- Independent webcam stop while screen recording continues
- UUID session folder creation per recording
- Session metadata (`session.json`) and session rename support
- Recording complete panel with "Open Recording Folder"
- Live timer and max-duration guard (2 hours)
- Export settings: bitrate selection and custom save location chooser
- Secure IPC bridge and atomic file writes

## Tech Stack

- Electron
- TypeScript
- Vite (renderer build)

## Getting Started

### Prerequisites

- Node.js 18+

### Install

```bash
npm install
```

### Run

```bash
npm start
```

### Build

```bash
npm run build
```

## Output Structure

```text
videos/
├── <uuid>/
│   ├── screen.webm
│   ├── webcam.webm   (if webcam enabled)
│   └── session.json
└── ...
```

## Security Notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has no direct Node.js filesystem access
- IPC is allowlisted with input validation
- File writes restricted to allowed filenames and session path
- Atomic write strategy to reduce corruption risk

## Known Limitations

- System audio capture is not included (video-only recording).
- Codec/container output is currently WebM.
- In some environments, desktop capture permissions may require OS-level approval.
- If the app is force-terminated by the OS/process manager, final save flush may still be interrupted.

## Main Scripts

- `npm start` - build and launch Electron app
- `npm run build` - build main/preload and renderer
- `npm run typecheck` - TypeScript type checking
