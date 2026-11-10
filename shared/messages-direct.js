// shared/messages-direct.js — le fil de Messages se met à jour tout seul.
// Spec : docs/specs/spec-messages-fil-en-direct.md.
//
// Ce module ne touche ni au réseau ni au DOM : il décide QUAND relire et
// COMMENT fondre ce qui arrive dans ce que la page affiche déjà. La page
// (pages/messages.html) fait l'appel et le rendu. Séparés pour que les règles
// qui coûtent — le rythme, l'onglet caché, la page oubliée, les doublons — se
// testent sans navigateur.

// ⚠ LE RYTHME EST UNE DÉCISION DE THIERRY (10 novembre 2026, 01:06) :
// « 5 secondes le fil, le reste ok si c'est pas trop lourd ».
export const RYTHME = Object.freeze({
  filMs: 5000,                    // fil ouvert, onglet affiché
  listeMs: 60000,                 // aucun fil ouvert (la liste seule)
  inactifApresMs: 15 * 60000,     // page oubliée : 15 minutes sans geste…
  inactifMs: 60000,               // …et alors une relecture par minute
  listeAuPlusMs: 60000,           // la liste ne se relit pas plus d'une fois par minute
  repliMs: [20000, 40000, 80000, 120000]   // après 1, 2, 3, 4+ échecs de suite
})

/**
 * Délai avant la prochaine relecture, ou `null` : pas de relecture du tout.
 * ⚠ ONGLET CACHÉ = AUCUN APPEL. C'est la règle qui tient le coût d'une page
 * gardée ouverte toute la journée (demande du chef de file, spec §6).
 */
export function delaiDirect ({ visible, filOuvert, inactifDepuisMs = 0, echecs = 0 } = {}) {
  if (!visible) return null
  let d = !filOuvert ? RYTHME.listeMs
    : inactifDepuisMs >= RYTHME.inactifApresMs ? RYTHME.inactifMs
      : RYTHME.filMs
  if (echecs > 0) {
    const repli = RYTHME.repliMs[Math.min(echecs, RYTHME.repliMs.length) - 1]
    d = Math.max(d, repli)
  }
  return d
}

const instant = (v) => {
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * La liste doit-elle être relue ? Seulement si le serveur annonce un message
 * plus récent que ce que la page connaît, et au plus une fois par minute.
 * Une relecture refusée par le délai n'est pas perdue : `dernierConnu` ne
 * bouge pas, donc la question revient au cycle suivant.
 */
export function listeARelire ({ dernier, dernierConnu, derniereListe = 0, maintenant = Date.now() } = {}) {
  const d = instant(dernier)
  if (d === null) return false
  const connu = instant(dernierConnu)
  if (connu !== null && d <= connu) return false
  return maintenant - derniereListe >= RYTHME.listeAuPlusMs
}

/**
 * Le plus récent des messages VENUS DU SERVEUR (l'heure affichée dans la
 * liste). Une bulle posée par la page après un envoi (`_local`) porte l'heure
 * du navigateur : elle ne compte pas. ⚠ Ce n'est PAS le curseur de la relecture,
 * qui suit l'ordre d'insertion en base (`curseur`, rendu par le serveur).
 */
export function apresDuFil (messages) {
  let max = null
  for (const m of messages || []) {
    if (!m || m._local) continue
    const t = instant(m.sent_at)
    if (t !== null && (max === null || t > max)) max = t
  }
  return max === null ? null : new Date(max).toISOString()
}

const corps = (m) => String((m && m.body) || '').trim()

// ⚠ CINQ MINUTES, ET DEUX HORLOGES (review 1, constat 9) : la bulle locale
// porte l'heure du navigateur, la ligne du cœur celle du serveur. Deux minutes
// laissaient un doublon pour toujours sur un poste décalé de plus. Le prix :
// un même texte renvoyé à moins de cinq minutes peut être pris pour sa
// propre bulle — il disparaît alors jusqu'au cycle qui ramène sa ligne.
export const FENETRE_JUMELLE_MS = 5 * 60000
const jumelles = (local, ligne) => ligne && !ligne._local && ligne.direction === 'outbound'
  && corps(ligne) === corps(local)
  && instant(ligne.sent_at) !== null && instant(local.sent_at) !== null
  && Math.abs(instant(ligne.sent_at) - instant(local.sent_at)) <= FENETRE_JUMELLE_MS

/**
 * La ligne du cœur d'un message que la page s'apprête à poser comme bulle
 * locale est-elle DÉJÀ là ? (Un cycle peut l'avoir ramenée pendant l'envoi.)
 */
export function aDejaSaLigne (messages, texte, maintenant = Date.now()) {
  const local = { direction: 'outbound', body: texte, sent_at: new Date(maintenant).toISOString() }
  return (messages || []).some(m => jumelles(local, m))
}

/**
 * Fond les messages neufs dans ceux du fil, sans doublon.
 * - Une ligne déjà connue (même instant, même sens, même texte) est reconnue.
 * - Un message envoyé depuis la page est déjà affiché (`_local`). Sa ligne du
 *   cœur le REMPLACE au lieu de s'ajouter (spec §2, règle 3).
 * - ⚠ ET DANS LES DEUX ORDRES (review 1, constat 2) : si la ligne du cœur est
 *   arrivée AVANT que la page pose sa bulle, la passe finale retire la bulle
 *   locale jumelle. Sans elle, le doublon restait pour toujours.
 * @returns {{ messages: object[], ajoutes: number, entrants: number, remplaces: number }}
 */
export function fusionnerMessages (existants, nouveaux) {
  let messages = [...(existants || [])]
  let ajoutes = 0, entrants = 0, remplaces = 0
  const tries = [...(nouveaux || [])].sort((a, b) => (instant(a.sent_at) || 0) - (instant(b.sent_at) || 0))
  for (const n of tries) {
    if (!n) continue
    const tn = instant(n.sent_at)
    const deja = messages.some(e => !e._local && e.direction === n.direction
      && instant(e.sent_at) === tn && corps(e) === corps(n))
    if (deja) continue
    if (n.direction === 'outbound') {
      const i = messages.findIndex(e => e._local && jumelles(e, n))
      if (i >= 0) { messages[i] = { ...n }; remplaces++; continue }
    }
    messages.push({ ...n })
    ajoutes++
    if (n.direction === 'inbound') entrants++
  }
  const avant = messages.length
  messages = messages.filter(e => !(e._local && messages.some(l => jumelles(e, l))))
  remplaces += avant - messages.length
  return { messages, ajoutes, entrants, remplaces }
}

const empreinteTache = (x) => [x.id, x.suggested_reply, x.summary, x.send_after,
  x.suspendu_le, x.modifie_le, x.etatEnvoi].join('|')

/**
 * Les propositions en attente telles que le serveur les rend, fondues EN
 * PLACE dans celles que la page tient (review 1, constat 5 : un objet neuf
 * laissait `envoyerProposition` écrire son état sur une copie qui n'était
 * plus à l'écran).
 * - `bookId` : la portée — un fil, ou `null` pour toutes (relecture de la liste).
 * - Une proposition que la page envoie, qui a échoué, ou qui est dans la
 *   saisie reste, même absente de la réponse : c'est la page qui la gère.
 * - `closes` : `Map(identifiant → numéro du retrait par la page)`, et
 *   `lueA` : le numéro de la DEMANDE de la réponse — une horloge logique de
 *   la page, pas `Date.now()`, que le réglage du poste fait reculer (review 3,
 *   constat 3). Une proposition retirée APRÈS cette demande ne revient pas (la
 *   réponse est antérieure au retrait).
 *   ⚠ RETIRÉE AVANT, ELLE REVIENT (review 2, constat 2) : après un 409 « déjà
 *   partie », le cron peut rendre la tâche à l'hôte (envoi non délivré). Une
 *   mémoire sans date la cachait pour toujours — le voyageur n'avait rien
 *   reçu, et l'hôte croyait le contraire.
 * @returns {{ taches: object[], change: boolean }}
 */
export function fusionnerTaches (toutes, bookId, duServeur, enEditionId = null, closes = null, lueA = 0) {
  const dansPortee = (x) => bookId == null || String(x.book_id) === String(bookId)
  const garder = (x) => x.etatEnvoi === 'en_cours' || x.etatEnvoi === 'echec'
    || (enEditionId != null && String(x.id) === String(enEditionId))
  const retireeApres = (id) => closes instanceof Map && closes.has(id) && closes.get(id) >= lueA
  const servies = new Map((duServeur || [])
    .filter(x => x && dansPortee(x) && !retireeApres(String(x.id)))
    .map(x => [String(x.id), x]))
  const taches = []
  let change = false
  for (const x of toutes || []) {
    if (!dansPortee(x)) { taches.push(x); continue }
    const s = servies.get(String(x.id))
    if (s) {
      const avant = empreinteTache(x)
      const etatEnvoi = x.etatEnvoi
      Object.assign(x, s)
      if (etatEnvoi) x.etatEnvoi = etatEnvoi
      if (empreinteTache(x) !== avant) change = true
      taches.push(x)
      servies.delete(String(x.id))
    } else if (garder(x)) taches.push(x)
    else change = true
  }
  for (const s of servies.values()) { taches.push({ ...s }); change = true }
  return { taches, change }
}
