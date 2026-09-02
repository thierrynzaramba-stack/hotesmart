import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'
import { ENV } from '/shared/config.js'

export const supabase = createClient(ENV.supabaseUrl, ENV.supabaseKey)

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function signOut() {
  // ⚠ LE COMPTE CHOISI NE SURVIT PAS A LA DECONNEXION. `hs_compte_courant` vit
  // en localStorage, qui traverse les sessions navigateur : sans ce nettoyage,
  // la personne suivante sur ce poste atterrirait sur un compte qu'elle n'a pas
  // choisi — et le garde-fou de changement d'utilisateur est en sessionStorage,
  // donc muet sur une session neuve.
  try {
    const m = await import('/shared/compte-courant.js')
    m.reinitialiser()
  } catch { /* module indisponible : la revalidation au chargement rattrapera */ }
  await supabase.auth.signOut()
  window.location.href = '/pages/login.html'
}