// scripts/verifier-yield-events.js
// Verifie la migration des EVENEMENTS DE L'HOTE, par LECTURE.
// Migration : migrations/2026-09-13-yield-evenements.sql
// DOC : docs/kb/evenements-yield.md
//
// ⚠ A NE PAS CONFONDRE avec `verifier-yield-evenements.js`, qui verifie
// l'import des VACANCES SCOLAIRES (table `school_holidays`). Deux tables, deux
// verificateurs : les fondre aurait fait un script dont le vert ne dit plus
// laquelle des deux il a lue.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER (REVIEW.md regle 13).
// Chaque controle dit ce qu'il a reellement lu, et le verdict distingue
// « verifie » de « pas verifiable ».
//
// ⚠ LECTURE SEULE sur les donnees. Les seules ecritures tentees sont
// DELIBEREMENT vouees a l'echec : elles prouvent que les contraintes et la RLS
// refusent. Elles sont annulees si jamais elles passaient.
//
// USAGE : node scripts/verifier-yield-events.js [--dry-run]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const DRY = process.argv.includes('--dry-run')

const controles = []
function note (nom, etat, detail) {
  controles.push({ nom, etat, detail })
  console.log(`${etat === 'ok' ? '✓' : etat === 'non-verifiable' ? '?' : '✗'} ${nom} — ${detail}`)
}

async function main () {
  console.log('VERIFICATION — yield_events (evenements de l\'hote)')
  console.log(DRY ? 'DRY-RUN : la migration n\'a pas encore ete appliquee\n' : '')

  const { count, error } = await supabase
    .from('yield_events').select('*', { count: 'exact', head: true })
  // ⚠ `head: true` ne remonte pas toujours l'erreur : sur une table absente,
  // PostgREST rend `error: null` ET `count: null`. On exige un compte
  // NUMERIQUE, sans quoi le script affirmerait un succes en n'ayant rien lu.
  if (error || typeof count !== 'number') {
    note('table', DRY ? 'non-verifiable' : 'echec',
      `absente ou illisible : ${error ? error.message : 'compte non numerique'}`)
    return verdict()
  }
  note('table', 'ok', `yield_events interrogeable, ${count} ligne(s)`)

  // ─── Les colonnes attendues ───────────────────────────────────────────────
  const COLONNES = ['id', 'user_id', 'property_id', 'nom', 'date_debut',
    'date_fin', 'recurrence', 'parent_segment', 'reconduit_de', 'created_at']
  const { error: eCols } = await supabase
    .from('yield_events').select(COLONNES.join(', ')).limit(1)
  note('colonnes', eCols ? 'echec' : 'ok',
    eCols ? eCols.message : `les ${COLONNES.length} colonnes repondent`)

  // ─── Les contraintes : chacune se prouve par un refus ─────────────────────
  const { data: bien } = await supabase
    .from('properties').select('id, user_id').limit(1).maybeSingle()
  if (!bien) {
    note('contraintes', 'non-verifiable', 'aucun bien pour tenter une ecriture')
    return verdict()
  }
  const base = { user_id: bien.user_id, property_id: bien.id, nom: 'CONTROLE' }
  const refus = [
    ['periode inversee', { ...base, date_debut: '2026-06-10', date_fin: '2026-06-01' }],
    ['nom vide', { ...base, nom: '   ', date_debut: '2026-06-01', date_fin: '2026-06-02' }],
    ['recurrence inconnue', { ...base, date_debut: '2026-06-01', date_fin: '2026-06-02', recurrence: 'mensuelle' }],
    ['parent inconnu', { ...base, date_debut: '2026-06-01', date_fin: '2026-06-02', parent_segment: 'plein_ete' }]
  ]
  for (const [nom, ligne] of refus) {
    const { data, error: e } = await supabase
      .from('yield_events').insert(ligne).select('id')
    if (e) { note(`refus : ${nom}`, 'ok', 'refuse par la base'); continue }
    // ⚠ SI CA PASSE, ON NETTOIE. Un verificateur ne laisse jamais de trace.
    note(`refus : ${nom}`, 'echec', 'ACCEPTE alors que la contrainte devrait refuser')
    if (data && data[0]) await supabase.from('yield_events').delete().eq('id', data[0].id)
  }

  // ─── L'unicite (property_id, nom, date_debut) ─────────────────────────────
  const doublon = { ...base, nom: 'CONTROLE UNICITE',
    date_debut: '2026-06-01', date_fin: '2026-06-02' }
  const { data: un, error: e1 } = await supabase
    .from('yield_events').insert(doublon).select('id')
  if (e1) {
    note('unicite', 'non-verifiable', `premiere insertion refusee : ${e1.message}`)
  } else {
    const { error: e2 } = await supabase.from('yield_events').insert(doublon)
    note('unicite', e2 ? 'ok' : 'echec',
      e2 ? 'le doublon est refuse' : 'DOUBLON ACCEPTE — index unique absent')
    if (un && un[0]) await supabase.from('yield_events').delete().eq('id', un[0].id)
  }

  // ─── RLS : le client anonyme ne lit rien et n'ecrit rien ──────────────────
  // ⚠ LA CLE ANON N'EST PAS LE ROLE `authenticated`. La policy cible
  // `to authenticated` : sans session, l'appelant est le role `anon`, qu'aucune
  // policy ne couvre. « Ne rien lire » est donc le comportement VOULU, et ce
  // controle ne prouve PAS que le cloisonnement par compte fonctionne — il
  // prouve seulement qu'aucune porte n'est ouverte sans session.
  const { data: lu, error: eLu } = await anon.from('yield_events').select('id').limit(1)
  note('RLS lecture anonyme', (!eLu && (lu || []).length === 0) || eLu ? 'ok' : 'echec',
    eLu ? `refuse : ${eLu.message}` : `${(lu || []).length} ligne(s) lue(s) sans session`)
  const { error: eEcr } = await anon.from('yield_events').insert({
    ...base, date_debut: '2026-06-01', date_fin: '2026-06-02'
  })
  note('RLS ecriture anonyme', eEcr ? 'ok' : 'echec',
    eEcr ? 'refusee' : 'ACCEPTEE — aucune policy d\'ecriture ne devrait exister')

  return verdict()
}

function verdict () {
  const ko = controles.filter(c => c.etat === 'echec')
  const nv = controles.filter(c => c.etat === 'non-verifiable')
  console.log(`\n${controles.length} controle(s) : ${controles.length - ko.length - nv.length} ok,` +
    ` ${nv.length} non verifiable(s), ${ko.length} en echec`)
  // ⚠ « RIEN VERIFIE » N'EST PAS « TOUT BON ». Un script qui n'a pu lire
  // aucune table doit sortir en erreur, sinon son vert ment.
  if (!controles.length || controles.every(c => c.etat === 'non-verifiable')) {
    console.log('AUCUN controle exploitable — la migration est-elle appliquee ?')
    process.exit(DRY ? 0 : 1)
  }
  process.exit(ko.length ? 1 : 0)
}

main().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
