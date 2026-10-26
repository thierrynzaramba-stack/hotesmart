#!/usr/bin/env node
// scripts/remplir-revenus-derives.js — LE REMPLISSAGE INITIAL des colonnes
// derivees des revenus (architecture decidee par Thierry, 27 octobre 2026).
//
// Le writer pose les colonnes derivees sur toute reservation qu'il ECRIT. Les
// reservations deja en base — 1 436 lignes en production — n'ont jamais ete
// reecrites depuis : elles n'ont donc aucune colonne derivee, et l'ecran les
// verrait comme « non calculable ». Ce script les reprend, UNE FOIS.
//
//   node --env-file=<.env de la base visee> \
//     scripts/remplir-revenus-derives.js [--go] [--base=STAGING|PRODUCTION]
//
// ⚠ SANS `--go` : AUCUNE ECRITURE. Il lit, derive, compare, et imprime ce
// qu'il AURAIT ecrit. Le passage a blanc est le seul moyen de voir ce que la
// derivation produit sur de vraies donnees avant de le figer dans la base.
//
// ⚠ `--go` EXIGE `--base=...` : l'operateur ANNONCE la base, et le script
// verifie la REFERENCE DU PROJET (lib/empreinte-base.js). Le nombre de biens
// ne decide plus — il derive avec la donnee (26 octobre 2026).
//
// ⚠ IL NE TOUCHE QUE LES COLONNES DERIVEES. Ni `snapshot`, ni `raw`, ni
// `property_id` : la cle provider reste la verite du coeur, et `property_uuid`
// vient a cote d'elle. Un script de rattrapage qui reecrit le snapshot
// rouvrirait la detection de changement et renverrait des messages aux
// voyageurs — c'est le vecu du depot sur les cles migrees.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { deriverRevenus, aDeriver, COLONNES, VERSION } = require('../lib/revenus/derive')
const { tableDesDelais } = require('../lib/revenus/versement')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}

const args = process.argv.slice(2)
const val = (n) => {
  const a = args.find(x => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : null
}
const GO = args.includes('--go')
const LIMITE = Number(val('limite')) || 0

const base = nomDeLaBase(URL)
const projet = refDuProjet(URL) || '(illisible)'
if (base === 'INCONNUE') {
  console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging.`)
  console.error(`SUPABASE_URL pointe sur « ${projet} ». Un resultat qui ne dit pas`)
  console.error('OU il a ete obtenu ne prouve rien.')
  process.exit(1)
}
if (GO && !['STAGING', 'PRODUCTION'].includes(String(val('base') || '').toUpperCase())) {
  console.error('ECHEC : --go exige --base=STAGING ou --base=PRODUCTION.')
  console.error(`La base visee est ${base} (${projet}).`)
  process.exit(1)
}
if (GO && String(val('base')).toUpperCase() !== base) {
  console.error(`ECHEC : --base=${val('base')} annonce, la base est ${base} — rien n'est ecrit.`)
  process.exit(3)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

// La cause PRECISE d'un refus de montant, telle que l'amont la nomme.
// ⚠ ON LA REDEMANDE A `netDuSejour` PLUTOT QUE DE LA DEDUIRE : lui seul sait
// laquelle de ses quatorze raisons a mordu, et rededuire ici en ferait une
// quinzieme, fausse au premier changement de l'amont.
function detailDuRefus (snapshot, raw) {
  try {
    const { netDuSejour } = require('../lib/revenus/net-hote')
    const r = netDuSejour(snapshot, raw, null)
    return r.detail || r.motif || null
  } catch (e) {
    return null
  }
}

// ⚠ PAGINATION BORNEE. Une lecture sans borne est TRONQUEE A 1000 LIGNES SANS
// ERREUR — le depot l'a deja paye une fois, sur cette table precisement. Un
// remplissage qui s'arrete a 1000 laisse 436 lignes en « non calculable » et
// n'en dit rien.
const PAGE = 500
const PAGES_MAX = 100

;(async () => {
  console.log(`Base : ${base} (${projet})`)
  console.log(`Mode : ${GO ? '⚠ ECRITURE' : 'A BLANC (aucune ecriture)'}`)
  console.log(`Regle de derivation : version ${VERSION}\n`)

  // ─── 1. Les delais, lus UNE FOIS ────────────────────────────────────────
  const { data: lignesDelais, error: eD } = await sb
    .from('delais_versement').select('canal, base, jours, libelle')
  if (eD) {
    console.error('ECHEC : delais_versement illisible —', eD.message)
    console.error('Sans les delais, aucune date de versement n\'est calculable :')
    console.error('on ne remplit pas des colonnes a null, on s\'arrete.')
    process.exit(1)
  }
  const delais = tableDesDelais(lignesDelais || [])
  console.log(`delais_versement : ${Object.keys(delais).length} canal/canaux `
    + `(${Object.entries(delais).map(([c, r]) => `${c} ${r.base}+${r.jours}j`).join(', ')})`)
  if (!Object.keys(delais).length) {
    console.error('\nECHEC : aucun canal n\'a de delai lisible. Rien a deriver.')
    process.exit(1)
  }

  // ─── 2. Les biens, pour resoudre la cle provider en UUID ────────────────
  //
  // ⚠ UNE SEULE LECTURE, ET UNE TABLE DE CORRESPONDANCE EN MEMOIRE. Resoudre
  // bien par bien ferait 1 436 requetes. Et la cle est le COUPLE
  // (user_id, provider_property_id) : deux comptes peuvent porter le meme
  // numero provider, et les melanger donnerait les revenus d'un hote a l'autre.
  const uuidParCle = new Map()
  let biens = []
  for (let i = 0; i < PAGES_MAX; i++) {
    const { data, error } = await sb.from('properties')
      .select('id, user_id, provider_property_id')
      .order('id').range(i * PAGE, (i + 1) * PAGE - 1)
    if (error) { console.error('ECHEC lecture properties :', error.message); process.exit(1) }
    biens = biens.concat(data || [])
    if (!data || data.length < PAGE) break
  }
  for (const b of biens) {
    if (!b || b.provider_property_id == null) continue
    uuidParCle.set(`${b.user_id}|${String(b.provider_property_id)}`, b.id)
  }
  console.log(`properties : ${biens.length} bien(s), ${uuidParCle.size} cle(s) provider resolvable(s)\n`)

  // ─── 3. Les reservations, par pages ─────────────────────────────────────
  const bilan = {
    lues: 0, aDeriver: 0, ecrites: 0, echecs: 0,
    sansUuid: 0, sansMontant: 0, sansDate: 0, bruts: 0, blocages: 0,
    parStatut: new Map(), parMotif: new Map(), parDetail: new Map(),
    exemples: []
  }
  const compte = (m, k) => m.set(k, (m.get(k) || 0) + 1)
  const maintenant = new Date().toISOString()

  for (let i = 0; i < PAGES_MAX; i++) {
    const { data, error } = await sb.from('bookings_snapshot')
      .select('id, user_id, booking_id, property_id, snapshot, raw, derive_le, derive_version')
      .order('id').range(i * PAGE, (i + 1) * PAGE - 1)
    if (error) {
      console.error('ECHEC lecture bookings_snapshot :', error.message)
      console.error('(si le message nomme une colonne derivee : la migration')
      console.error(' 2026-10-27-revenus-derives.sql n\'est pas appliquee ici.)')
      process.exit(1)
    }
    const page = data || []
    bilan.lues += page.length
    if (!page.length) break

    for (const l of page) {
      if (!aDeriver(l)) continue
      bilan.aDeriver++
      const uuid = uuidParCle.get(`${l.user_id}|${String(l.property_id)}`) || null
      const d = deriverRevenus(l.snapshot, l.raw, {
        delais, uuidDuBien: uuid, provider: null, maintenant
      })
      if (!d.property_uuid) bilan.sansUuid++
      if (d.montant_net_cents == null) bilan.sansMontant++
      if (d.date_versement == null) bilan.sansDate++
      if (d.montant_est_brut === true) bilan.bruts++
      if (d.est_blocage === true) bilan.blocages++
      compte(bilan.parStatut, d.statut_canonique || '(aucun)')
      if (d.motif_non_calculable) {
        compte(bilan.parMotif, d.motif_non_calculable)
        // ⚠ LE MOTIF SEUL NE SUFFIT PAS A DECIDER. « prix_non_calculable » sur
        // 9 lignes sur 86 peut etre normal (deux annulations de 2022, un canal
        // sans payload) ou le signe d'un defaut qui touchera les 1 436 de la
        // production. La cause PRECISE vient de l'amont — `prixVoyageur` a
        // quatorze raisons de refuser, toutes nommees — et c'est elle qui dit
        // ou regarder. Un passage a blanc qui rend un motif generique ne permet
        // pas de decider d'ecrire.
        const detail = detailDuRefus(l.snapshot, l.raw)
        if (detail) compte(bilan.parDetail, detail)
        if (bilan.exemples.length < 5) {
          bilan.exemples.push({
            booking: l.booking_id,
            canal: d.canal || (l.snapshot || {}).source || '(aucun)',
            statut: d.statut_canonique,
            motif: d.motif_non_calculable,
            detail
          })
        }
      }

      if (!GO) continue
      // ⚠ ON ECRIT PAR `id`, LA CLE PRIMAIRE, ET SEULEMENT LES COLONNES DERIVEES.
      // Un upsert sur (user_id, booking_id) reecrirait la ligne entiere et
      // pourrait toucher `snapshot` — donc rouvrir la detection de changement.
      const { error: eU } = await sb.from('bookings_snapshot')
        .update(d).eq('id', l.id)
      if (eU) {
        bilan.echecs++
        if (bilan.echecs <= 3) console.error(`  echec ${l.booking_id} : ${eU.message}`)
      } else bilan.ecrites++
    }

    if (page.length < PAGE) break
    if (i === PAGES_MAX - 1) {
      console.error(`\n⚠ ${PAGES_MAX} pages lues, il en reste peut-etre : relancez.`)
    }
    if (LIMITE && bilan.aDeriver >= LIMITE) {
      console.log(`\n(--limite=${LIMITE} atteinte)`)
      break
    }
  }

  // ─── 4. Le bilan ────────────────────────────────────────────────────────
  console.log('— bilan —')
  console.log(`  reservations lues          : ${bilan.lues}`)
  console.log(`  a deriver                  : ${bilan.aDeriver}`)
  if (GO) {
    console.log(`  ECRITES                    : ${bilan.ecrites}`)
    console.log(`  echecs                     : ${bilan.echecs}`)
  }
  console.log('\n— ce que la derivation donne —')
  console.log(`  sans UUID de bien          : ${bilan.sansUuid}`
    + (bilan.sansUuid ? '  ⚠ cet argent ne sera sur AUCUNE ligne de l ecran' : ''))
  console.log(`  sans montant calculable    : ${bilan.sansMontant}`)
  console.log(`  sans date de versement     : ${bilan.sansDate}`)
  console.log(`  montants BRUTS (commission inconnue) : ${bilan.bruts}`)
  // ⚠ LES BLOCAGES SE COMPTENT, parce que c'est une EXCLUSION. Une regle qui
  // retire des lignes d'un total doit dire combien elle en retire : sans ce
  // chiffre, on ne peut pas distinguer « l'heuristique a bien travaille » de
  // « l'heuristique n'a rien reconnu » — et les deux donnent un ecran propre.
  console.log(`  BLOCAGES (exclus du total et du compte) : ${bilan.blocages}`)
  // ⚠ ET UN BLOCAGE EST TOUJOURS UN SEJOUR SANS MONTANT, par construction :
  // `estUnBlocage` exige que le montant ne soit pas calculable. Le reste est
  // donc une soustraction qui ne peut pas passer sous zero — et si elle y
  // passe, c'est la regle qui a change sans que ce script le sache. On le dit,
  // on ne le rattrape pas : un compteur qui se corrige tout seul est un
  // compteur qui mentira le jour ou il compte faux.
  const nonCalculables = bilan.sansMontant - bilan.blocages
  if (nonCalculables < 0) {
    console.log(`  ⚠ INCOHERENT : ${bilan.blocages} blocage(s) pour seulement `
      + `${bilan.sansMontant} sejour(s) sans montant. Un blocage sans montant`)
    console.log('    manquant veut dire que estUnBlocage a change de regle :')
    console.log('    lib/revenus/derive.js et ce compteur ne sont plus d\'accord.')
  } else {
    console.log(`  dont le montant reste « non calculable » : ${nonCalculables} apres exclusion`)
  }
  console.log('\n  par statut :')
  for (const [s, n] of [...bilan.parStatut.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(s).padEnd(14)} ${n}`)
  }
  if (bilan.parMotif.size) {
    console.log('\n  par motif de non-calcul :')
    for (const [m, n] of [...bilan.parMotif.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(m).padEnd(28)} ${n}`)
    }
  }
  if (bilan.parDetail.size) {
    console.log('\n  CAUSE PRECISE, telle que l amont la nomme :')
    for (const [d, n] of [...bilan.parDetail.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)} x ${d}`)
    }
  }
  if (bilan.exemples.length) {
    console.log('\n  cinq exemples, pour aller voir :')
    for (const e of bilan.exemples) {
      console.log(`    ${e.booking} · ${e.canal} · ${e.statut} · ${e.motif}`
        + (e.detail ? ` — ${e.detail}` : ''))
    }
  }

  // ⚠ UN SCRIPT QUI N'A RIEN LU DOIT ECHOUER. Zero ligne lue sur une table qui
  // en porte 1 436 est une panne, pas un succes — et c'est le faux vert que ce
  // depot a deja paye.
  if (bilan.lues === 0) {
    console.error('\nECHEC : aucune reservation lue. La table est-elle vide, ou')
    console.error('la lecture a-t-elle ete refusee en silence ?')
    process.exit(1)
  }
  if (GO && bilan.echecs) {
    console.error(`\n${bilan.echecs} ECHEC(S) D'ECRITURE — relancez pour reprendre.`)
    process.exit(1)
  }
  console.log(GO ? '\nRemplissage termine.' : '\nPassage a blanc termine. Rien n\'a ete ecrit.')
  process.exit(0)
})().catch(e => { console.error('Exception :', e.message); process.exit(1) })
