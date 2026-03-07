import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import type { ApiError } from '../lib/api'

export default function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setLoading(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr.status === 401) {
        setError('Invalid username or password.')
      } else {
        setError(apiErr.message ?? 'Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  function handleUsernameKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      passwordRef.current?.focus()
    }
  }

  return (
    <div className="login-root">
      {/* Ambient glow blobs */}
      <div className="blob blob-1" />
      <div className="blob blob-2" />

      <div className="login-card">
        {/* Logo / title */}
        <div className="login-header">
          <div className="login-icon">
            <YoutubeIcon />
          </div>
          <h1 className="login-title">YouTube Mp3</h1>
          <p className="login-subtitle">Sign in to start downloading</p>
        </div>

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="field-group">
            <label className="field-label" htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoFocus
              className="field-input"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleUsernameKey}
              disabled={loading}
            />
          </div>

          <div className="field-group">
            <label className="field-label" htmlFor="password">Password</label>
            <input
              id="password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              className="field-input"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
          </div>

          {error && (
            <div className="login-error">
              <ErrorIcon />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="login-btn"
            disabled={loading || !username.trim() || !password}
          >
            {loading ? (
              <span className="login-btn-inner">
                <Spinner />
                Signing in…
              </span>
            ) : (
              <span className="login-btn-inner">
                Sign in
                <ArrowIcon />
              </span>
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function YoutubeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="28" height="28">
      <path
        d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58Z"
        fill="currentColor"
        opacity=".9"
      />
      <polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="#0a0a0a" />
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

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/>
      <polyline points="12 5 19 12 12 19"/>
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" strokeOpacity=".25"/>
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/>
    </svg>
  )
}
