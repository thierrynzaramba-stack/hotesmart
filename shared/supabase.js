import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm'
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
  // ⚠ ET LE CACHE D'AFFICHAGE INSTANTANÉ DES ÉCRANS. Il vit en `localStorage`,
  // qui traverse les sessions navigateur : sans ce nettoyage, la personne
  // suivante sur ce poste verrait, le temps d'un battement, les chiffres de la
  // précédente — ses logements, ses tâches, ses notes. C'est la contrepartie
  // explicite du choix de `localStorage` plutôt que `sessionStorage` (principe 3
  // de docs/specs/spec-performance-pages.md : la deuxième visite de la journée
  // doit être immédiate, donc le cache survit à l'onglet).
  try {
    const c = await import('/shared/cache-ecran.js')
    c.oublierTout()
  } catch { /* module indisponible : la péremption de 12 h rattrapera */ }
  await supabase.auth.signOut()
  window.location.href = '/pages/login.html'
}