// scripts/finir-transfert-supprimer-ancienne.js
// Balaie ce qu'un cron a rapatrie sous l'ancienne cle, puis SUPPRIME
// l'ancienne fiche — sans quoi le transfert n'est pas stable.
//
// ⚠ LE DEFAUT QUE CE SCRIPT REPARE, MESURE LE 10 SEPTEMBRE 2026.
// Vingt minutes apres le transfert de La bulle (2 645 lignes deplacees, 0
// restante, verifie), 104 lignes de `bookings_snapshot` etaient REVENUES sous
// `209413`, plus 21 menages, 2 sms_logs et 1 agent_task. Ecritures horodatees
// 15:15:52, soit apres le transfert, sous le meme compte.
//
// LA CAUSE : l'ancienne fiche reste `provider = 'beds24'` avec
// `provider_property_id = '209413'`. Le cron Beds24 continue donc de la
// synchroniser et reecrit ses snapshots sous l'ancienne cle — et la synchro des
// menages recree les menages correspondants. `automation_paused = true` n'y
// change RIEN : la pause coupe le voyageur (messages, codes), jamais la
// synchro provider. C'est un choix assume du kill switch, pas un oubli.
//
// DONC : le transfert et la suppression de l'ancienne fiche sont UN SEUL geste.
// Les separer laisse une fenetre pendant laquelle le provider reprend ses
// donnees.
//
// ⚠ POURQUOI PAS UN SECOND `transferer_bien`. Sa garde « la cible porte deja du
// calendrier » refuse, et c'est correct : cette garde protege un PREMIER
// transfert. Le balayage est une autre operation — il ne touche que la cle
// provider, pas le calendrier ni les references par UUID, deja deplaces.
//
// ⚠ ET UN MENAGE RAPATRIE NE SE DEPLACE PAS, IL SE SUPPRIME.
// `menages` porte `unique (user_id, property_id, booking_id, departure_date)`.
// Le menage recree sous l'ancienne cle a le MEME `booking_id` que celui deja
// deplace : le deplacer violerait l'index. C'est un doublon du cote sortant, la
// verite est cote cible — on le supprime. Meme logique pour toute table dont
// l'update entre en conflit.
//
// DRY RUN par defaut.
// USAGE : node scripts/finir-transfert-supprimer-ancienne.js <la-bulle|coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')
// ⚠ `--sans-suppression` : BALAYER SANS SUPPRIMER LA FICHE.
// Decision de Thierry du 10 septembre : le bien RESTE dans le compte Beds24
// (regle N2 du plan — les messages historiques doivent etre tranches avant
// toute deconnexion, et Beds24 est le filet de rollback tant qu'aucune resa
// reelle n'a traverse la chaine Channex de bout en bout). Supprimer la fiche
// est de toute facon inutile : `materializeBeds24Properties`
// (lib/cron-beds24-props.js) la RECREE au cycle suivant, mesure le meme jour.
// Le balayage reste utile — il ramene les lignes sous la bonne cle avant une
// poussee tarifaire, qui a besoin des nuits vendues pour calculer le stock.
const SANS_SUPPRESSION = process.argv.includes('--sans-suppression')

const CIBLES = {
  // ⚠ LA SOURCE SE RESOUT PAR SA CLE PROVIDER, PAS PAR UN UUID DE FICHE.
  // La fiche Beds24 de La bulle a ete supprimee puis RECREEE par
  // `materializeBeds24Properties` sous un NOUVEL uuid (58001ed1 -> 4fc4412b).
  // Figer l'uuid rendait le script inutilisable des la premiere recreation.
  'la-bulle': { nom: 'Cœur de vie « La bulle »',
    source_cle: '209413',
    cible: '091d9abf-ff86-45ce-8123-3425e6f3900f' },
  'coeur-23': { nom: 'coeur de vie 23',
    source_cle: '169567',
    cible: 'efe1daf1-652c-4177-b29b-19f1db377c96' }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/finir-transfert-supprimer-ancienne.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

// Les memes listes que le SQL. Tenues ici en dur volontairement : ce script ne
// doit pas dependre d'un appel supplementaire pour savoir ou chercher.
const TABLES = ['access_codes', 'agent_tasks', 'automation_incidents',
  'booking_change_events', 'bookings_snapshot', 'conversations', 'knowledge',
  'menage_comments', 'menage_done', 'menage_events', 'menages',
  'message_templates', 'messages', 'property_cleaning_providers',
  'property_locks', 'property_status', 'sms_logs']
const REFS = [['ota_reviews', 'property_id_ref'],
  ['prestataire_periodes', 'property_id_ref'],
  ['airbnb_connect_sessions', 'provider_property_id']]

async function balayer (srcCle, cibCle, userId) {
  let deplacees = 0
  let supprimees = 0
  const detail = []

  const traiter = async (table, colonne) => {
    const { data, error } = await supabase.from(table).select('id')
      .eq(colonne, srcCle).eq('user_id', userId)

    // ⚠ DEUX TABLES N'ONT PAS DE COLONNE `id` : `property_status`
    // (cle `unique (user_id, property_id)`) et `airbnb_connect_sessions`.
    // Le traitement ligne par ligne y est impossible — on passe par un UPDATE
    // en masse sur la cle naturelle. Elles ne portent au plus qu'une ligne par
    // bien, donc rien a departager. Un echec de lecture SILENCIEUX aurait
    // rendu « rien a faire » sur une table pleine, et le balayage se serait cru
    // termine : c'est exactement ce que la premiere version faisait.
    if (error) {
      if (!/column .* does not exist/.test(error.message)) {
        detail.push(`${table}: LECTURE IMPOSSIBLE (${error.message})`)
        return
      }
      const { count } = await supabase.from(table)
        .select('*', { count: 'exact', head: true })
        .eq(colonne, srcCle).eq('user_id', userId)
      if (!count) return
      if (!ECRIRE) { detail.push(`${table}.${colonne}: ${count} a traiter (sans colonne id)`); return }
      const { error: eUp } = await supabase.from(table)
        .update({ [colonne]: cibCle }).eq(colonne, srcCle).eq('user_id', userId)
      if (!eUp) {
        deplacees += count
        detail.push(`${table}.${colonne}: ${count} deplacee(s) (en masse)`)
        return
      }
      const { error: eDel } = await supabase.from(table)
        .delete().eq(colonne, srcCle).eq('user_id', userId)
      if (eDel) detail.push(`${table}.${colonne}: ni deplacee ni supprimee (${eDel.message})`)
      else { supprimees += count; detail.push(`${table}.${colonne}: ${count} supprimee(s) (doublon)`) }
      return
    }
    if (!data.length) return
    if (!ECRIRE) { detail.push(`${table}.${colonne}: ${data.length} a traiter`); return }

    let d = 0; let s = 0
    for (const ligne of data) {
      const { error: eUp } = await supabase.from(table)
        .update({ [colonne]: cibCle }).eq('id', ligne.id)
      if (!eUp) { d++; continue }
      // Conflit d'unicite : la cible porte deja la verite, la ligne rapatriee
      // est un doublon du cote sortant.
      const { error: eDel } = await supabase.from(table).delete().eq('id', ligne.id)
      if (eDel) detail.push(`${table} id=${ligne.id}: ni deplacee ni supprimee (${eDel.message})`)
      else s++
    }
    deplacees += d; supprimees += s
    detail.push(`${table}.${colonne}: ${d} deplacee(s), ${s} supprimee(s) (doublon)`)
  }

  for (const t of TABLES) await traiter(t, 'property_id')
  for (const [t, c] of REFS) await traiter(t, c)

  // public_tokens.property_ids : tableau, traite a part.
  const { data: pt } = await supabase.from('public_tokens').select('id, property_ids')
    .contains('property_ids', [srcCle]).eq('user_id', userId)
  if (pt && pt.length) {
    if (!ECRIRE) detail.push(`public_tokens: ${pt.length} a traiter`)
    else for (const l of pt) {
      const neuf = [...new Set(l.property_ids.map(x => x === srcCle ? cibCle : x))]
      const { error } = await supabase.from('public_tokens').update({ property_ids: neuf }).eq('id', l.id)
      if (!error) deplacees++
      detail.push(`public_tokens id=${l.id}: ${error ? 'ECHEC ' + error.message : 'reecrit'}`)
    }
  }
  return { deplacees, supprimees, detail }
}

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  bien : ${C.nom}`)

  const { data: T0, error: eT } = await supabase.from('properties')
    .select('id, name, user_id, provider, provider_property_id').eq('id', C.cible).single()
  if (eT) throw new Error(eT.message)
  const T = T0
  const { data: S0, error: eS } = await supabase.from('properties')
    .select('id, name, user_id, provider, provider_property_id')
    .eq('provider', 'beds24').eq('provider_property_id', C.source_cle)
    .eq('user_id', T0.user_id).maybeSingle()
  if (eS) throw new Error(eS.message)
  const S = S0
  C.source = S ? S.id : null
  if (!S) { console.log('\n✓ l ancienne fiche n existe plus — rien a faire'); return }
  if (!T) throw new Error('fiche cible introuvable')
  console.log(`   source ${S.provider}/${S.provider_property_id}  ->  cible ${T.provider}/${T.provider_property_id}`)

  for (let essai = 1; essai <= 4; essai++) {
    console.log(`\n════ passe ${essai}`)
    const r = await balayer(S.provider_property_id, T.provider_property_id, S.user_id)
    for (const d of r.detail) console.log('   ' + d)
    if (!r.detail.length) console.log('   rien sous l ancienne cle')
    if (!ECRIRE) { console.log('\nEssai a blanc — relancer avec --ecrire.'); return }
    console.log(`   ${r.deplacees} deplacee(s), ${r.supprimees} supprimee(s)`)

    if (SANS_SUPPRESSION) {
      console.log('\n✓ balayage fait, fiche CONSERVEE (--sans-suppression)')
      console.log('   ⚠ le cron Beds24 reecrira sous l ancienne cle au prochain cycle')
      console.log('   tant que `materializeBeds24Properties` n exclut pas les cles migrees.')
      return
    }
    const { data: sup, error: eSup } = await supabase.rpc('supprimer_bien_vide', { p_bien: C.source })
    if (!eSup) {
      console.log(`\n✓ ANCIENNE FICHE SUPPRIMEE — le cron Beds24 ne la voit plus`)
      console.log(`   ${JSON.stringify(sup)}`)
      return
    }
    console.log(`   suppression refusee : ${String(eSup.message).slice(0, 140)}`)
    if (essai < 4) console.log('   -> le cron a du reecrire pendant le balayage, on repasse')
  }
  console.log('\n⚠ 4 passes sans y arriver : le cron reecrit plus vite qu on balaie.')
  process.exitCode = 1
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
