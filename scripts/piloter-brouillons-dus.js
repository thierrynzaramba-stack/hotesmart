#!/usr/bin/env node
// scripts/piloter-brouillons-dus.js
// LA PASSE DES BROUILLONS ECHUS, LANCEE A LA MAIN.
//
//   node --env-file=.env.staging scripts/piloter-brouillons-dus.js          # a blanc
//   node --env-file=.env.staging scripts/piloter-brouillons-dus.js --go     # envoie
//
// ⚠ POURQUOI CE SCRIPT EXISTE : STAGING N'A AUCUN CRON (docs/STAGING.md). Sans
// lui, un brouillon differe n'y part JAMAIS, et la recette de l'ecran s'arrete
// a « Part dans 12 min » sans pouvoir verifier ce qui se passe a l'echeance.
// Meme role que `scripts/piloter-yieldflow.js` pour le pilote tarifaire.
//
// ⚠ A BLANC PAR DEFAUT : la passe ENVOIE au voyageur. Sans `--go`, elle LIT ce
// qui est du et le dit, sans rien envoyer ni rien ecrire.
//
// ⚠ LA PRODUCTION EST REFUSEE AVEC `--go`, sauf CONFIRMER_PROD=<reference du
// projet> — meme garde que la migration des donnees, et pour la meme raison :
// un `--go` tape dans le mauvais terminal enverrait de vrais messages a de
// vrais voyageurs. Code de sortie 3.

const { REF_PRODUCTION, nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const GO = process.argv.includes('--go')
const URL = process.env.SUPABASE_URL
const PROJET = refDuProjet(URL) || ''

if (GO && nomDeLaBase(URL) === 'PRODUCTION'
  && String(process.env.CONFIRMER_PROD || '').trim() !== REF_PRODUCTION) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION, et cette passe ENVOIE`)
  console.error('        de vrais messages a de vrais voyageurs.')
  console.error('')
  console.error('En production, le CRON s\'en charge toutes les 5 minutes : ce script')
  console.error('n\'y a normalement rien a faire. Pour un passage unique et assume :')
  console.error(`        CONFIRMER_PROD=${REF_PRODUCTION}`)
  console.error('')
  console.error('A blanc (sans --go), la production se lit sans aucun envoi.')
  process.exit(3)
}

;(async () => {
  const { supabase } = require('../lib/cron-shared')
  const { envoyerBrouillonsDus } = require('../lib/guestflow/brouillons-dus')

  const base = nomDeLaBase(URL)
  const { count, error } = await supabase.from('agent_tasks')
    .select('id', { count: 'exact', head: true })
  if (error) { console.error('ECHEC : lecture impossible —', error.message); process.exit(1) }
  console.log(`Base ${base} · agent_tasks = ${count} ligne(s)`)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    process.exit(1)
  }
  if (GO && base === 'PRODUCTION') {
    console.log('\n⚠ PASSAGE EN PRODUCTION ASSUME — ' + new Date().toISOString())
    console.log('  confirme par CONFIRMER_PROD, et journalise ici.\n')
  }
  console.log(GO ? '→ MODE ENVOI (--go)' : '→ a blanc : rien ne sera envoye ni ecrit')

  // ─── A BLANC : on LIT ce qui est du, et on le DIT ─────────────────────────
  // ⚠ La meme requete que la passe, aux memes bornes — sinon le dry-run ne
  // dirait pas ce que le --go ferait.
  const maintenant = Date.now()
  const { data: dues, error: eD } = await supabase.from('agent_tasks')
    .select('id, property_id, book_id, guest_name, send_after, suspendu_le, modifie_le, suggested_reply')
    .eq('status', 'pending_validation')
    .not('send_after', 'is', null)
    .lte('send_after', new Date(maintenant).toISOString())
    .is('suspendu_le', null)
    .order('send_after', { ascending: true })
    .limit(30)
  if (eD) { console.error('ECHEC : lecture des echues —', eD.message); process.exit(1) }

  console.log(`\n  ${(dues || []).length} brouillon(s) echu(s) :`)
  for (const t of dues || []) {
    const retard = Math.round((maintenant - Date.parse(t.send_after)) / 60000)
    console.log(`    ${t.id.slice(0, 8)}… · bien ${t.property_id} · resa ${t.book_id}`
      + ` · echu depuis ${retard} min${t.modifie_le ? ' · MODIFIE par l hote' : ''}`)
    console.log(`        « ${String(t.suggested_reply || '').slice(0, 70)}… »`)
  }
  // Ce qui est suspendu ou pas encore du, pour que le dry-run explique les
  // ABSENCES autant que les presences.
  const { data: enAttente } = await supabase.from('agent_tasks')
    .select('id, send_after, suspendu_le')
    .eq('status', 'pending_validation')
    .not('send_after', 'is', null)
    .limit(30)
  const suspendus = (enAttente || []).filter(t => t.suspendu_le).length
  const pasDus = (enAttente || []).filter(t => !t.suspendu_le && Date.parse(t.send_after) > maintenant).length
  console.log(`  (${suspendus} suspendu(s) par l hote, ${pasDus} pas encore echu(s))`)

  if (!GO) {
    console.log('\n  Rien n\'a ete envoye. Relancer avec --go pour faire partir les echus.')
    process.exit(0)
  }

  // ─── --go : la VRAIE passe, celle du cron ────────────────────────────────
  const results = { errors: [] }
  const bilan = await envoyerBrouillonsDus(results, { maintenant })
  console.log('\n  Bilan :', JSON.stringify(bilan))
  if (results.errors.length) {
    console.log(`\n  ${results.errors.length} erreur(s) — c'est ICI qu'elles se lisent,`)
    console.log('  pas dans le code HTTP du cron, qui rend 200 meme en panne :')
    for (const e of results.errors) console.log(`    ${e.context} : ${e.error}`)
    process.exit(2)
  }
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
