import { useState, useRef, useCallback, useEffect } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { useAuth } from '../context/AuthContext'
import { apiStream, apiStreamVideo, isUnauthorizedError } from '../lib/api'
import type { ApiError } from '../lib/api'

const APP_VERSION = '1.0.2'

// ── Types ─────────────────────────────────────────────────────────────────────

type DownloadStatus = 'idle' | 'downloading' | 'converting' | 'done' | 'error'
type Bitrate = '64' | '128' | '192' | '320'
type FormatId = 'mp3' | 'm4a' | 'ogg' | 'opus' | 'flac' | 'wav'
type DownloadMode = 'audio' | 'video'
type VideoHeight = 360 | 480 | 720 | 1080 | 1440 | 2160

interface FormatOption {
  id: FormatId
  label: string        // display name
  ext: string          // file extension
  mime: string         // blob MIME type
  lossless: boolean    // if true, bitrate selector is hidden
  // FFmpeg args builder — receives bitrate string (ignored for lossless)
  args: (bitrate: string) => string[]
}

const FORMATS: FormatOption[] = [
  {
    id: 'mp3',
    label: 'MP3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    lossless: false,
    args: (b) => ['-c:a', 'libmp3lame', '-b:a', `${b}k`, '-f', 'mp3'],
  },
  {
    id: 'm4a',
    label: 'AAC (M4A)',
    ext: 'm4a',
    mime: 'audio/mp4',
    lossless: false,
    // ipod muxer = M4A container (AAC in MPEG-4)
    args: (b) => ['-c:a', 'aac', '-b:a', `${b}k`, '-f', 'ipod'],
  },
  {
    id: 'ogg',
    label: 'OGG Vorbis',
    ext: 'ogg',
    mime: 'audio/ogg',
    lossless: false,
    // libvorbis uses -q (VBR quality 0-10) but also accepts -b:a for ABR
    args: (b) => ['-c:a', 'libvorbis', '-b:a', `${b}k`, '-f', 'ogg'],
  },
  {
    id: 'opus',
    label: 'Opus',
    ext: 'opus',
    mime: 'audio/ogg; codecs=opus',
    lossless: false,
    // Opus in Ogg container; bitrate in kbps
    args: (b) => ['-c:a', 'libopus', '-b:a', `${b}k`, '-f', 'ogg'],
  },
  {
    id: 'flac',
    label: 'FLAC',
    ext: 'flac',
    mime: 'audio/flac',
    lossless: true,
    args: () => ['-c:a', 'flac', '-f', 'flac'],
  },
  {
    id: 'wav',
    label: 'WAV',
    ext: 'wav',
    mime: 'audio/wav',
    lossless: true,
    args: () => ['-c:a', 'pcm_s16le', '-f', 'wav'],
  },
]

const FORMAT_MAP = Object.fromEntries(FORMATS.map((f) => [f.id, f])) as Record<FormatId, FormatOption>

const BITRATE_OPTIONS: { value: Bitrate; label: string }[] = [
  { value: '64',  label: '64 kbps' },
  { value: '128', label: '128 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '320', label: '320 kbps' },
]

const VIDEO_HEIGHT_OPTIONS: { value: VideoHeight; label: string }[] = [
  { value: 2160, label: '4K (2160p)' },
  { value: 1440, label: '1440p' },
  { value: 1080, label: '1080p' },
  { value: 720,  label: '720p' },
  { value: 480,  label: '480p' },
  { value: 360,  label: '360p' },
]

interface DownloadItem {
  id: string
  url: string
  label: string
  status: DownloadStatus
  downloadProgress: number
  convertProgress: number
  mode: DownloadMode
  format: FormatId
  bitrate: Bitrate
  videoHeight: VideoHeight
  errorMsg?: string
}

// ── FFmpeg instance pool ──────────────────────────────────────────────────────

const BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'

let coreURLCache: string | null = null
let wasmURLCache: string | null = null
let urlsLoading: Promise<void> | null = null

async function loadCoreURLs(): Promise<void> {
  if (coreURLCache && wasmURLCache) return
  if (urlsLoading) return urlsLoading
  urlsLoading = (async () => {
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${BASE_URL}/ffmpeg-core.js`,   'text/javascript'),
      toBlobURL(`${BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    coreURLCache = coreURL
    wasmURLCache = wasmURL
  })()
  await urlsLoading
}

const idlePool: FFmpeg[] = []

async function acquireFFmpeg(): Promise<FFmpeg> {
  await loadCoreURLs()
  if (idlePool.length > 0) return idlePool.pop()!
  const ff = new FFmpeg()
  await ff.load({ coreURL: coreURLCache!, wasmURL: wasmURLCache! })
  return ff
}

function releaseFFmpeg(ff: FFmpeg): void {
  idlePool.push(ff)
}

async function prewarmFFmpeg(): Promise<void> {
  try { releaseFFmpeg(await acquireFFmpeg()) } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function sanitiseFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'audio'
}

function extractTitle(disposition: string | null): string {
  if (!disposition) return ''
  const m =
    disposition.match(/filename\*=UTF-8''([^;\r\n]+)/i) ??
    disposition.match(/filename=["']?([^"';\r\n]+)/i)
  if (!m) return ''
  return decodeURIComponent(m[1]).replace(/\.[^.]+$/, '').trim()
}

function parseUrls(text: string): string[] {
  const RE =
    /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s,;"'<>\[\]{}|\\^`]+|shorts\/[^\s,;"'<>\[\]{}|\\^`]+|embed\/[^\s,;"'<>\[\]{}|\\^`]+)|youtu\.be\/[^\s,;"'<>\[\]{}|\\^`]+)/gi
  const found = text.match(RE) ?? []
  const cleaned = found.map((u) => u.replace(/[.,;:!?)]+$/, ''))
  return [...new Set(cleaned)]
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DownloaderPage() {
  const { claims, logout, token } = useAuth()

  const [inputUrl, setInputUrl] = useState('')
  const [items, setItems] = useState<DownloadItem[]>([])
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeIds = useRef<Set<string>>(new Set())

  const patch = useCallback((id: string, delta: Partial<DownloadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...delta } : it)))
  }, [])

  const addUrls = useCallback((textOverride?: string) => {
    const raw = (textOverride ?? inputUrl).trim()
    if (!raw) return
    const urls = parseUrls(raw)
    const toAdd = urls.length > 0 ? urls : [raw]
    setItems((prev) => {
      const existingUrls = new Set(prev.map((it) => it.url))
      const newItems = toAdd
        .filter((u) => !existingUrls.has(u))
        .map((u) => ({
          id: uid(),
          url: u,
          label: u,
          status: 'idle' as DownloadStatus,
          downloadProgress: 0,
          convertProgress: 0,
          mode: 'audio' as DownloadMode,
          format: 'mp3' as FormatId,
          bitrate: '192' as Bitrate,
          videoHeight: 2160 as VideoHeight,
        }))
      if (newItems.length === 0) return prev
      return [...prev, ...newItems]
    })
    setInputUrl('')
    inputRef.current?.focus()
  }, [inputUrl])

  // ── Download pipeline ──────────────────────────────────────────────────────

  const handleDownload = useCallback(
    async (item: DownloadItem) => {
      if (item.status === 'downloading' || item.status === 'converting' || item.status === 'done') return
      if (!token) return
      if (activeIds.current.has(item.id)) return
      activeIds.current.add(item.id)

      patch(item.id, { status: 'downloading', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })

      try {
        // ── VIDEO MODE ──────────────────────────────────────────────────────
        if (item.mode === 'video') {
          // Fetch video-only and audio-only streams in parallel
          const [videoRes, audioRes] = await Promise.all([
            apiStreamVideo(token, item.url, item.videoHeight),
            apiStream(token, item.url),
          ])

          const title = extractTitle(videoRes.headers.get('content-disposition'))
          if (title) patch(item.id, { label: title })

          const videoLen = Number(videoRes.headers.get('content-length') ?? '0')
          const audioLen = Number(audioRes.headers.get('content-length') ?? '0')
          const totalLen = videoLen + audioLen

          // Helper: consume a ReadableStream and report progress
          // progressOffset: how many bytes were already counted before this stream
          const readStream = async (
            res: Response,
            onProgress: (received: number) => void,
          ): Promise<Uint8Array> => {
            const reader = res.body!.getReader()
            const chunks: Uint8Array[] = []
            let received = 0
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                chunks.push(value)
                received += value.byteLength
                onProgress(received)
              }
            }
            const total = chunks.reduce((s, c) => s + c.byteLength, 0)
            const buf = new Uint8Array(total)
            let off = 0
            for (const c of chunks) { buf.set(c, off); off += c.byteLength }
            return buf
          }

          // Track combined download progress (video + audio = 0→80%)
          let videoReceived = 0
          let audioReceived = 0
          const updateDownloadProgress = () => {
            if (totalLen > 0) {
              const pct = Math.min(80, ((videoReceived + audioReceived) / totalLen) * 80)
              patch(item.id, { downloadProgress: pct })
            } else {
              setItems((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? { ...it, downloadProgress: Math.min(75, it.downloadProgress + 0.2) }
                    : it,
                ),
              )
            }
          }

          const [videoBuf, audioBuf] = await Promise.all([
            readStream(videoRes, (n) => { videoReceived = n; updateDownloadProgress() }),
            readStream(audioRes, (n) => { audioReceived = n; updateDownloadProgress() }),
          ])

          // Mux with FFmpeg WASM (80→100%)
          patch(item.id, { downloadProgress: 80, status: 'converting', convertProgress: 0 })

          const ff = await acquireFFmpeg()
          const vidName = `vid_${item.id}`
          const audName = `aud_${item.id}`
          const outName = `out_${item.id}.mp4`

          await ff.writeFile(vidName, videoBuf)
          await ff.writeFile(audName, audioBuf)

          const onProg = ({ progress }: { progress: number }) => {
            if (progress >= 0 && progress <= 1) {
              if (!activeIds.current.has(item.id)) return
              patch(item.id, { convertProgress: Math.round(progress * 100) })
            }
          }
          ff.on('progress', onProg)

          // -c copy: no re-encode, just remux video + audio into MP4
          await ff.exec([
            '-i', vidName,
            '-i', audName,
            '-c', 'copy',
            '-movflags', '+faststart',
            outName,
          ])
          ff.off('progress', onProg)

          const out = await ff.readFile(outName)
          const outArray = out instanceof Uint8Array ? out : new Uint8Array(out as unknown as ArrayBuffer)
          const blob = new Blob([outArray as unknown as BlobPart], { type: 'video/mp4' })
          const blobUrl = URL.createObjectURL(blob)
          const a = document.createElement('a')
          const finalLabel = title || item.label
          a.href = blobUrl
          a.download = `${sanitiseFilename(finalLabel)}.mp4`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000)

          try { await ff.deleteFile(vidName) } catch { /* ignore */ }
          try { await ff.deleteFile(audName) } catch { /* ignore */ }
          try { await ff.deleteFile(outName) } catch { /* ignore */ }
          releaseFFmpeg(ff)

          patch(item.id, { status: 'done', downloadProgress: 100, convertProgress: 100, label: title || item.label })
          return
        }

        // ── AUDIO MODE ──────────────────────────────────────────────────────
        const response = await apiStream(token, item.url)
        const title = extractTitle(response.headers.get('content-disposition'))
        if (title) patch(item.id, { label: title })

        const contentLength = Number(response.headers.get('content-length') ?? '0')

        const reader = response.body!.getReader()
        const chunks: Uint8Array[] = []
        let received = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            chunks.push(value)
            received += value.byteLength
            if (contentLength > 0) {
              patch(item.id, { downloadProgress: Math.min(99, (received / contentLength) * 100) })
            } else {
              setItems((prev) =>
                prev.map((it) =>
                  it.id === item.id
                    ? { ...it, downloadProgress: Math.min(90, it.downloadProgress + 0.4) }
                    : it,
                ),
              )
            }
          }
        }

        patch(item.id, { downloadProgress: 100, status: 'converting', convertProgress: 0 })

        const total = chunks.reduce((s, c) => s + c.byteLength, 0)
        const buf = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { buf.set(c, off); off += c.byteLength }

        // ── FFmpeg conversion ───────────────────────────────────────────────
        const fmt = FORMAT_MAP[item.format]
        const ff = await acquireFFmpeg()
        const inputName  = `in_${item.id}`
        const outputName = `out_${item.id}.${fmt.ext}`

        await ff.writeFile(inputName, buf)

        const onProg = ({ progress }: { progress: number }) => {
          if (progress >= 0 && progress <= 1) {
            if (!activeIds.current.has(item.id)) return
            patch(item.id, { convertProgress: Math.round(progress * 100) })
          }
        }
        ff.on('progress', onProg)

        await ff.exec(['-i', inputName, '-vn', ...fmt.args(item.bitrate), outputName])
        ff.off('progress', onProg)

        const out = await ff.readFile(outputName)
        const outArray = out instanceof Uint8Array ? new Uint8Array(out) : out
        const blob = new Blob([outArray as BlobPart], { type: fmt.mime })
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const finalLabel = title || item.label
        a.href = blobUrl
        a.download = `${sanitiseFilename(finalLabel)}.${fmt.ext}`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000)

        try { await ff.deleteFile(inputName)  } catch { /* ignore */ }
        try { await ff.deleteFile(outputName) } catch { /* ignore */ }
        releaseFFmpeg(ff)

        patch(item.id, { status: 'done', convertProgress: 100, label: title || item.label })
      } catch (err) {
        if (isUnauthorizedError(err)) {
          activeIds.current.delete(item.id)
          logout()
          return
        }
        const msg =
          (err as ApiError).message ??
          (err instanceof Error ? err.message : 'Unknown error')
        patch(item.id, { status: 'error', errorMsg: msg })
      } finally {
        activeIds.current.delete(item.id)
      }
    },
    [token, patch, logout],
  )

  const handleDownloadAll = useCallback(() => {
    items.filter((it) => it.status === 'idle').forEach((it) => handleDownload(it))
  }, [items, handleDownload])

  const handleRetryAllFailed = useCallback(() => {
    items
      .filter((it) => it.status === 'error')
      .forEach((it) =>
        handleDownload({ ...it, status: 'idle', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })
      )
  }, [items, handleDownload])

  useEffect(() => { prewarmFFmpeg() }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'v') return
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return
      e.preventDefault()
      navigator.clipboard.readText().then((text) => {
        const trimmed = text.trim()
        if (!trimmed) return
        setInputUrl(trimmed)
        addUrls(trimmed)
      }).catch(() => { inputRef.current?.focus() })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addUrls])

  // ── Clipboard YouTube URL detection ────────────────────────────────────────
  useEffect(() => {
    const check = () => {
      if (!navigator.clipboard?.readText) return
      navigator.clipboard.readText().then((text) => {
        const urls = parseUrls(text.trim())
        if (urls.length > 0) {
          const url = urls[0]
          setClipboardUrl((prev) => (prev === url ? prev : url))
        } else {
          setClipboardUrl(null)
        }
      }).catch(() => { /* permission denied or no text — ignore */ })
    }

    // Also detect via paste event — works in Firefox without clipboard-read permission
    const onPasteGlobal = (e: ClipboardEvent) => {
      const active = document.activeElement
      // Only intercept paste when NOT in an input/textarea (those handle paste themselves)
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return
      const text = (e.clipboardData ?? (window as unknown as { clipboardData?: DataTransfer }).clipboardData)?.getData('text/plain') ?? ''
      const urls = parseUrls(text.trim())
      if (urls.length > 0) {
        const url = urls[0]
        setClipboardUrl((prev) => (prev === url ? prev : url))
      }
    }

    // Check on focus (user switches back to the tab)
    window.addEventListener('focus', check)
    // Also check when tab becomes visible (e.g. switching from another tab)
    const onVisibility = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisibility)
    // Also check when mouse enters the page (catches cases where focus event doesn't fire)
    document.addEventListener('pointerenter', check, { once: false, capture: false })
    // Firefox-compatible: detect paste anywhere on the page
    window.addEventListener('paste', onPasteGlobal)
    // Check once on mount
    check()

    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('pointerenter', check)
      window.removeEventListener('paste', onPasteGlobal)
    }
  }, [])

  // Hide clipboard banner if that URL is already in the list
  const clipboardAlreadyAdded = clipboardUrl != null && items.some((it) => it.url === clipboardUrl)
  const showClipboardBanner = clipboardUrl != null && !clipboardAlreadyAdded

  const handleAddClipboard = useCallback(() => {
    if (!clipboardUrl) return
    addUrls(clipboardUrl)
    setClipboardUrl(null)
  }, [clipboardUrl, addUrls])

  const handleRemove = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  const idleCount   = items.filter((it) => it.status === 'idle').length
  const failedCount = items.filter((it) => it.status === 'error').length

  return (
    <div className="app-root">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />

      <div className="app-inner">
        <header className="topbar">
          <div className="topbar-brand">
            <YoutubeIcon />
            <span>ytdlWeb</span>
          </div>
          <div className="topbar-right">
            <span className="topbar-user">{claims?.username}</span>
            <button className="topbar-logout" onClick={logout} title="Sign out">
              <LogoutIcon />
            </button>
          </div>
        </header>

        <section className="hero">
          <h1 className="hero-title">YouTube Downloader</h1>
          <div className="hero-meta">
            <span className="hero-tag">-Web</span>
            <span className="hero-version">v{APP_VERSION}</span>
          </div>
        </section>

        <div className="input-row">
          <div className="input-wrap">
            <LinkIcon />
            <textarea
              ref={inputRef}
              className="url-input"
              placeholder="Paste YouTube URL(s) here — one per line, comma-separated, or mixed…"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  addUrls()
                }
              }}
              onPaste={(e) => {
                e.preventDefault()
                const text = e.clipboardData.getData('text')
                if (!text.trim()) return
                addUrls(text)
              }}
              rows={1}
              autoFocus
            />
          </div>
          <button className="enter-btn" onClick={() => addUrls()} disabled={!inputUrl.trim()} title="Add">
            <span className="enter-btn-text">Add</span>
            <span className="enter-btn-icon"><PlusIcon /></span>
          </button>
        </div>

        {(idleCount > 1 || failedCount > 0) && (
          <div className="dl-all-row">
            {idleCount > 1 && (
              <button className="dl-all-btn" onClick={handleDownloadAll}>
                <DownloadAllIcon />
                {idleCount}
              </button>
            )}
            {failedCount > 0 && (
              <button className="dl-all-btn dl-all-btn--retry" onClick={handleRetryAllFailed}>
                <RetryIcon />
                Retry All Failed ({failedCount})
              </button>
            )}
          </div>
        )}

        {items.length > 0 && (
          <ul className="dl-list">
            {showClipboardBanner && (
              <li className="dl-item dl-item--clipboard">
                <div className="dl-item-top">
                  <div className="dl-item-label-wrap">
                    <ClipboardIcon />
                    <span className="dl-clipboard-badge">클립보드의 영상</span>
                    <span className="dl-item-label" title={clipboardUrl!}>{clipboardUrl!}</span>
                  </div>
                  <div className="dl-item-actions">
                    <button className="dl-btn dl-btn--clipboard" onClick={handleAddClipboard}>
                      추가
                    </button>
                    <button className="dl-clipboard-dismiss" onClick={() => setClipboardUrl(null)} title="닫기">
                      <DismissIcon />
                    </button>
                  </div>
                </div>
              </li>
            )}
            {items.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                onDownload={handleDownload}
                onRemove={handleRemove}
                onModeChange={(id, mode) => patch(id, { mode })}
                onFormatChange={(id, format) => patch(id, { format })}
                onBitrateChange={(id, bitrate) => patch(id, { bitrate })}
                onVideoHeightChange={(id, videoHeight) => patch(id, { videoHeight })}
              />
            ))}
          </ul>
        )}

        {items.length === 0 && (
          <div className="empty-state">
            {showClipboardBanner && (
              <div className="clipboard-banner">
                <ClipboardIcon />
                <span className="dl-clipboard-badge">클립보드의 영상</span>
                <span className="clipboard-banner-url" title={clipboardUrl!}>{clipboardUrl!}</span>
                <button className="dl-btn dl-btn--clipboard" onClick={handleAddClipboard}>
                  추가
                </button>
                <button className="dl-clipboard-dismiss" onClick={() => setClipboardUrl(null)} title="닫기">
                  <DismissIcon />
                </button>
              </div>
            )}
            <MusicIcon />
            <p>Paste YouTube link(s) above and press <kbd>Ctrl+Enter</kbd></p>
            <p className="empty-hint">Multiple URLs at once — newline, space, comma, or any separator</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── DownloadRow ───────────────────────────────────────────────────────────────

function DownloadRow({
  item,
  onDownload,
  onRemove,
  onModeChange,
  onFormatChange,
  onBitrateChange,
  onVideoHeightChange,
}: {
  item: DownloadItem
  onDownload: (item: DownloadItem) => void
  onRemove: (id: string) => void
  onModeChange: (id: string, mode: DownloadMode) => void
  onFormatChange: (id: string, format: FormatId) => void
  onBitrateChange: (id: string, bitrate: Bitrate) => void
  onVideoHeightChange: (id: string, height: VideoHeight) => void
}) {
  const { status, downloadProgress, convertProgress, label, errorMsg, mode, format, bitrate, videoHeight } = item
  const isActive = status === 'downloading' || status === 'converting'
  const isDone   = status === 'done'
  const isError  = status === 'error'
  const isIdle   = status === 'idle'
  const canEdit  = isIdle || isError

  const fmt = FORMAT_MAP[format]
  const isVideo = mode === 'video'

  const displayProgress = isActive
    ? status === 'downloading'
      ? isVideo
        ? downloadProgress          // video: 0→80 during download
        : downloadProgress * 0.5    // audio: 0→50 during download
      : isVideo
        ? 80 + convertProgress * 0.2  // video: 80→100 during mux
        : 50 + convertProgress * 0.5  // audio: 50→100 during convert
    : isDone ? 100 : 0

  // Phase description for the progress label
  const phaseLabel = status === 'downloading'
    ? isVideo
      ? 'Downloading video + audio…'
      : 'Streaming from server…'
    : isVideo
      ? 'Muxing video + audio…'
      : fmt.lossless
        ? `Converting to ${fmt.label} (lossless)…`
        : `Converting to ${fmt.label} (${bitrate} kbps)…`

  return (
    <li className={`dl-item ${isDone ? 'dl-item--done' : ''} ${isError ? 'dl-item--error' : ''}`}>
      <div className="dl-item-top">
        <div className="dl-item-label-wrap">
          {status === 'downloading' && <PulseIcon color="#60a5fa" />}
          {status === 'converting'  && <PulseIcon color="#a78bfa" />}
          {isDone  && <CheckIcon />}
          {isError && <ErrorIcon />}
          {isIdle  && <IdleIcon />}
          <span className="dl-item-label" title={label}>{label}</span>
        </div>

        <div className="dl-item-actions">
          {/* Mode toggle: Audio / Video */}
          <div className="mode-toggle" role="group" aria-label="Download mode">
            <button
              className={`mode-btn ${!isVideo ? 'mode-btn--active' : ''}`}
              disabled={!canEdit}
              onClick={() => onModeChange(item.id, 'audio')}
              title="Audio"
            >
              <AudioIcon /> Audio
            </button>
            <button
              className={`mode-btn ${isVideo ? 'mode-btn--active' : ''}`}
              disabled={!canEdit}
              onClick={() => onModeChange(item.id, 'video')}
              title="Video"
            >
              <VideoIcon /> Video
            </button>
          </div>

          {/* Audio: format selector */}
          {!isVideo && (
            <select
              className="format-select"
              value={format}
              disabled={!canEdit}
              onChange={(e) => onFormatChange(item.id, e.target.value as FormatId)}
              title="Output format"
            >
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          )}

          {/* Audio: bitrate selector — hidden for lossless formats */}
          {!isVideo && !fmt.lossless && (
            <select
              className="bitrate-select"
              value={bitrate}
              disabled={!canEdit}
              onChange={(e) => onBitrateChange(item.id, e.target.value as Bitrate)}
              title="Audio quality"
            >
              {BITRATE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}

          {/* Video: resolution selector */}
          {isVideo && (
            <select
              className="format-select"
              value={videoHeight}
              disabled={!canEdit}
              onChange={(e) => onVideoHeightChange(item.id, Number(e.target.value) as VideoHeight)}
              title="Video quality"
            >
              {VIDEO_HEIGHT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}

          {/* Download / status button */}
          {!isError && (
            <>
              <span className="dl-actions-spacer" />
              <button
                className={`dl-btn dl-btn--icon ${isDone ? 'dl-btn--done' : ''}`}
                onClick={() => onDownload(item)}
                disabled={isActive || isDone}
                title={isDone ? 'Done' : isActive ? (status === 'downloading' ? 'Streaming…' : 'Converting…') : 'Download'}
              >
                {isDone
                  ? <CheckIcon />
                  : isActive
                    ? <PulseIcon color={status === 'downloading' ? '#60a5fa' : '#a78bfa'} />
                    : <DownloadIcon />}
              </button>
            </>
          )}

          {/* Error: message + Retry */}
          {isError && (
            <>
              <span className="dl-actions-spacer" />
              <span className="dl-error-msg" title={errorMsg}>
                <ErrorIcon />
                Download failed
              </span>
              <button
                className="dl-btn dl-btn--retry"
                onClick={() => onDownload({ ...item, status: 'idle', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })}
              >
                <RetryIcon />
                Retry
              </button>
            </>
          )}

          {/* Remove button */}
          {!isActive && (
            <button
              className="dl-remove-btn"
              onClick={() => onRemove(item.id)}
              title="Remove"
            >
              <DismissIcon />
            </button>
          )}
        </div>
      </div>

      {(isActive || isDone) && (
        <div className="dl-progress-row">
          <div className="dl-progress-track">
            <div
              className={`dl-progress-fill ${isDone ? 'dl-progress-fill--done' : status === 'converting' ? 'dl-progress-fill--converting' : ''}`}
              style={{ width: `${displayProgress}%` }}
            />
          </div>
          <span className={`dl-progress-pct ${isDone ? 'pct--done' : ''}`}>
            {displayProgress.toFixed(1)}%
          </span>
        </div>
      )}

      {isActive && <p className="dl-phase">{phaseLabel}</p>}
    </li>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function YoutubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
      <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58Z" fill="currentColor" opacity=".85"/>
      <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="#111"/>
    </svg>
  )
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="input-icon">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  )
}

function MusicIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}

function IdleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
      <circle cx="12" cy="12" r="10"/>
    </svg>
  )
}

function PulseIcon({ color }: { color: string }) {
  return <span className="pulse-dot" style={{ background: color }} />
}

function RetryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4"/>
    </svg>
  )
}

function DownloadAllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  )
}

function AudioIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

function VideoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"/>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
    </svg>
  )
}

function ClipboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <rect x="9" y="2" width="6" height="4" rx="1"/>
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/>
    </svg>
  )
}

function DismissIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}
