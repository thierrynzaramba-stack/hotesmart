// scripts/transferer-bien-vers-fiche-neuve.js
// Transfere les donnees d'une ancienne fiche (cle Beds24) vers la fiche NEUVE
// (cle Channex), par `transferer_bien` — plan retenu par Thierry le
// 10 septembre 2026.
//
// ⚠ CE SCRIPT NE FAIT QUE PILOTER. Tout le travail est dans la fonction
// plpgsql `transferer_bien` (migrations/2026-09-10-transfert-vers-bien-neuf.sql) :
// une seule transaction, sauvegarde integrale dans `rekeying_backup`, et neuf
// refus. PostgREST n'a pas de transaction sur plusieurs requetes — c'est toute
// la raison d'etre de cette fonction.
//
// ⚠ IL POSE `automation_paused = true` SUR LA SOURCE, QUE LA FONCTION EXIGE.
// Sans cette pause, un cron qui lit encore l'ancienne cle enverrait un message
// ou un code d'acces sur un sejour en train de changer de fiche.
//
// ⚠ IL NE TOUCHE PAS `rate_sync_mode`, ET C'EST DELIBERE.
// La fiche neuve nait en `keep` : HoteSmart ne pousse aucun prix. La passer en
// `managed` maintenant ferait appliquer `base_price` a toutes les dates SANS
// ligne de calendrier — 500 jours au prix de base, alors que le transfert
// n'apporte que 17 dates tarifees pour La bulle. Le passage en `managed` est un
// geste separe, apres amorcage des vrais prix.
//
// DRY RUN par defaut : il ne fait alors QUE l'audit `transfert_compter`.
// USAGE : node scripts/transferer-bien-vers-fiche-neuve.js <la-bulle|coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { noterCleMigree } = require('../lib/cles-migrees')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')

// Liste fermee, nommee en dur : un transfert ne prend pas d'identifiant libre.
const CIBLES = {
  'la-bulle': {
    nom: 'Cœur de vie « La bulle »',
    source: '58001ed1-e194-498a-94b4-606eece8f33d',
    cible: '091d9abf-ff86-45ce-8123-3425e6f3900f'
  },
  'coeur-23': {
    nom: 'coeur de vie 23',
    source: '49b2d1f6-b8df-43ba-b636-fa4f73713c4b',
    cible: 'efe1daf1-652c-4177-b29b-19f1db377c96'
  }
}

const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/transferer-bien-vers-fiche-neuve.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

async function audit (etiquette) {
  const { data, error } = await supabase.rpc('transfert_compter',
    { p_source: C.source, p_cible: C.cible })
  if (error) throw new Error(`transfert_compter : ${error.message}`)
  const par = {}
  for (const r of data) {
    par[r.famille] = par[r.famille] || { s: 0, c: 0 }
    par[r.famille].s += Number(r.sous_source)
    par[r.famille].c += Number(r.sous_cible)
  }
  console.log(`\n── audit ${etiquette}`)
  for (const [f, v] of Object.entries(par)) {
    console.log(`   ${f.padEnd(20)} source ${String(v.s).padStart(5)}   cible ${String(v.c).padStart(5)}`)
  }
  return { data, par }
}

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — audit seul'}  bien : ${C.nom}`)
  console.log(`   source ${C.source}\n   cible  ${C.cible}`)

  const avant = await audit('AVANT')

  // Les lignes deja cote cible sur les tables a contrainte unique feraient
  // echouer toute la transaction. La fonction refuse dessus ; on les montre ici
  // pour que le refus ne soit pas une surprise.
  const bloquantes = avant.data.filter(r => Number(r.sous_cible) > 0)
  if (bloquantes.length) {
    console.log('\n   ⚠ deja cote cible :')
    for (const r of bloquantes) console.log(`      ${r.nom_table}/${r.colonne} = ${r.sous_cible}`)
  }

  if (!ECRIRE) {
    console.log('\nEssai a blanc — rien n\'a ete transfere. Relancer avec --ecrire.')
    return
  }

  // 1) La pause, exigee par la fonction.
  const { error: eP } = await supabase.from('properties')
    .update({ automation_paused: true, paused_at: new Date().toISOString(),
      paused_reason: 'transfert vers la fiche neuve en cours' })
    .eq('id', C.source)
  if (eP) throw new Error(`pause de la source : ${eP.message}`)
  console.log('\n✓ automation_paused = true sur la source')

  // 2) Le transfert, en une transaction.
  const { data, error } = await supabase.rpc('transferer_bien',
    { p_source: C.source, p_cible: C.cible })
  if (error) {
    console.error(`\nTRANSFERT REFUSE : ${error.message}`)
    // ⚠ ON REND LA PAUSE. Une source pausee sans transfert coupe les messages
    // et les codes du voyageur pour rien.
    await supabase.from('properties')
      .update({ automation_paused: false, paused_reason: null }).eq('id', C.source)
    console.error('pause rendue sur la source (aucune donnee deplacee)')
    process.exitCode = 1
    return
  }

  console.log('\n── lignes deplacees')
  let total = 0
  for (const r of data) {
    total += Number(r.deplacees)
    if (Number(r.deplacees)) {
      console.log(`   ${String(r.famille).padEnd(16)} ${String(r.nom_table + '/' + r.colonne).padEnd(44)} ${r.deplacees}`)
    }
  }
  console.log(`   TOTAL ${total}`)

  // ⚠ ON ENREGISTRE LA CLE ABANDONNEE, ET C'EST LA MOITIE DU GESTE.
  // Sans cet enregistrement, `api/cron.js` — qui boucle sur la liste LIVE du
  // compte Beds24, ou le bien reste volontairement — rematerialise la fiche au
  // cycle suivant, reecrit les sejours sous l'ANCIENNE cle et renvoie des
  // messages au voyageur depuis la chaine Beds24. Mesure du 10 septembre :
  // 106 des 786 sejours de La bulle etaient repartis sous `209413` dans les
  // minutes suivant un transfert pourtant verifie a 0 ligne restante.
  // Le transfert et cet enregistrement sont UN SEUL geste.
  const { data: src } = await supabase.from('properties')
    .select('user_id, provider, provider_property_id').eq('id', C.source).maybeSingle()
  if (src && src.provider_property_id) {
    try {
      await noterCleMigree(supabase, {
        userId: src.user_id,
        provider: src.provider,
        propId: src.provider_property_id,
        cibleFiche: C.cible
      })
      console.log(`\n✓ cle ${src.provider} ${src.provider_property_id} enregistree comme MIGREE`)
      console.log('   le cron ne la materialisera plus, ne la synchronisera plus,')
      console.log('   et n\'enverra plus de message depuis cette chaine.')
    } catch (e) {
      console.error(`\n⚠ ENREGISTREMENT DE LA CLE MIGREE ECHOUE : ${e.message}`)
      console.error('   Le transfert est fait, mais le cron va rapatrier les donnees.')
      console.error('   Passer migrations/2026-09-10-cles-provider-migrees.sql, puis relancer.')
      process.exitCode = 1
    }
  }

  const apres = await audit('APRES')
  const resteSource = Object.values(apres.par).reduce((n, v) => n + v.s, 0)
  console.log(`\n${resteSource === 0 ? '✓' : '⚠'} reste ${resteSource} ligne(s) cote source (0 attendu)`)

  const { count } = await supabase.from('rekeying_backup')
    .select('*', { count: 'exact', head: true }).eq('bien_id', C.source)
  console.log(`✓ ${count} entree(s) de sauvegarde dans rekeying_backup`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
