import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = document.querySelector('meta[name="supabase-url"]')?.content
const supabaseKey = document.querySelector('meta[name="supabase-key"]')?.content

export const supabase = createClient(supabaseUrl, supabaseKey)

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function signOut() {
  await supabase.auth.signOut()
  window.location.href = '/login.html'
}