import { useState, useRef, useCallback, useEffect } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { useAuth } from '../context/AuthContext'
import { apiStream, isUnauthorizedError } from '../lib/api'
import type { ApiError } from '../lib/api'

const APP_VERSION = '0.1.0'

// ── Types ─────────────────────────────────────────────────────────────────────

type DownloadStatus = 'idle' | 'downloading' | 'converting' | 'done' | 'error'
type Bitrate = '64' | '128' | '192' | '320'

const BITRATE_OPTIONS: { value: Bitrate; label: string }[] = [
  { value: '64',  label: '64 kbps' },
  { value: '128', label: '128 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '320', label: '320 kbps' },
]

interface DownloadItem {
  id: string
  url: string
  label: string
  status: DownloadStatus
  downloadProgress: number  // 0–100 streaming from server
  convertProgress: number   // 0–100 ffmpeg conversion
  bitrate: Bitrate
  errorMsg?: string
}

// ── FFmpeg instance pool ──────────────────────────────────────────────────────
// Each concurrent conversion needs its own FFmpeg WASM instance because a
// single instance can only run one `exec` at a time. We load the core/wasm
// blobs once and reuse them for every new instance to avoid redundant network
// fetches.

const BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'

// Resolved once, then reused for all instances.
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

// Pool of idle instances ready to be acquired.
const idlePool: FFmpeg[] = []

async function acquireFFmpeg(): Promise<FFmpeg> {
  await loadCoreURLs()
  if (idlePool.length > 0) {
    return idlePool.pop()!
  }
  // Spin up a fresh instance.
  const ff = new FFmpeg()
  await ff.load({ coreURL: coreURLCache!, wasmURL: wasmURLCache! })
  return ff
}

function releaseFFmpeg(ff: FFmpeg): void {
  idlePool.push(ff)
}

// Pre-warm: load URLs and one idle instance in the background.
async function prewarmFFmpeg(): Promise<void> {
  try {
    const ff = await acquireFFmpeg()
    releaseFFmpeg(ff)
  } catch { /* ignore */ }
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

/**
 * 텍스트에서 YouTube URL을 모두 추출한다.
 *
 * 지원 형태 (구분자 무관):
 *   - 줄바꿈, 스페이스, 탭, 콤마, 세미콜론, 파이프, 대괄호, 따옴표 등 어떤 구분자도 OK
 *   - https://www.youtube.com/watch?v=...
 *   - https://youtu.be/...
 *   - https://youtube.com/shorts/...
 *   - https://m.youtube.com/watch?v=...
 *   - 위 모두의 http:// 변형
 *
 * URL 파라미터(playlist, timestamp 등)는 그대로 보존한다.
 */
function parseUrls(text: string): string[] {
  // YouTube URL 전체를 탐욕적으로 매칭.
  // 공백/쉼표/괄호/따옴표 류를 URL 종단으로 취급한다.
  const RE =
    /https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s,;"'<>\[\]{}|\\^`]+|shorts\/[^\s,;"'<>\[\]{}|\\^`]+|embed\/[^\s,;"'<>\[\]{}|\\^`]+)|youtu\.be\/[^\s,;"'<>\[\]{}|\\^`]+)/gi

  const found = text.match(RE) ?? []

  // 후행 구두점(마침표, 닫는 괄호 등) 제거
  const cleaned = found.map((u) => u.replace(/[.,;:!?)]+$/, ''))

  // 중복 제거 (순서 유지)
  return [...new Set(cleaned)]
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DownloaderPage() {
  const { claims, logout, token } = useAuth()

  const [inputUrl, setInputUrl] = useState('')
  const [items, setItems] = useState<DownloadItem[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Tracks IDs that are actively being processed to prevent duplicate runs
  // (e.g. React Strict Mode double-invocation).
  const activeIds = useRef<Set<string>>(new Set())

  const patch = useCallback((id: string, delta: Partial<DownloadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...delta } : it)))
  }, [])

  /**
   * 입력 텍스트에서 YouTube URL을 파싱해 리스트에 추가한다.
   * 단일 URL이든, 여러 URL이 섞인 텍스트 블록이든 모두 처리한다.
   */
  const addUrls = useCallback((textOverride?: string) => {
    const raw = (textOverride ?? inputUrl).trim()
    if (!raw) return

    const urls = parseUrls(raw)

    // URL 패턴이 하나도 없으면 입력 전체를 URL로 간주 (비표준 URL 대비)
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
          bitrate: '192' as Bitrate,
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
      // Prevent duplicate concurrent runs for the same item id (Strict Mode, double-click, etc.)
      if (activeIds.current.has(item.id)) return
      activeIds.current.add(item.id)

      patch(item.id, { status: 'downloading', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })

      try {
        // 1. Request stream from server
        const response = await apiStream(token, item.url)
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

        // 4. FFmpeg convert → MP3 at selected bitrate
        const ff = await acquireFFmpeg()
        const inputName = `in_${item.id}`
        const outputName = `out_${item.id}.mp3`

        await ff.writeFile(inputName, buf)

        const onProg = ({ progress }: { progress: number }) => {
          if (progress >= 0 && progress <= 1) {
            // Guard: don't overwrite a completed item's progress with a new conversion's events.
            if (!activeIds.current.has(item.id)) return
            patch(item.id, { convertProgress: Math.round(progress * 100) })
          }
        }
        ff.on('progress', onProg)

        await ff.exec(['-i', inputName, '-vn', '-c:a', 'libmp3lame', '-b:a', `${item.bitrate}k`, '-f', 'mp3', outputName])
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
        releaseFFmpeg(ff)

        patch(item.id, { status: 'done', convertProgress: 100, label: title || item.label })
      } catch (err) {
        // 401 Unauthorized → token expired or revoked; log out immediately
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

  // ── Download All: idle 항목 전부 ──────────────────────────────────────────
  const handleDownloadAll = useCallback(() => {
    const targets = items.filter((it) => it.status === 'idle')
    targets.forEach((it) => handleDownload(it))
  }, [items, handleDownload])

  // ── Retry All Failed: error 항목 전부 재시도 ─────────────────────────────
  const handleRetryAllFailed = useCallback(() => {
    const targets = items.filter((it) => it.status === 'error')
    targets.forEach((it) =>
      handleDownload({ ...it, status: 'idle', downloadProgress: 0, convertProgress: 0, errorMsg: undefined })
    )
  }, [items, handleDownload])

  // Pre-warm ffmpeg
  useEffect(() => {
    prewarmFFmpeg()
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
        const trimmed = text.trim()
        if (!trimmed) return
        setInputUrl(trimmed)
        addUrls(trimmed)
      }).catch(() => {
        inputRef.current?.focus()
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addUrls])

  // ── 버튼 표시 조건 ─────────────────────────────────────────────────────────
  const idleCount   = items.filter((it) => it.status === 'idle').length
  const failedCount = items.filter((it) => it.status === 'error').length

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
            <textarea
              ref={inputRef}
              className="url-input"
              placeholder="Paste YouTube URL(s) here — one per line, comma-separated, or mixed…"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl+Enter or Cmd+Enter → add (일반 Enter는 줄바꿈 허용)
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  addUrls()
                }
              }}
              onPaste={(e) => {
                // 붙여넣기 시 즉시 파싱 & 추가
                e.preventDefault()
                const text = e.clipboardData.getData('text')
                if (!text.trim()) return
                addUrls(text)
              }}
              rows={1}
              autoFocus
            />
          </div>
          <button
            className="enter-btn"
            onClick={() => addUrls()}
            disabled={!inputUrl.trim()}
          >
            Add
          </button>
        </div>

        {/* ── Action buttons row ── */}
        {(idleCount > 1 || failedCount > 0) && (
          <div className="dl-all-row">
            {idleCount > 1 && (
              <button className="dl-all-btn" onClick={handleDownloadAll}>
                <DownloadAllIcon />
                Download All ({idleCount})
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

        {/* ── List ── */}
        {items.length > 0 && (
          <ul className="dl-list">
            {items.map((item) => (
              <DownloadRow
                key={item.id}
                item={item}
                onDownload={handleDownload}
                onBitrateChange={(id, bitrate) => patch(id, { bitrate })}
              />
            ))}
          </ul>
        )}

        {/* ── Empty state ── */}
        {items.length === 0 && (
          <div className="empty-state">
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
  onBitrateChange,
}: {
  item: DownloadItem
  onDownload: (item: DownloadItem) => void
  onBitrateChange: (id: string, bitrate: Bitrate) => void
}) {
  const { status, downloadProgress, convertProgress, label, errorMsg, bitrate } = item
  const isActive = status === 'downloading' || status === 'converting'
  const isDone = status === 'done'
  const isError = status === 'error'
  const isIdle = status === 'idle'

  // Bitrate selector는 idle 또는 error 상태에서만 활성화
  const canChangeBitrate = isIdle || isError

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
          {isIdle && <IdleIcon />}
          <span className="dl-item-label" title={label}>{label}</span>
        </div>

        <div className="dl-item-actions">
          {/* 음질 선택 */}
          <select
            className="bitrate-select"
            value={bitrate}
            disabled={!canChangeBitrate}
            onChange={(e) => onBitrateChange(item.id, e.target.value as Bitrate)}
            title="Audio quality"
          >
            {BITRATE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

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
          {status === 'downloading' ? 'Streaming from server…' : `Converting to MP3 (${bitrate}kbps)…`}
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
