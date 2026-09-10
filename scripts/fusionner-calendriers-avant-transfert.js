// scripts/fusionner-calendriers-avant-transfert.js
// Fusionne le calendrier de l'ANCIENNE fiche dans la NEUVE, avant transfert.
//
// ⚠ POURQUOI CETTE FUSION EXISTE, MESURE LE 10 SEPTEMBRE 2026.
// Le soir de la bascule, Thierry a ferme tout a la vente — sur la fiche NEUVE,
// devenue pilotable. Mais ses vrais prix Beds24 (89 a 130 €) etaient restes sur
// l'ANCIENNE. Les deux calendriers portent donc chacun une moitie de sa
// verite : 875 dates fermees d'un cote, 22 dates tarifees de l'autre, et
// 21 dates communes.
//
// `calendar_inventory` porte `UNIQUE (property_id, date)` : deplacer la source
// telle quelle violait l'index sur ces 21 dates et annulait TOUTE la
// transaction du transfert.
//
// LA REGLE, DECIDEE PAR THIERRY :
//   - `stop_sell` de la fiche NEUVE, conserve partout — c'est sa decision la
//     plus recente, et la plus consequente : rien ne doit se rouvrir ;
//   - `rate` de l'ANCIENNE, recupere la ou la neuve n'en a pas — sinon la
//     grille tarifaire du 23 serait perdue, et introuvable au moment de la
//     reouverture ;
//   - sur une date ou les DEUX portent un prix, la NEUVE gagne : plus recente.
// Aucune des deux intentions n'est sacrifiee.
//
// ⚠ ECRITURE DIRECTE DANS `calendar_inventory`, ET C'EST UNE EXCEPTION ASSUMEE.
// Le writer unique de cette table est `api/calendar.js` POST (regle du depot) :
// c'est la memoire d'intention de l'hote, elle ne s'ecrit pas depuis n'importe
// ou. Ici l'operation est une MIGRATION ponctuelle, explicitement autorisee, et
// elle ne cree aucune intention — elle deplace celles qui existent. Ne pas en
// faire un precedent.
//
// ⚠ SAUVEGARDE AVANT SUPPRESSION. Les lignes de la source sont copiees dans
// `rekeying_backup` AVANT d'etre supprimees : `transferer_bien` fait sa propre
// sauvegarde, mais il tournera APRES, quand ces lignes n'existeront plus.
//
// DRY RUN par defaut.
// USAGE : node scripts/fusionner-calendriers-avant-transfert.js <coeur-23> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')

const CIBLES = {
  'coeur-23': {
    nom: 'coeur de vie 23',
    source: '49b2d1f6-b8df-43ba-b636-fa4f73713c4b',
    cible: 'efe1daf1-652c-4177-b29b-19f1db377c96',
    // Les menages en doublon a supprimer sur la fiche neuve : ils viennent des
    // 2 sejours Airbnb que Channex a livres avant le transfert. Les anciens,
    // eux, portent l'affectation ACCEPTEE et suivront la fiche ; le cron
    // reaffectera les nouveaux d'office des que
    // `property_cleaning_providers` aura suivi.
    menages_doublons_cle: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66',
    menages_doublons_dates: ['2026-09-13', '2026-09-20']
  }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/fusionner-calendriers-avant-transfert.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

async function toutLire (fiche) {
  const t = []
  let de = 0
  for (;;) {
    const { data, error } = await supabase.from('calendar_inventory')
      .select('*').eq('property_id', fiche).order('date').range(de, de + 499)
    if (error) throw new Error(`calendar_inventory : ${error.message}`)
    t.push(...(data || []))
    if (!data || data.length < 500) break
    de += 500
  }
  return t
}

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  ${C.nom}`)

  const src = await toutLire(C.source)
  const cib = await toutLire(C.cible)
  const parDateCible = new Map(cib.map(x => [x.date, x]))

  const aCreer = []        // dates presentes SEULEMENT a la source
  const aEnrichir = []     // dates communes, la neuve n'a pas de prix
  const laisser = []       // dates communes, la neuve garde le sien
  const passees = []       // dates deja ecoulees : ignorees, voir plus bas
  const auj = new Date().toISOString().slice(0, 10)
  for (const l of src) {
    // ⚠ ON N'IMPORTE PAS UNE DATE PASSEE, ET LA RAISON EST CONCRETE.
    // La seule date que la fiche neuve n'avait pas etait le 9 septembre —
    // hier — et elle porte `stop_sell = false`. La creer aurait ajoute la
    // SEULE date non fermee de la fiche, pour memoriser le prix d'une nuit
    // deja ecoulee. `calendar_inventory` est une memoire d'INTENTION de vente :
    // une nuit passee n'en porte plus. Le revenu, lui, vit dans
    // `bookings_snapshot`, et la ligne reste dans `rekeying_backup`.
    if (l.date < auj) { passees.push(l); continue }
    const c = parDateCible.get(l.date)
    if (!c) { aCreer.push(l); continue }
    const cibleAPrix = c.rate != null && Number(c.rate) > 0
    const srcAPrix = l.rate != null && Number(l.rate) > 0
    if (!cibleAPrix && srcAPrix) aEnrichir.push({ date: l.date, rate: Number(l.rate), avant: c })
    else laisser.push({ date: l.date, cible: c.rate, source: l.rate })
  }

  console.log(`\n   source ${src.length} dates | cible ${cib.length} dates`)
  if (passees.length) {
    console.log(`   ${passees.length} date(s) PASSEE(S) ignoree(s) : ${passees.map(x => x.date).join(', ')}`)
    console.log(`      (une nuit ecoulee ne porte plus d'intention de vente ; conservee dans rekeying_backup)`)
  }
  console.log(`   ${aCreer.length} date(s) a CREER sur la neuve (absentes chez elle)`)
  for (const l of aCreer) console.log(`      ${l.date}  rate=${l.rate}  stop_sell=${l.stop_sell}`)
  console.log(`   ${aEnrichir.length} date(s) a ENRICHIR (prix recupere, stop_sell de la neuve intact)`)
  for (const e of aEnrichir.slice(0, 10)) console.log(`      ${e.date}  rate ${e.avant.rate} -> ${e.rate}  stop_sell reste ${e.avant.stop_sell}`)
  if (aEnrichir.length > 10) console.log(`      … et ${aEnrichir.length - 10} autres`)
  console.log(`   ${laisser.length} date(s) INCHANGEE(S) (la neuve a deja un prix, elle gagne)`)
  for (const l of laisser) console.log(`      ${l.date}  neuve ${l.cible} € garde, ancienne ${l.source} € ignoree`)

  // ⚠ ON N'OUVRE JAMAIS UNE DATE. Controle explicite : aucune ecriture ne doit
  // toucher `stop_sell`. C'est la seule chose qui, mal faite, remettrait le bien
  // en vente — l'inverse exact de la decision du soir.
  const toucheStopSell = aEnrichir.some(e => 'stop_sell' in { rate: 1 })
  console.log(`\n   ⚠ controle : aucune ecriture ne touche stop_sell -> ${toucheStopSell ? 'FAUX' : 'confirme'}`)

  const { count: mnDbl } = await supabase.from('menages')
    .select('*', { count: 'exact', head: true })
    .eq('property_id', C.menages_doublons_cle).in('departure_date', C.menages_doublons_dates)
  console.log(`   ${mnDbl} menage(s) en doublon a supprimer sur la fiche neuve (${C.menages_doublons_dates.join(', ')})`)

  if (!ECRIRE) { console.log('\nEssai a blanc — rien ecrit. Relancer avec --ecrire.'); return }

  // ── 1) SAUVEGARDE des lignes de la source, avant toute suppression ────────
  const { data: propSrc } = await supabase.from('properties')
    .select('provider_property_id').eq('id', C.source).single()
  const { data: propCib } = await supabase.from('properties')
    .select('provider_property_id').eq('id', C.cible).single()
  const { error: eBk } = await supabase.from('rekeying_backup').insert({
    bien_id: C.source,
    source: propSrc.provider_property_id,
    cible: propCib.provider_property_id,
    nom_table: 'calendar_inventory (fusionnee puis supprimee)',
    lignes: src
  })
  if (eBk) throw new Error(`sauvegarde : ${eBk.message}`)
  console.log(`\n✓ ${src.length} ligne(s) de la source sauvegardees dans rekeying_backup`)

  // ── 2) ENRICHISSEMENT : le prix seul, jamais stop_sell ────────────────────
  let enrichies = 0
  for (const e of aEnrichir) {
    const { error } = await supabase.from('calendar_inventory')
      .update({ rate: e.rate }).eq('property_id', C.cible).eq('date', e.date)
    if (error) { console.error(`   echec ${e.date} : ${error.message}`); continue }
    enrichies++
  }
  console.log(`✓ ${enrichies}/${aEnrichir.length} date(s) enrichie(s) du prix de l'ancienne`)

  // ── 3) CREATION des dates absentes de la neuve ────────────────────────────
  let creees = 0
  for (const l of aCreer) {
    const { id, property_id, updated_at, ...reste } = l
    const { error } = await supabase.from('calendar_inventory')
      .insert({ ...reste, property_id: C.cible })
    if (error) { console.error(`   echec creation ${l.date} : ${error.message}`); continue }
    creees++
  }
  console.log(`✓ ${creees}/${aCreer.length} date(s) creee(s) sur la fiche neuve`)

  // ── 4) SUPPRESSION du calendrier de la source, absorbe ────────────────────
  // Sans elle, `transferer_bien` tenterait de deplacer ces lignes vers des
  // dates qui existent maintenant sur la cible : 21 violations de
  // UNIQUE(property_id, date), et toute la transaction annulee.
  const { error: eDel } = await supabase.from('calendar_inventory')
    .delete().eq('property_id', C.source)
  if (eDel) throw new Error(`suppression source : ${eDel.message}`)
  const { count: resteSrc } = await supabase.from('calendar_inventory')
    .select('*', { count: 'exact', head: true }).eq('property_id', C.source)
  console.log(`✓ calendrier de la source supprime (reste ${resteSrc}, 0 attendu)`)

  // ── 5) LES 2 MENAGES EN DOUBLON ───────────────────────────────────────────
  const { data: mnAvant } = await supabase.from('menages')
    .select('id, departure_date, status, provider_id')
    .eq('property_id', C.menages_doublons_cle).in('departure_date', C.menages_doublons_dates)
  for (const m of mnAvant || []) {
    console.log(`   supprime menage ${m.id} depart ${m.departure_date} statut ${m.status}`
      + `${m.provider_id ? ' ⚠ AFFECTE — verifier' : ' (non affecte, comme attendu)'}`)
  }
  const { error: eMn } = await supabase.from('menages')
    .delete().eq('property_id', C.menages_doublons_cle).in('departure_date', C.menages_doublons_dates)
  if (eMn) throw new Error(`menages : ${eMn.message}`)
  console.log(`✓ ${(mnAvant || []).length} menage(s) en doublon supprime(s)`)

  // ── PREUVE ────────────────────────────────────────────────────────────────
  const apres = await toutLire(C.cible)
  const ouvertes = apres.filter(x => x.stop_sell !== true)
  const tarifees = apres.filter(x => x.rate != null && Number(x.rate) > 0)
  console.log(`\n── PREUVE sur la fiche neuve`)
  console.log(`   ${apres.length} dates | ${tarifees.length} tarifee(s) | ${ouvertes.length} NON fermee(s)`)
  if (ouvertes.length) console.log(`   ⚠ ${ouvertes.slice(0, 15).map(x => x.date).join(', ')}`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
