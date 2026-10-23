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

   ⚠ CINQ BLOCS ET UN CHAMP NE SONT JAMAIS GARDÉS : codes d'accès, paiements,
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
//
// ⚠ `taches` A ETE AJOUTE PAR LA REVIEW, ET C'EST LE CONSTAT LE PLUS CHER DE
// CE LOT. Je gardais `taches` en pensant que c'etait de la charge de travail,
// pas un état critique. Une tâche d'arrivée PORTE LE CODE D'ACCES EN CLAIR :
// `lib/cron-arrival-code.js` écrit `summary: "Code d'accès généré pour <nom> :
// <code> — …"` et `suggested_reply: <le message d'arrivée rendu>`, tous deux en
// `status: 'pending_validation'`, donc tous deux lus par l'appel d'écran et
// rendus par la carte. Le code du voyageur partait donc dans le
// `localStorage` pour 12 h, et se repeignait au premier affichage même si la
// serrure avait été re-codée depuis — exactement l'interdit que la bannière
// ci-dessus appelle non négociable, et le motif qu'elle cite : « un code
// affiché depuis le cache ferait croire à l'hôte qu'un voyageur l'a reçu ».
//
// ⚠ ET `arrivees` / `conversations` SORTENT AUSSI, par la §5.1 de la spec, que
// le même commit a écrite : « Réservations, disponibilités | non » et
// « Messages, propositions | non | un fil périmé fait répondre deux fois ».
// `arrivees` portait en plus le snapshot intégral du voyageur (courriel,
// téléphone, nom, montant) — l'endpoint ne le rend plus du tout.
//
// ⚠ `arrivees` EST UNE CEINTURE : l'endpoint ne rend plus ce bloc du tout
// (il rend `arrivees_nombre`, un compte). On le garde dans la liste pour le
// jour où quelqu'un le remettrait.
//
// Ce qu'il reste à garder, et c'est l'essentiel du premier affichage : la
// LISTE DES BIENS avec leurs photos, les notes, et les quatre compteurs de
// « Fait pour vous », tous à l'échelle de la semaine ou du mois. Rien qui
// périme en une heure, rien qu'un hôte puisse prendre pour un fait du jour.
const JAMAIS_GARDES = ['etats_arrivee', 'alarmes', 'taches', 'arrivees', 'conversations']

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

// ⚠ ET UN CHAMP À L'INTÉRIEUR D'UN BLOC, PARCE QU'UN BLOC NE SUFFIT PAS.
// L'interdit 2 nomme trois états : codes d'accès, paiements, SURRÉSERVATION.
// Retirer `alarmes` ne suffisait pas : `fait_pour_vous.surreservation` est le
// compte des incidents `overbooking` des 7 derniers jours, et il était gardé —
// donc repeint instantanément, jusqu'à 12 h périmé. C'est la même famille que
// `taches` : j'ai raisonné par BLOC alors que la donnée critique vit dans un
// CHAMP. Et mon propre test gravait l'omission en contrat.
const CHAMPS_JAMAIS_GARDES = { fait_pour_vous: ['surreservation'] }

function sansLesCritiques (donnees) {
  if (!donnees || typeof donnees !== 'object') return donnees
  const out = {}
  for (const [k, v] of Object.entries(donnees)) {
    if (JAMAIS_GARDES.includes(k)) continue
    const champs = CHAMPS_JAMAIS_GARDES[k]
    if (champs && v && typeof v === 'object' && !Array.isArray(v)) {
      const bloc = {}
      for (const [ck, cv] of Object.entries(v)) if (!champs.includes(ck)) bloc[ck] = cv
      out[k] = bloc
      continue
    }
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

export const _interne = { JAMAIS_GARDES, CHAMPS_JAMAIS_GARDES, PEREMPTION_MS, PREFIXE, cle, sansLesCritiques }
