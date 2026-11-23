// shared/langue-personne.js — enregistrer la langue de la PERSONNE (PWA lot 2b).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §7 et §15.7 · KB : docs/kb/pwa.md §9
//
// Ses notifications lui arriveront dans cette langue. Appelé par le sélecteur
// de langue du menu ≡ (shared/nav.js), et SEULEMENT sur ce geste : aucun appel
// au chargement d'une page (budget de la case performance, §10.7).
//
// ⚠ UN MODULE À PART, chargé à la demande : shared/push-appareil.js ne lit pas
// la session (chaque appelant lui passe son jeton), et shared/nav.js est un
// script classique qui ne charge pas Supabase.
import { supabase } from '/shared/supabase.js'
import { enregistrerLangue } from '/shared/push-appareil.js'

export async function enregistrer (code) {
  const { data } = await supabase.auth.getSession()
  const jeton = data && data.session && data.session.access_token
  // Sans session (la page de connexion a aussi le sélecteur), il n'y a personne
  // à qui l'enregistrer : la langue reste celle de cet appareil.
  if (!jeton) return { ok: false, motif: 'sans_session' }
  return enregistrerLangue(jeton, code)
}
