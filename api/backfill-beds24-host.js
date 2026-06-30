// api/backfill-beds24-host.js
// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINT ONE-SHOT — À SUPPRIMER À L'ÉTAPE 5
// ═══════════════════════════════════════════════════════════════════════════
// Declenche le backfill des messages HOST Beds24 historiques dans `messages`
// (cf. scripts/backfill-beds24-host.js : meme CUTOFF, meme logique, idempotent).
//
// Protege par le secret existant CRON_SECRET (deja utilise par api/cron.js).
//   ?secret=<CRON_SECRET>  obligatoire, sinon 403.
//   ?dry=1                 -> simulation (aucune ecriture). Sinon ecriture REELLE.
//
// Repond un JSON avec le recap complet (global + par bien).
// ═══════════════════════════════════════════════════════════════════════════

const { runBackfill } = require('../scripts/backfill-beds24-host')

module.exports = async function handler(req, res) {
  // Protection par secret partage (reutilise CRON_SECRET).
  const secret = req.query.secret
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Interdit' })
  }

  const dryRun = req.query.dry === '1'

  try {
    const recap = await runBackfill({ dryRun })
    const status = recap.error ? 500 : 200
    return res.status(status).json(recap)
  } catch (e) {
    console.error('[backfill-endpoint] exception', e.message)
    return res.status(500).json({ error: e.message })
  }
}
