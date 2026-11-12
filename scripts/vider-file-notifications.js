#!/usr/bin/env node
// scripts/vider-file-notifications.js — PWA lot 2c-3 (review de l'étape 1,
// constat 7). Fait partir la FILE DES HEURES CALMES comme la passe du cron
// (`viderFile`, lib/notifications/file.js) — utile sur staging, où AUCUN cron
// n'est planifié (docs/STAGING.md §1), pour recetter ce que « vider ma file »
// ne peut pas montrer : la ligne d'un CONTACT LIBRE, qui n'est à personne du
// compte.
//
// Usage :
//   node --env-file=.env.staging scripts/vider-file-notifications.js         (à blanc)
//   node --env-file=.env.staging scripts/vider-file-notifications.js --go    (envoie ce qui est dû)
//   ... --tout   (avec --go : tout ce qui attend, même avant la fin de sa plage)
//
// ⚠ À BLANC PAR DÉFAUT : il compte ce qui attend — dû ou pas, pour une personne
// ou pour un contact — sans rien afficher d'une adresse ni d'un texte.
// ⚠ `--go` ENVOIE de vrais e-mails et SMS (clé Brevo du compte) : sur la prod,
// c'est un geste de production, et il est refusé.

const { nomDeLaBase } = require('../lib/empreinte-base')

async function executer ({ argv = [], db, maintenant = Date.now(), base = 'INCONNUE', viderFile, ecrire = console.log }) {
  const go = argv.includes('--go')
  const tout = argv.includes('--tout')
  if (go && base === 'PRODUCTION') {
    ecrire('Refusé : `--go` sur la PRODUCTION. Le cron y fait ce travail toutes les cinq minutes.')
    return 2
  }
  const { data, error } = await db.from('notifications_file').select('id, user_id, contact_id, a').limit(1000)
  if (error) { ecrire(`Lecture impossible : ${error.message}`); return 1 }
  const lignes = data || []
  const dues = lignes.filter(l => Date.parse(l.a) <= maintenant)
  const compte = (ls) => `${ls.filter(l => l.user_id).length} pour une personne, ${ls.filter(l => l.contact_id).length} pour un contact`
  ecrire(`Base : ${base}. En file : ${lignes.length} (${compte(lignes)}) ; dues maintenant : ${dues.length} (${compte(dues)}).`)
  if (!go) { ecrire('À blanc : rien n\'est parti. Relancer avec --go (et --tout pour ne pas attendre la fin des plages).'); return 0 }
  // `--tout` : l'heure de la passe est portée au-delà de toutes les plages.
  const bilan = await viderFile({ maintenant: tout ? maintenant + 2 * 86400000 : maintenant, db })
  ecrire(`Passe : ${bilan.prises} prise(s), ${bilan.messages} message(s), ${bilan.ecartees} écartée(s), ${bilan.reportees} reportée(s)`
    + (bilan.erreurs.length ? `, erreurs : ${[...new Set(bilan.erreurs)].join(', ')}` : '') + '.')
  return bilan.erreurs.includes('lecture_impossible') ? 1 : 0
}

if (require.main === module) {
  const URL = process.env.SUPABASE_URL
  const KEY = process.env.SUPABASE_SERVICE_KEY
  if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
  // ⚠ UNE BASE NON RECONNUE EST REFUSÉE (lib/empreinte-base.js) : un compte
  // rendu dont personne ne peut dire de quelle base il vient ne vaut rien.
  const base = nomDeLaBase(URL)
  if (base === 'INCONNUE') { console.error('Base non reconnue : refus.'); process.exit(1) }
  const db = require('@supabase/supabase-js').createClient(URL, KEY)
  executer({ argv: process.argv.slice(2), db, base, viderFile: require('../lib/notifications/file').viderFile })
    .then(code => process.exit(code))
    .catch(e => { console.error(e.message); process.exit(1) })
}

module.exports = { executer }
