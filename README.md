# YoutubeDownloaderClient

A browser-based YouTube audio/video downloader frontend. All media processing is done client-side using FFmpeg.wasm — the server only streams the raw YouTube data.

## Features

- **Audio mode**: Fetches the best audio stream from the server and converts it in-browser via FFmpeg.wasm
- **Video mode**: Fetches video-only and audio-only streams in parallel, then muxes them into MP4 in-browser (no re-encode)
- Supported audio formats: MP3, AAC (M4A), OGG Vorbis, Opus, FLAC, WAV
- Audio bitrates: 64 / 128 / 192 (default) / 320 kbps
- Video resolutions: 360p / 480p / 720p / 1080p / 1440p / 4K (default: 4K; falls back to best available)
- Clipboard YouTube URL auto-detection (Chrome: automatic on focus, Firefox: Ctrl+V)
- Multiple URLs processed simultaneously
- JWT authentication with automatic expiry detection

## Tech Stack

- React 19, TypeScript
- Vite
- Tailwind CSS v4
- FFmpeg.wasm (`@ffmpeg/core@0.12.10`)

## Development

```bash
pnpm install
pnpm run dev      # http://localhost:5173  (/api/* proxied to localhost:3000)
```

## Build

```bash
pnpm run build    # tsc -b && vite build  →  dist/
```

## Docker / Podman

Build from the **project root** (one level above this directory):

```bash
podman build -f Dockerfile -t ytdlweb-client:latest .
```

Run:

```bash
podman run -d -p 8080:80 \
  -e SERVER_HOST=<backend-host> \
  -e SERVER_PORT=3000 \
  ytdlweb-client:latest
```

### Runtime environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_HOST` | `server` | Hostname of the backend server |
| `SERVER_PORT` | `3000` | Port of the backend server |

## Notes

- The nginx image sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers automatically — these are required for FFmpeg.wasm to use `SharedArrayBuffer`.
- After restarting the backend container, reload nginx inside the client container to clear its DNS cache:
  ```bash
  podman exec ytdlweb-client sh -c "nginx -s reload"
  ```
