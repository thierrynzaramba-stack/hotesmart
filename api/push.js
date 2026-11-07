// api/push.js — les notifications push de l'appli hôte (PWA lot 2a).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §9.2 · KB : docs/kb/pwa.md §8
//
//   GET    /api/push                              → { pret, cle_publique, appareils }
//   POST   /api/push { action: 'abonner', abonnement, appareil }
//   POST   /api/push { action: 'essai' }          → une notification sur MES appareils
//   DELETE /api/push { endpoint } | { id }        → retirer un de MES appareils
//
// ⚠ LA GARDE EST LA PERSONNE CONNECTÉE, SUR SES PROPRES APPAREILS. Aucun compte,
// aucun bien n'entre ici : un abonnement appartient à une personne, et chaque
// lecture comme chaque écriture est restreinte à `user_id = appelant`. Le
// sélecteur de compte n'y change rien (pas d'`x-compte`).
//
// ⚠ `private, no-store` AVANT LE PREMIER REFUS, 405 compris (dette 90). La clé
// publique n'est pas secrète, mais elle n'est demandée qu'au moment d'un geste,
// par quelqu'un de connecté : pas de raison d'en faire un endpoint public.
const { verifierSession, posterEnTetesPrives } = require('../lib/require-permission')
const abonnements = require('../lib/push/abonnements')
const { clesVapid, messageDeclaratif, envoyerAPersonne } = require('../lib/push/envoyer')

const MESSAGES_REFUS = {
  abonnement_absent: 'Abonnement manquant.',
  adresse_refusee: 'Ce navigateur utilise un service de notifications inconnu.',
  cle_p256dh_invalide: 'Abonnement illisible.',
  cle_auth_invalide: 'Abonnement illisible.',
  plafond_atteint: `Vous avez déjà ${abonnements.PLAFOND_APPAREILS} appareils abonnés : retirez-en un d'abord.`,
  cible_absente: 'Appareil non précisé.'
}

function corpsDe (req) {
  const b = req.body
  if (b && typeof b === 'object') return b
  if (typeof b === 'string' && b) { try { return JSON.parse(b) } catch { return {} } }
  return {}
}

module.exports = async function handler (req, res) {
  posterEnTetesPrives(res)
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE')
    return res.status(405).json({ error: 'methode non autorisee' })
  }
  const userId = await verifierSession(req, res)
  if (!userId) return

  const cles = clesVapid()

  try {
    if (req.method === 'GET') {
      const r = await abonnements.lister({ userId })
      if (!r.ok) return res.status(503).json({ error: 'Lecture impossible, réessayez.' })
      return res.status(200).json({ pret: !!cles, cle_publique: cles ? cles.publique : null, appareils: r.appareils })
    }

    const corps = corpsDe(req)

    if (req.method === 'DELETE') {
      const r = await abonnements.retirer({ userId, endpoint: corps.endpoint || null, id: corps.id || null })
      if (!r.ok) return res.status(r.motif === 'cible_absente' ? 400 : 503).json({ error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.' })
      return res.status(200).json({ ok: true })
    }

    // POST
    if (!cles) return res.status(503).json({ error: 'Les notifications ne sont pas encore configurées.', motif: 'cles_absentes' })

    if (corps.action === 'abonner') {
      const r = await abonnements.enregistrer({ userId, abonnement: corps.abonnement, appareil: corps.appareil })
      if (!r.ok) {
        const code = r.motif === 'plafond_atteint' ? 409 : (r.motif.endsWith('_impossible') ? 503 : 400)
        return res.status(code).json({ error: MESSAGES_REFUS[r.motif] || 'Écriture impossible, réessayez.', motif: r.motif })
      }
      return res.status(200).json({ ok: true, empreinte: r.empreinte })
    }

    if (corps.action === 'essai') {
      const message = messageDeclaratif({
        titre: 'HôteSmart',
        corps: 'Les notifications arrivent bien sur cet appareil.',
        chemin: '/settings?onglet=notifications',
        sujet: 'essai'
      })
      const bilan = await envoyerAPersonne({ userId, message, cles })
      if (!bilan.ok) return res.status(503).json({ error: 'Lecture impossible, réessayez.' })
      return res.status(200).json(bilan)
    }

    return res.status(400).json({ error: 'action inconnue' })
  } catch (e) {
    console.error('push:', e && e.message)
    return res.status(500).json({ error: 'Erreur interne.' })
  }
}
