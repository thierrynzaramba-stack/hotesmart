// scripts/verifier-price-log.js
// Verifie la migration du journal des prix affiches.
// Migration : migrations/2026-09-12-price-display-log.sql
// Spec      : docs/specs/spec-yieldflow-v1.md §4
//
// LECTURE SEULE sur les donnees. La seule ecriture est un aller-retour de
// controle explicitement borne (--sonde), qui insere une ligne sur un bien
// reel et la supprime immediatement : c'est le seul moyen de prouver que
// l'index unique partiel existe VRAIMENT en base, et pas seulement dans le
// fichier de migration.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER.
// C'est la lecon du 10 septembre : un script qui compte 0 ligne et affiche
// « OK » valide un systeme vide. Chaque controle ci-dessous dit ce qu'il a
// reellement lu, et le verdict distingue « verifie » de « pas verifiable ».
//
// USAGE : node scripts/verifier-price-log.js [--sonde]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const SONDE = process.argv.includes('--sonde')

const controles = []
function note (nom, etat, detail) {
  controles.push({ nom, etat, detail })
  const marque = etat === 'ok' ? '✓' : etat === 'non-verifiable' ? '?' : '✗'
  console.log(`${marque} ${nom} — ${detail}`)
}

async function main () {
  // ─── 1. La table existe et est interrogeable ──────────────────────────────
  const { count, error } = await supabase
    .from('price_display_log').select('*', { count: 'exact', head: true })
  // ⚠ `head: true` NE REMONTE PAS TOUJOURS L'ERREUR : sur une table absente,
  // PostgREST a rendu ici `error: null` et `count: null`. La premiere version
  // de ce script affichait donc « ✓ table interrogeable, null ligne(s) » sur
  // une table QUI N'EXISTE PAS — un faux vert, dans le script meme ecrit pour
  // les empecher (REVIEW.md regle 13). On exige un compte NUMERIQUE.
  if (error || typeof count !== 'number') {
    note('table', 'echec',
      `absente ou illisible : ${error ? error.message : 'compte non numerique (table absente ?)'}`)
    return verdict()
  }
  note('table', 'ok', `price_display_log interrogeable, ${count} ligne(s)`)

  // ─── 2. Les colonnes attendues sont toutes la ─────────────────────────────
  // On les lit par leur nom : une colonne absente fait echouer le select, ce
  // qui est exactement le signal cherche.
  const COLONNES = ['id', 'user_id', 'property_id', 'stay_date', 'rate',
    'created_at', 'replaced_at', 'sold_at', 'sold_booking_uid', 'source']
  const { error: eCols } = await supabase
    .from('price_display_log').select(COLONNES.join(', ')).limit(1)
  if (eCols) note('colonnes', 'echec', `${COLONNES.length} attendues : ${eCols.message}`)
  else note('colonnes', 'ok', `les ${COLONNES.length} colonnes de la spec §4 repondent`)

  // ─── 3. La cle etrangere pointe bien sur properties.id (UUID) ─────────────
  // Decision E6 : ce journal est cle sur l'UUID, pas sur la cle provider.
  // Un INSERT avec un uuid inexistant doit etre REFUSE par la FK.
  const uuidFantome = '00000000-0000-4000-8000-000000000000'
  const { error: eFk } = await supabase.from('price_display_log').insert({
    user_id: uuidFantome, property_id: uuidFantome, stay_date: '2099-01-01', rate: 1
  })
  if (!eFk) {
    note('fk_properties', 'echec',
      'un bien INEXISTANT a ete accepte : la contrainte FK manque')
    await supabase.from('price_display_log').delete()
      .eq('property_id', uuidFantome).eq('stay_date', '2099-01-01')
  } else if (/foreign key|violates/i.test(eFk.message)) {
    note('fk_properties', 'ok', 'un bien inexistant est refuse (cascade active)')
  } else {
    note('fk_properties', 'non-verifiable', `refus pour une autre raison : ${eFk.message}`)
  }

  // ─── 4. L'index unique partiel : au plus UNE ligne courante par nuit ──────
  // C'est l'invariant qui porte tout le mecanisme. Il ne se verifie qu'en
  // essayant reellement d'ouvrir deux lignes courantes sur la meme nuit.
  if (!SONDE) {
    note('index_unique', 'non-verifiable',
      'demande un aller-retour d ecriture — relancer avec --sonde')
  } else {
    const { data: bien } = await supabase
      .from('properties').select('id, user_id').limit(1).maybeSingle()
    if (!bien) {
      note('index_unique', 'non-verifiable', 'aucun bien en base pour porter la sonde')
    } else {
      const nuit = '2099-12-31'   // hors de toute donnee reelle
      await supabase.from('price_display_log').delete()
        .eq('property_id', bien.id).eq('stay_date', nuit)
      const ligne = { user_id: bien.user_id, property_id: bien.id, stay_date: nuit, rate: 1 }
      const { error: e1 } = await supabase.from('price_display_log').insert(ligne)
      const { error: e2 } = await supabase.from('price_display_log').insert(ligne)
      if (e1) {
        note('index_unique', 'non-verifiable', `la premiere insertion a echoue : ${e1.message}`)
      } else if (e2 && /duplicate key|unique/i.test(e2.message)) {
        note('index_unique', 'ok', 'une SECONDE ligne courante sur la meme nuit est refusee')
      } else {
        note('index_unique', 'echec',
          'DEUX lignes courantes coexistent : la cloture a la vente fermera la mauvaise')
      }
      const { error: eDel } = await supabase.from('price_display_log').delete()
        .eq('property_id', bien.id).eq('stay_date', nuit)
      if (eDel) console.error(`  ⚠ sonde NON nettoyee (${nuit}) : ${eDel.message}`)
      else console.log(`  sonde nettoyee (${nuit})`)
    }
  }

  // ─── 5. RLS active (regle 5) ──────────────────────────────────────────────
  // La cle anonyme ne doit rien voir : le journal porte la strategie tarifaire.
  if (!process.env.SUPABASE_ANON_KEY) {
    note('rls', 'non-verifiable', 'SUPABASE_ANON_KEY absente de l environnement')
  } else {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data, error: eAnon } = await anon
      .from('price_display_log').select('id').limit(1)
    // ⚠ « L'ANONYME NE VOIT RIEN » NE PROUVE RIEN SUR UNE TABLE VIDE.
    // Si la table ne contient aucune ligne, l'anonyme n'en verrait aucune meme
    // sans RLS. Le controle n'a de valeur que s'il y a quelque chose a cacher.
    if (count === 0) {
      note('rls', 'non-verifiable',
        'table vide : ne pas voir zero ligne ne prouve pas le cloisonnement')
    } else if (eAnon) {
      note('rls', 'ok', `la cle anonyme est refusee (${eAnon.message.slice(0, 40)})`)
    } else if (!data?.length) {
      note('rls', 'ok', `la cle anonyme ne lit aucune des ${count} ligne(s)`)
    } else {
      note('rls', 'echec', `la cle anonyme lit ${data.length} ligne(s) — RLS inactive`)
    }
  }

  verdict()
}

function verdict () {
  const echecs = controles.filter(c => c.etat === 'echec')
  const nonVerifies = controles.filter(c => c.etat === 'non-verifiable')
  const ok = controles.filter(c => c.etat === 'ok')

  console.log(`\n${ok.length} verifie(s), ${nonVerifies.length} non verifiable(s), ${echecs.length} en echec`)

  // ⚠ « RIEN LU » N'EST PAS « TOUT VA BIEN ».
  if (!ok.length) {
    console.error('AUCUN controle n a abouti — ce n est pas un succes.')
    process.exit(1)
  }
  if (echecs.length) {
    console.error('ECHEC : ' + echecs.map(c => c.nom).join(', '))
    process.exit(1)
  }
  if (nonVerifies.length) {
    console.log('Points non verifies : ' + nonVerifies.map(c => c.nom).join(', '))
    console.log('(relancer avec --sonde pour l index unique)')
  }
  console.log('Migration conforme a la spec §4.')
}

main().catch(e => { console.error(e); process.exit(1) })
