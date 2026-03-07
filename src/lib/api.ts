// ── API client ────────────────────────────────────────────────────────────────

const BASE = '/api'

export interface LoginResponse {
  token: string
  require_password_reset: boolean
}

export interface ApiError {
  status: number
  code: string
  message: string
}

// Generic fetch wrapper
async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      // Server wraps errors as { error: { code, message } }
      const errObj = body?.error ?? body
      code = errObj.code ?? code
      message = errObj.message ?? message
    } catch { /* ignore */ }
    const err: ApiError = { status: res.status, code, message }
    throw err
  }
  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function apiLogin(
  username: string,
  password: string,
): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function apiChangePassword(
  token: string,
  current_password: string,
  new_password: string,
): Promise<void> {
  await request('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password, new_password }),
  }, token)
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface UserSummary {
  id: string
  username: string
  is_admin: boolean
  require_password_reset: boolean
  created_at: string
  updated_at: string
}

export interface CreateUserRequest {
  username: string
  password?: string
  is_admin?: boolean
  require_password_reset?: boolean
}

export interface CreateUserResponse extends UserSummary {
  generated_password?: string
}

export async function apiListUsers(token: string): Promise<UserSummary[]> {
  return request<UserSummary[]>('/admin/users', {}, token)
}

export async function apiCreateUser(
  token: string,
  body: CreateUserRequest,
): Promise<CreateUserResponse> {
  return request<CreateUserResponse>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  }, token)
}

export async function apiDeleteUser(token: string, id: string): Promise<void> {
  await request(`/admin/users/${id}`, { method: 'DELETE' }, token)
}

// ── Stream ────────────────────────────────────────────────────────────────────

/**
 * Returns the raw Response for the audio stream.
 * Caller is responsible for consuming response.body.
 */
export async function apiStream(token: string, url: string): Promise<Response> {
  const res = await fetch(`${BASE}/stream?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      // Server wraps errors as { error: { code, message } }
      const errObj = body?.error ?? body
      code = errObj.code ?? code
      message = errObj.message ?? message
    } catch { /* ignore */ }
    const err: ApiError = { status: res.status, code, message }
    throw err
  }
  return res
}
