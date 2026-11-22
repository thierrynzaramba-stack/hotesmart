// lib/demandes/mesure.js
// Dette 129, lot 1, etape 0 — MESURER avant d'ecrire. Fonctions PURES : elles
// recoivent ce que Channex et le coeur portent deja, et rendent des nombres.
// Aucun appel reseau ici, aucune ecriture nulle part.
//
// Ce qu'on veut savoir avant de toucher au coeur (docs/specs/spec-demandes-airbnb.md §3) :
//   1. combien de DEMANDES distinctes (fils Channex sans reservation) par bien ;
//   2. combien de fils sont DEVENUS des reservations alors que leurs messages
//      dorment encore sans reservation chez nous ;
//   3. combien de lignes du coeur sans reservation on saura rattacher a un fil
//      par leur identifiant de message ;
//   4. combien de copies webhook (sans identifiant) ont leur jumelle import.
// ⚠ Aucun texte de message ne sort de ce module : il compare les corps pour
// reconnaitre une jumelle, il ne les rend jamais.

// Le moment ou un fil a bouge pour la derniere fois, en millisecondes. Un fil
// sans date est traite comme RECENT : l'ecarter de la mesure serait perdre
// peut-etre une demande, le garder coute un appel.
function instantDuFil (f) {
  const t = f && f.derniere ? Date.parse(f.derniere) : NaN
  return Number.isFinite(t) ? t : Infinity
}

/**
 * Les fils dont on lira les identifiants de messages (un appel par fil, ou plus
 * s'il est long). Toutes les demandes, plus les fils avec reservation qui ont
 * bouge depuis le plus ancien message sans reservation du coeur : seuls ceux-la
 * peuvent porter un message que le coeur a range sans reservation.
 * Le plafond borne le cout ; le depasser se DIT (`tronque`), il ne se tait pas.
 */
function filsADetailler (fils, { depuis = null, max = 60 } = {}) {
  const borne = depuis ? Date.parse(depuis) : NaN
  const candidats = (fils || []).filter(f =>
    !f.booking || !Number.isFinite(borne) || instantDuFil(f) >= borne)
  candidats.sort((a, b) => {
    // Les demandes d'abord : ce sont elles que la mesure doit compter en entier.
    if (!a.booking !== !b.booking) return a.booking ? 1 : -1
    return instantDuFil(b) - instantDuFil(a)
  })
  return { choisis: candidats.slice(0, max), tronque: candidats.length > max, candidats: candidats.length }
}

// Meme instant a la milliseconde : c'est la regle de la reconciliation de
// `recordMessage` (deux « Ok » reels a 45 minutes d'ecart ne sont pas des
// doublons). Un instant illisible ne fait JAMAIS de jumelle.
function memeInstant (a, b) {
  const ta = Date.parse(a), tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

/**
 * @param fils     les fils du bien (lib/channels/channex.js listerFils)
 * @param details  Map filId -> { ok, ids: [ids Channex], complet }
 * @param lignes   lignes du coeur SANS reservation pour ce bien :
 *                 [{ provider_msg_id, direction, sent_at, body }]
 */
function mesurer ({ fils = [], details = new Map(), lignes = [] } = {}) {
  const parId = new Map()
  for (const l of lignes) if (l.provider_msg_id) parId.set(String(l.provider_msg_id), l)

  const filDuMessage = new Map()
  for (const [filId, d] of details) {
    for (const id of (d && d.ids) || []) filDuMessage.set(String(id), filId)
  }

  const demandes = []
  const devenuesResa = []
  let detailIncomplet = 0
  for (const f of fils) {
    const d = details.get(f.id)
    if (d && (!d.ok || !d.complet)) detailIncomplet++
    const chezNous = d ? d.ids.filter(id => parId.has(String(id))).length : null
    if (!f.booking) {
      demandes.push({
        fil: f.id, ota: f.ota, titre: f.titre, ferme: f.ferme, derniere: f.derniere,
        messages_channex: d ? d.ids.length : f.nbMessages,
        chez_nous_sans_resa: chezNous,
        lu: Boolean(d && d.ok),
      })
    } else if (chezNous) {
      devenuesResa.push({ fil: f.id, booking: f.booking, ota: f.ota, chez_nous_sans_resa: chezNous })
    }
  }

  const avecId = lignes.filter(l => l.provider_msg_id)
  const webhook = lignes.filter(l => !l.provider_msg_id)
  const jumelles = webhook.filter(w => avecId.some(i =>
    i.direction === w.direction && memeInstant(i.sent_at, w.sent_at) && String(i.body || '') === String(w.body || '')))

  return {
    fils: {
      total: fils.length,
      sans_resa: fils.filter(f => !f.booking).length,
      avec_resa: fils.filter(f => f.booking).length,
      detail_incomplet: detailIncomplet,
    },
    demandes,
    devenues_resa: devenuesResa,
    lignes_sans_resa: {
      total: lignes.length,
      avec_id: avecId.length,
      avec_id_rattachees: avecId.filter(l => filDuMessage.has(String(l.provider_msg_id))).length,
      avec_id_dans_une_demande: avecId.filter(l => {
        const filId = filDuMessage.get(String(l.provider_msg_id))
        return filId != null && fils.some(f => f.id === filId && !f.booking)
      }).length,
      copies_webhook: webhook.length,
      copies_webhook_avec_jumelle: jumelles.length,
    },
  }
}

module.exports = { filsADetailler, mesurer }
