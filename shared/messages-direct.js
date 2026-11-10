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
 * L'instant à partir duquel demander la suite du fil : le plus récent des
 * messages VENUS DU SERVEUR. Une bulle posée par la page après un envoi
 * (`_local`) porte l'heure du navigateur, qui peut avancer sur celle du
 * serveur : s'en servir ferait sauter des messages.
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

/**
 * Fond les messages neufs dans ceux du fil, sans doublon.
 * - Le serveur rend les messages À PARTIR de l'instant demandé (`>=`) : celui
 *   qu'on connaît déjà revient, et il est reconnu (même instant, même sens,
 *   même texte).
 * - Un message envoyé depuis la page est déjà affiché (`_local`). Sa ligne du
 *   cœur le REMPLACE au lieu de s'ajouter : même sens sortant, même texte, à
 *   moins de deux minutes d'écart (spec §2, règle 3).
 * @returns {{ messages: object[], ajoutes: number, entrants: number, remplaces: number }}
 */
export function fusionnerMessages (existants, nouveaux) {
  const messages = [...(existants || [])]
  let ajoutes = 0, entrants = 0, remplaces = 0
  const tries = [...(nouveaux || [])].sort((a, b) => (instant(a.sent_at) || 0) - (instant(b.sent_at) || 0))
  for (const n of tries) {
    if (!n) continue
    const tn = instant(n.sent_at)
    const deja = messages.some(e => !e._local && e.direction === n.direction
      && instant(e.sent_at) === tn && corps(e) === corps(n))
    if (deja) continue
    if (n.direction === 'outbound') {
      const i = messages.findIndex(e => e._local && e.direction === 'outbound' && corps(e) === corps(n)
        && tn !== null && instant(e.sent_at) !== null && Math.abs(instant(e.sent_at) - tn) <= 120000)
      if (i >= 0) { messages[i] = { ...n }; remplaces++; continue }
    }
    messages.push({ ...n })
    ajoutes++
    if (n.direction === 'inbound') entrants++
  }
  return { messages, ajoutes, entrants, remplaces }
}

/**
 * Les propositions en attente du fil, telles que le serveur les rend, fondues
 * dans celles que la page tient. Une proposition que la page est en train
 * d'envoyer, qui a échoué, ou qui est descendue dans la saisie reste à l'écran
 * même si le serveur ne la rend plus : c'est la page qui la gère, pas le cycle.
 * @returns {{ taches: object[], change: boolean }}
 */
export function fusionnerTaches (toutes, bookId, duServeur, enEditionId = null) {
  const cle = String(bookId)
  const garder = (x) => x.etatEnvoi === 'en_cours' || x.etatEnvoi === 'echec'
    || (enEditionId != null && String(x.id) === String(enEditionId))
  const autres = (toutes || []).filter(x => String(x.book_id) !== cle)
  const avant = (toutes || []).filter(x => String(x.book_id) === cle)
  const servies = new Map((duServeur || []).map(x => [String(x.id), x]))
  const resultat = []
  for (const x of avant) {
    const s = servies.get(String(x.id))
    if (s) { resultat.push({ ...s, ...(x.etatEnvoi ? { etatEnvoi: x.etatEnvoi } : {}) }); servies.delete(String(x.id)) }
    else if (garder(x)) resultat.push(x)
  }
  for (const s of servies.values()) resultat.push({ ...s })
  const empreinte = (l) => l.map(x => [x.id, x.suggested_reply, x.send_after, x.suspendu_le, x.etatEnvoi].join('|')).sort().join('#')
  return { taches: [...autres, ...resultat], change: empreinte(avant) !== empreinte(resultat) }
}
