// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron DÉDIÉ à l'import des messages écrits chez l'OTA
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ POURQUOI IL EXISTE, ET CE N'EST PAS UN CONFORT D'ARCHITECTURE.
// L'import vivait en seconde passe du cycle principal, avec 8 s de budget POUR
// TOUT LE PARC. Mesure du 15 septembre 2026, quatre cycles consecutifs :
//
//   Colomiers     abstentions 130 -> 133   motif = budget
//   Ofuro Futari  abstentions 131 -> 134   motif = budget
//   La bulle      abstentions 130 -> 133   motif = cycle_en_retard
//   Coeur de vie  abstentions 127 -> 130   motif = cycle_en_retard
//
// Les deux premiers biens consommaient les 8 s sans aboutir ; les deux suivants
// n'etaient MEME PAS APPELES. Marqueur d'anteriorite a `null` depuis 133 cycles,
// 1189 messages en base inchanges d'un bout a l'autre, et le preavis d'ecriture
// de masse reparti a chaque cycle avec le meme compte.
//
// ⚠ ET `BUDGET_MS` N'ETAIT PAS LE LEVIER. `cycle_en_retard` se decide AVANT
// lui : c'est l'ORDRE DE PASSAGE qui affame l'import, pas la duree qu'on lui
// accorde une fois appele. Augmenter sa part dans un cycle deja a 40-56 s pour
// un plafond de 60 n'aurait fait que deplacer ce qui saute — et ce qui saute,
// dans ce cycle, ce sont les codes d'acces. La lecon du 10 septembre (24 h de
// codes perdus, une voyageuse devant une porte) interdit ce marchandage.
//
// ⚠ CADENCE 10 MINUTES, PAS 5. L'import est un RATTRAPAGE d'historique : le
// temps reel passe par le webhook, qui lui fonctionne. Dix minutes laissent la
// place a une passe large sans jamais chevaucher la precedente — deux passes
// concurrentes sur le meme bien ne se corrompraient pas (le marqueur est un
// upsert, `recordMessage` deduplique) mais doubleraient le cout pour rien.

const { createClient } = require('@supabase/supabase-js')
const {
  importerMessagesDuBien,
  ordonnerPourImport,
  BUDGET_BIEN_DEDIE_MS,
  BUDGET_PARC_DEDIE_MS
} = require('../lib/cron-channel-messages-sync')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler (req, res) {
  // ⚠ MEME GARDE QUE `/api/cron` : un import declenchable de l'exterieur serait
  // un moyen de faire ecrire la base par n'importe qui, et de bruler le quota
  // d'appels Channex de l'hote.
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' })
  }

  const t0 = Date.now()
  const results = { errors: [] }
  console.log('[cron-messages] demarrage', new Date().toISOString())

  const { data: props, error } = await supabase
    .from('properties')
    .select('id, user_id, provider_property_id, name')
    .eq('provider', 'channex')
    .not('provider_property_id', 'is', null)
  if (error) {
    console.error('[cron-messages] lecture des biens echec:', error.message)
    return res.status(503).json({ error: 'Lecture des biens impossible' })
  }

  // ⚠ L'ORDRE TOURNE. `ordonnerPourImport` fait passer en premier le bien vu il
  // y a le plus longtemps : sans lui, un bien couteux place en tete affamerait
  // les memes biens a chaque passage — c'est exactement ce qui s'est produit
  // dans le cycle principal.
  let aImporter = props || []
  try {
    aImporter = await ordonnerPourImport(supabase, props || [])
  } catch (err) {
    console.error('[cron-messages] ordre illisible, ordre d origine :', err.message)
  }

  // ⚠ UNE ECHEANCE POUR TOUT LE PARC, posee ICI. C'est la lecon du bloquant 4 :
  // une echeance posee avant la boucle metier mesure le CYCLE, pas l'import.
  const echeance = t0 + BUDGET_PARC_DEDIE_MS

  for (const p of aImporter) {
    if (!p.provider_property_id) continue
    // ⚠ SON PROPRE `try`, PAR BIEN. Une panne sur un bien ne doit pas priver les
    // suivants de leur import — meme regle que dans le cycle principal.
    try {
      await importerMessagesDuBien(supabase, p, {
        echeance, results, budgetBienMs: BUDGET_BIEN_DEDIE_MS
      })
    } catch (err) {
      console.error(`[cron-messages] ${p.provider_property_id}:`, err.message)
      results.errors.push({ property_id: p.provider_property_id, error: err.message })
    }
  }

  const bilan = {
    biens: aImporter.length,
    importes: results.messagesImportes || 0,
    abstentions: results.messagesImportAbstentions || 0,
    erreurs: results.errors.length,
    ms: Date.now() - t0
  }
  console.log('[cron-messages] fin', JSON.stringify(bilan))
  // ⚠ 200 MEME AVEC DES ERREURS, ET ELLES SONT DANS LE CORPS. Un cron qui rend
  // 500 fait retenter Vercel ; ici une panne par bien est deja absorbee, et le
  // diagnostic se lit dans `errors` — jamais dans le code HTTP. Lecon du
  // 10 septembre : « diagnostiquer un cron = lire results.errors ».
  return res.status(200).json({ ok: true, ...bilan, errors: results.errors })
}
