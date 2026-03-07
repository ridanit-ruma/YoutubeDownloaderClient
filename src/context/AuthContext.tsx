import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { apiLogin } from '../lib/api'
import {
  saveToken,
  clearToken,
  getValidToken,
  parseToken,
  type TokenClaims,
} from '../lib/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthState {
  token: string | null
  claims: TokenClaims | null
  requirePasswordReset: boolean
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  isAuthenticated: boolean
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = getValidToken()
    return {
      token,
      claims: token ? parseToken(token) : null,
      requirePasswordReset: false,
    }
  })

  // Re-validate token on focus (tab switch, etc.)
  useEffect(() => {
    const handleFocus = () => {
      if (state.token && !getValidToken()) {
        setState({ token: null, claims: null, requirePasswordReset: false })
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [state.token])

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiLogin(username, password)
    saveToken(res.token)
    const claims = parseToken(res.token)
    setState({
      token: res.token,
      claims,
      requirePasswordReset: res.require_password_reset,
    })
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setState({ token: null, claims: null, requirePasswordReset: false })
  }, [])

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        logout,
        isAuthenticated: !!state.token,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
