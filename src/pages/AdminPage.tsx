import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import {
  apiListUsers,
  apiCreateUser,
  apiDeleteUser,
  type UserSummary,
  type ApiError,
} from '../lib/api'

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { claims, token, logout } = useAuth()

  const [users, setUsers]       = useState<UserSummary[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  // Create form state
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newIsAdmin, setNewIsAdmin]   = useState(false)
  const [creating, setCreating]       = useState(false)
  const [createMsg, setCreateMsg]     = useState<{ text: string; ok: boolean } | null>(null)

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // ── Fetch users ─────────────────────────────────────────────────────────────

  const fetchUsers = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const list = await apiListUsers(token)
      setUsers(list)
    } catch (e) {
      setError((e as ApiError).message ?? 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  // ── Create user ─────────────────────────────────────────────────────────────

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || !newUsername.trim()) return
    setCreating(true)
    setCreateMsg(null)
    try {
      const res = await apiCreateUser(token, {
        username: newUsername.trim(),
        password: newPassword.trim() || undefined,
        is_admin: newIsAdmin,
        require_password_reset: true,
      })
      const msg = res.generated_password
        ? `Created. Generated password: ${res.generated_password}`
        : `User "${res.username}" created.`
      setCreateMsg({ text: msg, ok: true })
      setNewUsername('')
      setNewPassword('')
      setNewIsAdmin(false)
      await fetchUsers()
    } catch (e) {
      setCreateMsg({ text: (e as ApiError).message ?? 'Failed to create user', ok: false })
    } finally {
      setCreating(false)
    }
  }

  // ── Delete user ─────────────────────────────────────────────────────────────

  const handleDelete = async (id: string, username: string) => {
    if (!token) return
    if (!confirm(`Delete user "${username}"?`)) return
    setDeletingId(id)
    try {
      await apiDeleteUser(token, id)
      await fetchUsers()
    } catch (e) {
      alert((e as ApiError).message ?? 'Failed to delete user')
    } finally {
      setDeletingId(null)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />

      <div className="app-inner">
        {/* Top bar */}
        <header className="topbar">
          <div className="topbar-brand">
            <ShieldIcon />
            <span>Admin</span>
          </div>
          <div className="topbar-right">
            <a href="/" className="admin-back-link">← Downloader</a>
            <span className="topbar-user">{claims?.username}</span>
            <button className="topbar-logout" onClick={logout} title="Sign out">
              <LogoutIcon />
            </button>
          </div>
        </header>

        {/* Hero */}
        <section className="hero">
          <h1 className="hero-title">User Management</h1>
          <div className="hero-meta">
            <span className="hero-tag">-Admin</span>
          </div>
        </section>

        {/* Create user form */}
        <div className="admin-card">
          <h2 className="admin-card-title">Add User</h2>
          <form className="admin-form" onSubmit={handleCreate}>
            <div className="admin-form-row">
              <input
                className="url-input"
                type="text"
                placeholder="Username"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                required
                autoComplete="off"
              />
              <input
                className="url-input"
                type="password"
                placeholder="Password (leave blank to auto-generate)"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              <label className="admin-checkbox-label">
                <input
                  type="checkbox"
                  checked={newIsAdmin}
                  onChange={e => setNewIsAdmin(e.target.checked)}
                />
                Admin
              </label>
              <button className="enter-btn" type="submit" disabled={creating || !newUsername.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
          {createMsg && (
            <p className={`admin-msg ${createMsg.ok ? 'admin-msg--ok' : 'admin-msg--err'}`}>
              {createMsg.text}
            </p>
          )}
        </div>

        {/* User list */}
        <div className="admin-card">
          <h2 className="admin-card-title">Users</h2>
          {loading && <p className="admin-hint">Loading…</p>}
          {error && <p className="admin-msg admin-msg--err">{error}</p>}
          {!loading && !error && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Admin</th>
                  <th>Pwd reset</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={u.id === claims?.sub ? 'admin-row--self' : ''}>
                    <td>{u.username}</td>
                    <td>{u.is_admin ? '✓' : '—'}</td>
                    <td>{u.require_password_reset ? '✓' : '—'}</td>
                    <td>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      {u.id !== claims?.sub && (
                        <button
                          className="admin-delete-btn"
                          onClick={() => handleDelete(u.id, u.username)}
                          disabled={deletingId === u.id}
                        >
                          {deletingId === u.id ? '…' : 'Delete'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
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
