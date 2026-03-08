import { useState, useRef, useCallback, useEffect } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { useAuth } from '../context/AuthContext'
import { apiStream } from '../lib/api'
import type { ApiError } from '../lib/api'

const APP_VERSION = '0.1.0'

// ── Types ─────────────────────────────────────────────────────────────────────

type DownloadStatus = 'idle' | 'downloading' | 'converting' | 'done' | 'error'

interface DownloadItem {
  id: string
  url: string
  label: string
  status: DownloadStatus
  downloadProgress: number  // 0–100 streaming from server
  convertProgress: number   // 0–100 ffmpeg conversion
  errorMsg?: string
}

// ── FFmpeg singleton ──────────────────────────────────────────────────────────

let ffmpegInstance: FFmpeg | null = null
let ffmpegLoaded = false
let ffmpegLoading = false
let ffmpegLoadCallbacks: Array<(ok: boolean) => void> = []

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance
  if (ffmpegLoading) {
    return new Promise<FFmpeg>((resolve, reject) => {
      ffmpegLoadCallbacks.push((ok) => {
        if (ok && ffmpegInstance) resolve(ffmpegInstance)
        else reject(new Error('FFmpeg load failed'))
      })
    })
  }
  ffmpegLoading = true
  const ff = new FFmpeg()
  try {
    // toBlobURL fetches the file and wraps it in a blob:// URL,
    // completely bypassing Vite's module transform and COEP restrictions.
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
      toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    await ff.load({ coreURL, wasmURL })
    ffmpegInstance = ff
    ffmpegLoaded = true
    ffmpegLoadCallbacks.forEach((cb) => cb(true))
  } catch {
    ffmpegLoadCallbacks.forEach((cb) => cb(false))
    throw new Error('Failed to load FFmpeg WASM')
  } finally {
    ffmpegLoading = false
    ffmpegLoadCallbacks = []
  }
  return ffmpegInstance!
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
  // filename*=UTF-8''...  or  filename="..."
  const m =
    disposition.match(/filename\*=UTF-8''([^;\r\n]+)/i) ??
    disposition.match(/filename=["']?([^"';\r\n]+)/i)
  if (!m) return ''
  return decodeURIComponent(m[1]).replace(/\.[^.]+$/, '').trim()
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DownloaderPage() {
  const { claims, logout } = useAuth()
  const { token } = useAuth()

  const [inputUrl, setInputUrl] = useState('')
  const [items, setItems] = useState<DownloadItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const patch = useCallback((id: string, delta: Partial<DownloadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...delta } : it)))
  }, [])

  const addUrl = useCallback((urlOverride?: string) => {
    const raw = (urlOverride ?? inputUrl).trim()
    if (!raw) return
    setItems((prev) => [
      ...prev,
      { id: uid(), url: raw, label: raw, status: 'idle', downloadProgress: 0, convertProgress: 0 },
    ])
    setInputUrl('')
    inputRef.current?.focus()
  }, [inputUrl])

  // ── Download pipeline ──────────────────────────────────────────────────────

  const handleDownload = useCallback(
    async (item: DownloadItem) => {
      if (item.status === 'downloading' || item.status === 'converting' || item.status === 'done') return
      if (!token) return

      patch(item.id, { status: 'downloading', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })

      try {
        // 1. Request stream from server
        const response = await apiStream(token, item.url)

        // Extract title from Content-Disposition
        const title = extractTitle(response.headers.get('content-disposition'))
        if (title) patch(item.id, { label: title })

        const contentLength = Number(response.headers.get('content-length') ?? '0')

        // 2. Stream + buffer with progress
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

        // 3. Merge chunks
        const total = chunks.reduce((s, c) => s + c.byteLength, 0)
        const buf = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { buf.set(c, off); off += c.byteLength }

        // 4. FFmpeg convert → MP3 192k
        const ff = await getFFmpeg()
        const inputName = `in_${item.id}`
        const outputName = `out_${item.id}.mp3`

        await ff.writeFile(inputName, buf)

        const onProg = ({ progress }: { progress: number }) => {
          if (progress >= 0 && progress <= 1) {
            patch(item.id, { convertProgress: Math.round(progress * 100) })
          }
        }
        ff.on('progress', onProg)

        await ff.exec(['-i', inputName, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', outputName])
        ff.off('progress', onProg)

        // 5. Download blob
        const mp3 = await ff.readFile(outputName)
        // FileData may be Uint8Array<SharedArrayBuffer> — copy to plain ArrayBuffer
        const mp3Array = mp3 instanceof Uint8Array ? new Uint8Array(mp3) : mp3
        const blob = new Blob([mp3Array as BlobPart], { type: 'audio/mpeg' })
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const finalLabel = title || item.label
        a.href = blobUrl
        a.download = `${sanitiseFilename(finalLabel)}.mp3`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000)

        // Cleanup ffmpeg FS
        try { await ff.deleteFile(inputName) } catch { /* ignore */ }
        try { await ff.deleteFile(outputName) } catch { /* ignore */ }

        patch(item.id, { status: 'done', convertProgress: 100, label: title || item.label })
      } catch (err) {
        const msg =
          (err as ApiError).message ??
          (err instanceof Error ? err.message : 'Unknown error')
        patch(item.id, { status: 'error', errorMsg: msg })
      }
    },
    [token, patch],
  )

  // ── Download All: idle + error 항목 순차 실행 ──────────────────────────────
  const handleDownloadAll = useCallback(() => {
    setItems((prev) => {
      const targets = prev.filter(
        (it) => it.status === 'idle' || it.status === 'error',
      )
      targets.forEach((it) => {
        // reset error items before re-queuing
        handleDownload({ ...it, status: 'idle', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })
      })
      return prev
    })
  }, [handleDownload])

  // Pre-warm ffmpeg
  useEffect(() => {
    getFFmpeg().catch(() => {})
  }, [])

  // ── Ctrl+V 전역 감지: 포커스 없어도 URL 붙여넣기 ─────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+V (Windows/Linux) or Cmd+V (Mac)
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'v') return

      // input/textarea에 포커스가 있으면 기본 동작에 맡김
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) return

      e.preventDefault()
      navigator.clipboard.readText().then((text) => {
        const url = text.trim()
        if (!url) return
        // 인풋에 넣고 곧바로 addUrl 트리거
        setInputUrl(url)
        // 다음 렌더 후 addUrl이 최신 inputUrl을 볼 수 있도록 urlOverride 직접 전달
        addUrl(url)
      }).catch(() => {
        // clipboard 권한 없을 경우 input에 포커스만 이동
        inputRef.current?.focus()
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addUrl])

  // ── 버튼 표시 조건 ─────────────────────────────────────────────────────────
  const downloadableCount = items.filter(
    (it) => it.status === 'idle' || it.status === 'error',
  ).length

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      {/* Background blobs */}
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />

      <div className="app-inner">
        {/* ── Top bar ── */}
        <header className="topbar">
          <div className="topbar-brand">
            <YoutubeIcon />
            <span>YouTube Mp3</span>
          </div>
          <div className="topbar-right">
            <span className="topbar-user">{claims?.username}</span>
            <button className="topbar-logout" onClick={logout} title="Sign out">
              <LogoutIcon />
            </button>
          </div>
        </header>

        {/* ── Hero ── */}
        <section className="hero">
          <h1 className="hero-title">YouTube Mp3 Downloader</h1>
          <div className="hero-meta">
            <span className="hero-tag">-Web</span>
            <span className="hero-version">v{APP_VERSION}</span>
          </div>
        </section>

        {/* ── Input ── */}
        <div className="input-row">
          <div className="input-wrap">
            <LinkIcon />
            <input
              ref={inputRef}
              type="text"
              className="url-input"
              placeholder="Paste a YouTube URL here..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addUrl()}
              autoFocus
            />
          </div>
          <button
            className="enter-btn"
            onClick={() => addUrl()}
            disabled={!inputUrl.trim()}
          >
            Add
          </button>
        </div>

        {/* ── Download All 버튼 ── */}
        {downloadableCount > 1 && (
          <div className="dl-all-row">
            <button className="dl-all-btn" onClick={handleDownloadAll}>
              <DownloadAllIcon />
              Download All ({downloadableCount})
            </button>
          </div>
        )}

        {/* ── List ── */}
        {items.length > 0 && (
          <ul className="dl-list">
            {items.map((item) => (
              <DownloadRow key={item.id} item={item} onDownload={handleDownload} />
            ))}
          </ul>
        )}

        {/* ── Empty state ── */}
        {items.length === 0 && (
          <div className="empty-state">
            <MusicIcon />
            <p>Paste a YouTube link above and press <kbd>Enter</kbd></p>
            <p className="empty-hint">Tip: press <kbd>Ctrl+V</kbd> anywhere to add a URL instantly</p>
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
}: {
  item: DownloadItem
  onDownload: (item: DownloadItem) => void
}) {
  const { status, downloadProgress, convertProgress, label, errorMsg } = item
  const isActive = status === 'downloading' || status === 'converting'
  const isDone = status === 'done'
  const isError = status === 'error'

  // Unified display progress
  // downloading: 0–50%, converting: 50–100%
  const displayProgress = isActive
    ? status === 'downloading'
      ? downloadProgress * 0.5
      : 50 + convertProgress * 0.5
    : isDone
    ? 100
    : 0

  return (
    <li className={`dl-item ${isDone ? 'dl-item--done' : ''} ${isError ? 'dl-item--error' : ''}`}>
      <div className="dl-item-top">
        <div className="dl-item-label-wrap">
          {status === 'downloading' && <PulseIcon color="#60a5fa" />}
          {status === 'converting' && <PulseIcon color="#a78bfa" />}
          {isDone && <CheckIcon />}
          {isError && <ErrorIcon />}
          {status === 'idle' && <IdleIcon />}
          <span className="dl-item-label" title={label}>{label}</span>
        </div>

        <div className="dl-item-actions">
          {/* 일반 Download / 진행 중 / Done 버튼 */}
          {!isError && (
            <button
              className={`dl-btn ${isDone ? 'dl-btn--done' : ''}`}
              onClick={() => onDownload(item)}
              disabled={isActive || isDone}
            >
              {isDone ? 'Done' : isActive ? (status === 'downloading' ? 'Streaming…' : 'Converting…') : 'Download'}
            </button>
          )}

          {/* 에러 시: 메시지 + Retry 버튼 */}
          {isError && (
            <>
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
        </div>
      </div>

      {/* Progress bar — shown while active or done */}
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

      {/* Phase label */}
      {isActive && (
        <p className="dl-phase">
          {status === 'downloading' ? 'Streaming from server…' : 'Converting to MP3 (192kbps)…'}
        </p>
      )}
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
  return (
    <span className="pulse-dot" style={{ background: color }} />
  )
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
