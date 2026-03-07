// ── JWT token storage & parsing ──────────────────────────────────────────────

const TOKEN_KEY = 'yt_jwt'

export interface TokenClaims {
  sub: string
  username: string
  is_admin: boolean
  exp: number
  iat: number
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function parseToken(token: string): TokenClaims | null {
  try {
    const payload = token.split('.')[1]
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(decoded) as TokenClaims
  } catch {
    return null
  }
}

export function isTokenExpired(token: string): boolean {
  const claims = parseToken(token)
  if (!claims) return true
  return Date.now() / 1000 >= claims.exp
}

export function getValidToken(): string | null {
  const token = getToken()
  if (!token) return null
  if (isTokenExpired(token)) {
    clearToken()
    return null
  }
  return token
}
