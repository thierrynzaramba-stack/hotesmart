// scripts/verifier-yield-reglages.js
// Verifie la migration des REGLAGES DE SEGMENT, par LECTURE.
// Migration : migrations/2026-09-13-yield-reglages-segment.sql
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER (REVIEW.md regle 13).
// ⚠ LECTURE SEULE sur les donnees : les seules ecritures tentees sont
// DELIBEREMENT vouees a l'echec, et celles qui passeraient sont nettoyees.
//
// USAGE : node scripts/verifier-yield-reglages.js

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const TABLE = 'yield_segment_reglages'

const controles = []
function note (nom, etat, detail) {
  controles.push({ nom, etat, detail })
  console.log(`${etat === 'ok' ? '✓' : etat === 'non-verifiable' ? '?' : '✗'} ${nom} — ${detail}`)
}

async function main () {
  console.log(`VERIFICATION — ${TABLE}\n`)
  const { count, error } = await supabase.from(TABLE).select('*', { count: 'exact', head: true })
  // `head: true` ne remonte pas toujours l'erreur : sur une table absente,
  // PostgREST rend error null ET count null. On exige un compte NUMERIQUE.
  if (error || typeof count !== 'number') {
    note('table', 'echec', `absente ou illisible : ${error ? error.message : 'compte non numerique'}`)
    return verdict()
  }
  note('table', 'ok', `${TABLE} interrogeable, ${count} ligne(s)`)

  const COLONNES = ['id', 'user_id', 'property_id', 'segment', 'crans', 'actif',
    'created_at', 'updated_at']
  const { error: eCols } = await supabase.from(TABLE).select(COLONNES.join(', ')).limit(1)
  note('colonnes', eCols ? 'echec' : 'ok',
    eCols ? eCols.message : `les ${COLONNES.length} colonnes repondent`)

  // ⚠ UNE COLONNE REMPLACEE SE VERIFIE DES DEUX COTES — releve le
  // 13 septembre 2026, et c'etait un FAUX VERT complet.
  // Ce script affirmait « 9 controles, 9 ok » sur une base ou la migration des
  // crans n'avait PAS ete appliquee : il listait encore `niveau` dans les
  // colonnes attendues, donc l'ancien schema le satisfaisait pleinement. Un
  // verificateur qui valide l'etat d'AVANT est pire qu'aucun verificateur — il
  // donne la permission de pousser.
  // Regle 13 : une mesure qui disqualifie de la donnee se verifie deux fois.
  const { error: eVieille } = await supabase.from(TABLE).select('niveau').limit(1)
  note('ancienne colonne retiree', eVieille ? 'ok' : 'echec',
    eVieille ? '`niveau` n\'existe plus, comme attendu'
      : '`niveau` EXISTE ENCORE — la migration des crans n\'est pas appliquee')

  const { data: bien } = await supabase
    .from('properties').select('id, user_id').limit(1).maybeSingle()
  if (!bien) { note('contraintes', 'non-verifiable', 'aucun bien'); return verdict() }
  const base = { user_id: bien.user_id, property_id: bien.id }

  // ─── Chaque contrainte se prouve par un refus ────────────────────────────
  for (const [nom, ligne] of [
    ['segment vide', { ...base, segment: '   ' }],
    ['segment trop long', { ...base, segment: 'x'.repeat(121) }],
    ['crans hors bornes', { ...base, segment: 'CTRL:crans', crans: 9 }],
    ['crans non entier', { ...base, segment: 'CTRL:crans2', crans: 1.5 }]
  ]) {
    const { data, error: e } = await supabase.from(TABLE).insert(ligne).select('id')
    if (e) { note(`refus : ${nom}`, 'ok', 'refuse par la base'); continue }
    note(`refus : ${nom}`, 'echec', 'ACCEPTE alors que la contrainte devrait refuser')
    if (data && data[0]) await supabase.from(TABLE).delete().eq('id', data[0].id)
  }

  // ⚠ LE DEFAUT EST « ACTIF », et il compte : une absence de ligne doit valoir
  // « actif, position calculee ». Si le defaut etait `false`, un hote qui
  // ajuste un niveau desactiverait le segment du meme geste.
  const { data: d, error: eD } = await supabase
    .from(TABLE).insert({ ...base, segment: 'CTRL:defaut' }).select('actif, crans').single()
  if (eD) note('defaut actif', 'non-verifiable', eD.message)
  else {
    note('defaut actif', d.actif === true && d.crans === null ? 'ok' : 'echec',
      `actif=${d.actif}, crans=${d.crans}`)
    // Unicite, sur la meme cle.
    const { error: e2 } = await supabase.from(TABLE).insert({ ...base, segment: 'CTRL:defaut' })
    note('unicite', e2 ? 'ok' : 'echec', e2 ? 'le doublon est refuse' : 'DOUBLON ACCEPTE')
    await supabase.from(TABLE).delete().eq('property_id', bien.id).eq('segment', 'CTRL:defaut')
  }

  // ─── RLS ─────────────────────────────────────────────────────────────────
  // ⚠ LA CLE ANON N'EST PAS LE ROLE `authenticated` : sans session, l'appelant
  // est `anon`, qu'aucune policy ne couvre. « Ne rien lire » est le
  // comportement VOULU, et ce controle ne prouve pas le cloisonnement par
  // compte — seulement qu'aucune porte n'est ouverte sans session.
  const { data: lu, error: eLu } = await anon.from(TABLE).select('id').limit(1)
  note('RLS lecture anonyme', eLu || (lu || []).length === 0 ? 'ok' : 'echec',
    eLu ? `refuse : ${eLu.message}` : `${(lu || []).length} ligne(s) sans session`)
  const { error: eE } = await anon.from(TABLE).insert({ ...base, segment: 'CTRL:anon' })
  note('RLS ecriture anonyme', eE ? 'ok' : 'echec',
    eE ? 'refusee' : 'ACCEPTEE — aucune policy d\'ecriture ne devrait exister')
  if (!eE) await supabase.from(TABLE).delete().eq('segment', 'CTRL:anon')

  return verdict()
}

function verdict () {
  const ko = controles.filter(c => c.etat === 'echec')
  const nv = controles.filter(c => c.etat === 'non-verifiable')
  console.log(`\n${controles.length} controle(s) : ${controles.length - ko.length - nv.length} ok,` +
    ` ${nv.length} non verifiable(s), ${ko.length} en echec`)
  if (!controles.length || controles.every(c => c.etat === 'non-verifiable')) {
    console.log('AUCUN controle exploitable — la migration est-elle appliquee ?')
    process.exit(1)
  }
  process.exit(ko.length ? 1 : 0)
}

main().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
