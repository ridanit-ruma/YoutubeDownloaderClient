import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import DownloaderPage from './pages/DownloaderPage'
import AdminPage from './pages/AdminPage'
import './App.css'

function AppRoutes() {
  const { isAuthenticated, claims } = useAuth()
  const path = window.location.pathname

  if (!isAuthenticated) return <LoginPage />

  if (path === '/admin' || path === '/admin/') {
    // Server-side admin routes also require AdminUser — this is a second layer.
    // Non-admin users are silently redirected to the downloader.
    if (!claims?.is_admin) {
      window.location.replace('/')
      return null
    }
    return <AdminPage />
  }

  return <DownloaderPage />
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
