/* ============================================================
   HôteSmart — shared/cache-ecran.js
   L'AFFICHAGE INSTANTANÉ : les dernières données connues d'un écran.

   Principe 3 de docs/specs/spec-performance-pages.md : « les dernières
   données sont gardées côté navigateur (clé = utilisateur + compte, effacées
   à la déconnexion), rafraîchies en arrière-plan ».

   ⚠ LA CLÉ PORTE L'UTILISATEUR *ET* LE COMPTE, ET C'EST UNE GARDE.
   Le sélecteur de compte permet à un membre délégué de passer d'un compte à
   l'autre dans le même navigateur. Une clé qui n'en porterait qu'un afficherait
   les chiffres du compte précédent — une fuite entre comptes, dans un produit
   qui a déjà fermé dix fuites de ce type (docs/kb/profils-et-droits.md §12).

   ⚠ TROIS ÉTATS CRITIQUES NE SONT JAMAIS GARDÉS : codes d'accès, paiements,
   surréservation. C'est l'interdit 2 de la spec, et il n'est pas négociable —
   un code affiché depuis le cache ferait croire à l'hôte qu'un voyageur l'a
   reçu. Le reste de l'écran peut s'afficher instantanément ; ces trois-là
   attendent la réponse du serveur. Les champs concernés sont RETIRÉS à
   l'écriture, pas filtrés à la lecture : ce qui n'est pas écrit ne peut pas
   fuiter par un lecteur distrait.

   ⚠ ET IL NE SERT JAMAIS DE DONNÉES PÉRIMÉES SANS LE DIRE. `lire()` rend
   `{ donnees, age_ms }` : l'écran sait l'âge de ce qu'il affiche, et peut le
   montrer. Un chiffre dont personne ne connaît l'âge est un chiffre faux en
   puissance.
   ============================================================ */

// Les blocs qu'on ne garde JAMAIS. Interdit 2 de la spec.
const JAMAIS_GARDES = ['etats_arrivee', 'alarmes']

// Au-delà, on n'affiche plus : une page ouverte depuis la veille montrerait
// des arrivées d'hier comme celles du jour.
const PEREMPTION_MS = 12 * 60 * 60 * 1000

// `localStorage` survit à l'onglet, ce qui est tout l'intérêt de l'affichage
// instantané : la deuxième visite de la journée doit être immédiate. La
// contrepartie est l'effacement explicite à la déconnexion.
const PREFIXE = 'hs.ecran.'

function cle (ecran, moi, compte) {
  if (!ecran || !moi || !compte) return null
  return `${PREFIXE}${ecran}.${moi}.${compte}`
}

function sansLesCritiques (donnees) {
  if (!donnees || typeof donnees !== 'object') return donnees
  const out = {}
  for (const [k, v] of Object.entries(donnees)) {
    if (JAMAIS_GARDES.includes(k)) continue
    out[k] = v
  }
  return out
}

export function ecrire (ecran, moi, compte, donnees) {
  const k = cle(ecran, moi, compte)
  if (!k) return false
  try {
    localStorage.setItem(k, JSON.stringify({ ts: Date.now(), donnees: sansLesCritiques(donnees) }))
    return true
  } catch { return false }   // quota, navigation privée : on s'en passe
}

export function lire (ecran, moi, compte) {
  const k = cle(ecran, moi, compte)
  if (!k) return null
  try {
    const brut = localStorage.getItem(k)
    if (!brut) return null
    const o = JSON.parse(brut)
    if (!o || !o.donnees) return null
    const age = Date.now() - Number(o.ts)
    // ⚠ L'ÉCART DOIT ÊTRE POSITIF. Une horloge en avance puis corrigée en
    // arrière donnerait un âge négatif, donc « toujours frais » — le même
    // défaut qu'un constat de review a trouvé sur le cache du contexte de
    // compte.
    if (!(age >= 0 && age < PEREMPTION_MS)) return null
    return { donnees: o.donnees, age_ms: age }
  } catch { return null }
}

// À appeler à la déconnexion. Efface TOUS les écrans, de TOUS les comptes :
// la personne suivante sur ce poste ne doit rien retrouver.
export function oublierTout () {
  try {
    const aJeter = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIXE)) aJeter.push(k)
    }
    aJeter.forEach(k => localStorage.removeItem(k))
    return aJeter.length
  } catch { return 0 }
}

export const _interne = { JAMAIS_GARDES, PEREMPTION_MS, PREFIXE, cle, sansLesCritiques }
