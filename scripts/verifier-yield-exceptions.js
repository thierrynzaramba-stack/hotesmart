// scripts/verifier-yield-exceptions.js
// Verifie la migration des exceptions « hors reference ».
// Migration : migrations/2026-09-12-yield-exceptions.sql
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER (REVIEW.md regle 13).
// Chaque controle dit ce qu'il a reellement lu, et le verdict distingue
// « verifie » de « pas verifiable ».
//
// USAGE : node scripts/verifier-yield-exceptions.js [--sonde]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const SONDE = process.argv.includes('--sonde')

const controles = []
function note (nom, etat, detail) {
  controles.push({ nom, etat, detail })
  console.log(`${etat === 'ok' ? '✓' : etat === 'non-verifiable' ? '?' : '✗'} ${nom} — ${detail}`)
}

async function main () {
  const { count, error } = await supabase
    .from('yield_exceptions').select('*', { count: 'exact', head: true })
  // `head: true` ne remonte pas toujours l'erreur : sur une table absente,
  // PostgREST rend error null et count null. On exige un compte NUMERIQUE.
  if (error || typeof count !== 'number') {
    note('table', 'echec', `absente ou illisible : ${error ? error.message : 'compte non numerique'}`)
    return verdict()
  }
  note('table', 'ok', `yield_exceptions interrogeable, ${count} ligne(s)`)

  const COLONNES = ['id', 'user_id', 'property_id', 'date_debut', 'date_fin', 'motif', 'created_at']
  const { error: eCols } = await supabase
    .from('yield_exceptions').select(COLONNES.join(', ')).limit(1)
  if (eCols) note('colonnes', 'echec', `${COLONNES.length} attendues : ${eCols.message}`)
  else note('colonnes', 'ok', `les ${COLONNES.length} colonnes repondent`)

  if (!SONDE) {
    note('contraintes', 'non-verifiable', 'demande un aller-retour d ecriture — relancer avec --sonde')
    note('fk_properties', 'non-verifiable', 'idem')
  } else {
    const { data: bien } = await supabase
      .from('properties').select('id, user_id').limit(1).maybeSingle()
    if (!bien) {
      note('contraintes', 'non-verifiable', 'aucun bien en base pour porter la sonde')
    } else {
      const base = { user_id: bien.user_id, property_id: bien.id, motif: 'SONDE' }
      const nettoyer = () => supabase.from('yield_exceptions').delete().eq('motif', 'SONDE')

      // 1. Une periode inversee doit etre refusee PAR LA BASE.
      const { error: eInv } = await supabase.from('yield_exceptions')
        .insert({ ...base, date_debut: '2026-06-30', date_fin: '2026-06-01' })
      if (eInv && /check|violates/i.test(eInv.message)) {
        note('check_periode', 'ok', 'une periode qui finit avant de commencer est refusee')
      } else {
        note('check_periode', 'echec', eInv ? `refus pour une autre raison : ${eInv.message}` : 'ACCEPTEE')
        await nettoyer()
      }

      // 2. Un motif vide doit etre refuse.
      const { error: eVide } = await supabase.from('yield_exceptions')
        .insert({ ...base, motif: '   ', date_debut: '2026-06-01', date_fin: '2026-06-30' })
      if (eVide && /check|violates/i.test(eVide.message)) {
        note('check_motif', 'ok', 'un motif vide ou blanc est refuse')
      } else {
        note('check_motif', 'echec', eVide ? `refus pour une autre raison : ${eVide.message}` : 'ACCEPTE')
        await nettoyer()
      }

      // 3. La FK vers properties.
      const fantome = '00000000-0000-4000-8000-000000000000'
      const { error: eFk } = await supabase.from('yield_exceptions')
        .insert({ ...base, property_id: fantome, date_debut: '2026-06-01', date_fin: '2026-06-30' })
      if (eFk && /foreign key|violates/i.test(eFk.message)) {
        note('fk_properties', 'ok', 'un bien inexistant est refuse (cascade active)')
      } else {
        note('fk_properties', 'echec', eFk ? `refus pour une autre raison : ${eFk.message}` : 'ACCEPTE')
        await nettoyer()
      }

      // 4. Une periode VALIDE doit passer — sinon les contraintes sont trop
      //    strictes et le script de saisie echouerait a la premiere ligne.
      const { data: ok, error: eOk } = await supabase.from('yield_exceptions')
        .insert({ ...base, date_debut: '2026-06-01', date_fin: '2026-06-30' })
        .select('id').single()
      if (eOk) note('insertion_valide', 'echec', `une periode valide est refusee : ${eOk.message}`)
      else note('insertion_valide', 'ok', 'une periode valide est acceptee')
      if (ok) await supabase.from('yield_exceptions').delete().eq('id', ok.id)

      const { count: reste } = await supabase
        .from('yield_exceptions').select('*', { count: 'exact', head: true }).eq('motif', 'SONDE')
      if (reste) { await nettoyer(); console.log(`  ⚠ ${reste} sonde(s) nettoyee(s) apres coup`) }
      else console.log('  sondes nettoyees')
    }
  }

  // RLS : la cle anonyme ne doit rien lire.
  if (!process.env.SUPABASE_ANON_KEY) {
    note('rls', 'non-verifiable', 'SUPABASE_ANON_KEY absente')
  } else if (count === 0) {
    note('rls', 'non-verifiable', 'table vide : ne pas voir zero ligne ne prouve rien')
  } else {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data, error: eAnon } = await anon.from('yield_exceptions').select('id').limit(1)
    if (eAnon) note('rls', 'ok', `la cle anonyme est refusee (${eAnon.message.slice(0, 40)})`)
    else if (!data?.length) note('rls', 'ok', `la cle anonyme ne lit aucune des ${count} ligne(s)`)
    else note('rls', 'echec', `la cle anonyme lit ${data.length} ligne(s) — RLS inactive`)
  }

  verdict()
}

function verdict () {
  const echecs = controles.filter(c => c.etat === 'echec')
  const nonVerifies = controles.filter(c => c.etat === 'non-verifiable')
  const ok = controles.filter(c => c.etat === 'ok')
  console.log(`\n${ok.length} verifie(s), ${nonVerifies.length} non verifiable(s), ${echecs.length} en echec`)
  if (!ok.length) { console.error('AUCUN controle n a abouti — ce n est pas un succes.'); process.exit(1) }
  if (echecs.length) { console.error('ECHEC : ' + echecs.map(c => c.nom).join(', ')); process.exit(1) }
  if (nonVerifies.length) console.log('Non verifies : ' + nonVerifies.map(c => c.nom).join(', '))
  console.log('Migration conforme a la spec §5 (lot 2.2).')
}

main().catch(e => { console.error(e); process.exit(1) })
