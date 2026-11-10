// api/alert-test.js — RETIRÉ (PWA lot 2c-3, étape 4 ; docs/kb/pwa.md §12.4).
//
// C'était le bouton « Tester » des listes d'alertes du tiroir de Messages. Les
// listes sont reprises en contacts prévenus, et leur essai vit dans Réglages →
// Notifications → « Envoyer un essai » (`POST /api/push { action:
// 'contact_essai' }`) : une fois par adresse et par jour, dix par compte, tenu
// par la base (spec §16.8, Q32, Q37).
//
// ⚠ IL RÉPOND 410 ET N'ENVOIE PLUS RIEN, À PERSONNE. Gardé plutôt que supprimé
// pour qu'un écran resté ouvert, ou un appel en cache, lise une réponse qui
// dit où aller — pas un 404 muet. La garde de session reste devant : un
// endpoint sans garde se recense (tests/cache-prive-endpoints.test.js).
// Son ancienne contrainte « destinataire déjà configuré » n'a plus d'objet :
// il n'y a plus d'envoi à contraindre.

const { requirePermission } = require('../lib/require-permission')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Methode non autorisee' })
  }
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'write' })
  if (!garde.ok) return
  return res.status(410).json({
    error: 'Cet essai a été remplacé : Réglages → Notifications → Contacts prévenus → « Envoyer un essai ».',
    motif: 'essai_dans_reglages'
  })
}
