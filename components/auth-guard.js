import { getSession } from '../shared/supabase.js'

export async function requireAuth() {
  const session = await getSession()
  if (!session) {
    window.location.href = '/login.html'
    return null
  }
  return session
}