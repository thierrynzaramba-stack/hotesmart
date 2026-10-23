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

// TOUT CE QUI SURVIT A L'ONGLET, EFFACE EN UN SEUL GESTE.
//
// ⚠ UN GESTE PARTAGE, PARCE QUE LE RECOPIER A DEJA RATE. Deux caches vivent en
// `localStorage` — le compte choisi (`hs_compte_courant`) et l'affichage
// instantane des ecrans (`hs.ecran.*`) —, et il existe CINQ endroits qui
// ferment une session : cette fonction, le changement d'utilisateur de
// `components/auth-guard.js`, la suppression de compte de `pages/compte.html`,
// et les DEUX boutons de `pages/invitation.html` (« rejoindre » et « ce n'est
// pas moi »). La review a compte : le cache d'ecran n'etait efface que par
// cette fonction, `compte.html` n'effacait que la moitie ecran, et
// « ce n'est pas moi » n'effacait rien du tout. Chaque recopie oubliait une
// moitie differente.
//
// Pourquoi ca compte : la personne suivante sur ce poste atterrirait sur un
// compte qu'elle n'a pas choisi, et les chiffres de la precedente resteraient
// sur le disque — jusqu'a 12 h, ou indefiniment, puisqu'une cle perimee est
// refusee a la lecture mais n'est pas effacee. Le garde-fou de changement
// d'utilisateur est en `sessionStorage`, donc muet sur une session neuve.
export async function purgerCachesLocaux() {
  try {
    const m = await import('/shared/compte-courant.js')
    m.reinitialiser()
  } catch { /* module indisponible : la revalidation au chargement rattrapera */ }
  try {
    const c = await import('/shared/cache-ecran.js')
    c.oublierTout()
  } catch { /* module indisponible : la péremption de 12 h rattrapera */ }
}

export async function signOut() {
  await purgerCachesLocaux()
  await supabase.auth.signOut()
  window.location.href = '/pages/login.html'
}