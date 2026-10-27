#!/usr/bin/env node
// scripts/verifier-parite-revenus.js — L'AGREGAT SQL DIT-IL LA MEME CHOSE QUE
// LE MODULE DU DEPOT ? (27 octobre 2026)
//
//   node --env-file=<.env de la base visee> \
//     scripts/verifier-parite-revenus.js [--base=STAGING|PRODUCTION] [--mois=YYYY-MM]
//
// ⚠ POURQUOI CE SCRIPT EXISTE. L'architecture decidee par Thierry deplace le
// calcul des revenus de l'ECRAN vers l'ECRITURE : le writer pose colonnes derivees
// derivees, et deux fonctions SQL les somment. `lib/revenus/mois.js` ne sert
// plus l'ecran — il reste au depot comme ORACLE, et ce script est ce qui rend
// ce mot vrai. Sans lui, « l'oracle » serait un commentaire : du code que plus
// rien n'appelle et que plus rien ne compare.
//
// ⚠ IL NE COMPARE PAS UN RESULTAT A LUI-MEME, et c'est tout l'enjeu. L'oracle
// repart du PAYLOAD BRUT (`snapshot` + `raw`) et refait le chemin entier —
// statut, montant, canal, date de versement. Les colonnes, elles, ont ete
// posees par le writer il y a des jours ou des semaines, avec la table des
// delais de CE moment-la. Un ecart entre les deux n'est donc pas forcement un
// bug du SQL : c'est la question « la base dit-elle encore ce que le code
// calculerait aujourd'hui ? », et c'est exactement ce que le rattrapage de
// 04:00 est charge de refermer.
//
// ⚠ LECTURE SEULE, SANS OPTION POUR EN SORTIR. Il n'y a pas de `--go` ici :
// aucun chemin de ce fichier n'ecrit. C'est pour qu'il puisse tourner en
// PRODUCTION sans autorisation particuliere — un verificateur qu'on hesite a
// lancer ne mesure rien.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { deriverRevenus, aDeriver, estUnBlocage, COLONNES, VERSION } = require('../lib/revenus/derive')
const { tableDesDelais } = require('../lib/revenus/versement')
const { revenusDuMois } = require('../lib/revenus/mois')
const { netDuSejour } = require('../lib/revenus/net-hote')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}

const args = process.argv.slice(2)
const val = (n) => {
  const a = args.find(x => x.startsWith(n + '='))
  return a ? a.slice(n.length + 1) : null
}

// ─── LA BASE SE NOMME PAR SA REFERENCE DE PROJET, JAMAIS PAR SON CONTENU ───
const projet = refDuProjet(URL)
const base = nomDeLaBase(URL)
const annoncee = (val('--base') || '').toUpperCase()
if (annoncee && annoncee !== base) {
  console.error(`ECHEC : --base=${annoncee} annonce, mais SUPABASE_URL pointe sur`)
  console.error(`« ${base} » (projet ${projet}). Un verificateur qui mesure une`)
  console.error('autre base que celle annoncee rend un vert qui ne veut rien dire.')
  process.exit(2)
}
if (base === 'INCONNUE') {
  console.error(`ECHEC : projet « ${projet} » inconnu de lib/empreinte-base.js.`)
  process.exit(2)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })

// ⚠ LE JOUR DE PARIS, ET IL SE VERIFIE. `estRecu` partage la frontiere
// recu / a venir sur un jour CIVIL : le prendre en UTC ferait basculer un
// versement d'un cote a l'autre entre 22 h et minuit l'ete — c'est la famille
// de defauts que le depot a payee deux fois (le format francais « 04 h » rendu
// NaN, et `new Date(null)` qui donne une heure plausible). On formate, PUIS on
// refuse si la forme n'est pas celle attendue.
const jourDeParis = () => {
  const j = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j)) {
    console.error(`ECHEC : le jour de Paris s'est formate en « ${j} », pas en YYYY-MM-DD.`)
    process.exit(2)
  }
  return j
}

const PAGE = 500
const PAGES_MAX = 100
const CENT = (c) => (Number(c || 0) / 100).toFixed(2) + ' €'

// Les colonnes comparees ligne a ligne. `derive_le` est exclu : c'est un
// horodatage d'ecriture, il DOIT differer. Tout le reste doit concorder.
const COMPAREES = COLONNES.filter(c => c !== 'derive_le')

;(async () => {
  console.log(`Base : ${base} (${projet})`)
  console.log(`Regle de derivation du depot : version ${VERSION}`)
  const jour = jourDeParis()
  console.log(`Jour de reference (Europe/Paris) : ${jour}\n`)

  // ─── 1. Les delais ───────────────────────────────────────────────────────
  const { data: lignesDelais, error: eD } = await sb
    .from('delais_versement').select('canal, base, jours, libelle')
  if (eD) {
    console.error('ECHEC : delais_versement illisible —', eD.message)
    process.exit(1)
  }
  const delais = tableDesDelais(lignesDelais || [])
  if (!Object.keys(delais).length) {
    console.error('ECHEC : aucun canal n\'a de delai lisible. L\'oracle ne peut rien dater.')
    process.exit(1)
  }
  console.log(`delais_versement : ${Object.entries(delais)
    .map(([c, r]) => `${c} ${r.base}+${r.jours}j`).join(', ')}`)

  // ─── 2. Les biens, meme resolution que le writer ─────────────────────────
  const uuidParCle = new Map()
  for (let i = 0; i < PAGES_MAX; i++) {
    const { data, error } = await sb.from('properties')
      .select('id, user_id, provider_property_id')
      .order('id').range(i * PAGE, (i + 1) * PAGE - 1)
    if (error) { console.error('ECHEC lecture properties :', error.message); process.exit(1) }
    for (const b of (data || [])) {
      if (b && b.provider_property_id != null) {
        uuidParCle.set(`${b.user_id}|${String(b.provider_property_id)}`, b.id)
      }
    }
    if (!data || data.length < PAGE) break
  }
  console.log(`properties : ${uuidParCle.size} cle(s) provider resolvable(s)\n`)

  // ─── 3. Les reservations, toutes, sans borne ─────────────────────────────
  //
  // ⚠ SANS BORNE DE DATE, ET C'EST OBLIGATOIRE ICI. `fenetreDeLecture` rend
  // `bornable: false` des qu'un canal se verse sur la RESERVATION : un sejour
  // reserve aujourd'hui pour juillet prochain se verse ce mois-ci. Borner
  // ferait disparaitre des lignes des DEUX cotes de la comparaison — un vert
  // obtenu en ne regardant pas.
  const lignes = []
  for (let i = 0; i < PAGES_MAX; i++) {
    const { data, error } = await sb.from('bookings_snapshot')
      .select(`id, user_id, booking_id, property_id, snapshot, raw, raw_hash, `
        + `${COLONNES.join(', ')}`)
      .order('id').range(i * PAGE, (i + 1) * PAGE - 1)
    if (error) {
      console.error('ECHEC lecture bookings_snapshot :', error.message)
      console.error('(si le message nomme une colonne derivee : la migration')
      console.error(' 2026-10-27-revenus-derives.sql n\'est pas appliquee ici.)')
      process.exit(1)
    }
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) break
    if (i === PAGES_MAX - 1) {
      console.error(`ECHEC : ${PAGES_MAX} pages lues et il en reste. Comparaison partielle refusee.`)
      process.exit(1)
    }
  }
  // ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Zero ligne rend zero ecart,
  // donc un vert — le pire resultat possible : celui qui annonce une parite
  // qu'on n'a pas mesuree.
  if (!lignes.length) {
    console.error('ECHEC : zero reservation lue. Rien n\'a ete compare.')
    process.exit(1)
  }
  console.log(`bookings_snapshot : ${lignes.length} ligne(s) lue(s)\n`)

  const ecarts = []
  const maintenant = new Date().toISOString()

  // ═══ ETAGE 1 — LES COLONNES, LIGNE A LIGNE, CONTRE LE MODULE ════════════
  console.log('── Etage 1 : les colonnes derivees contre lib/revenus/derive.js ──')
  let jamaisDerivees = 0
  let perimees = 0
  let perimeesPayload = 0
  let comparees = 0
  const parColonne = new Map()
  // ⚠ LA COUVERTURE PAR COLONNE, et elle manquait. « Aucun ecart » sur une
  // colonne qui vaut `null` des DEUX cotes partout n'est pas une verification :
  // c'est une colonne decoree. Mesure du 27 octobre 2026 : `derive_raw_hash`
  // etait dans ce cas sur 87 lignes, et l'etage 1 concluait quand meme que « les
  // colonnes disent ce que le module calculerait ». On compte donc, pour chaque
  // colonne, combien de lignes l'ont EPROUVEE — c'est-a-dire ont eu une valeur
  // non nulle d'au moins un cote.
  const eprouvee = new Map()
  for (const l of lignes) {
    // ⚠ TROIS MOTIFS DE NE PAS COMPARER, ET LE TROISIEME EST NEUF (dette 112) :
    // une ligne dont le `raw` a change depuis la derivation porte des colonnes
    // PERIMEES. Les comparer au module rendrait un ecart par colonne — un
    // rouge qui dirait vrai sur la donnee et faux sur le code : ce n'est pas
    // une divergence entre la base et le module, c'est une ligne que le
    // rattrapage n'a pas encore reprise.
    const doitReprendre = aDeriver(l)
    let motif = null
    if (l.derive_le == null) motif = 'jamais'
    else if (Number(l.derive_version) !== VERSION) motif = 'version'
    else if (l.raw_hash != null && l.derive_raw_hash !== l.raw_hash) motif = 'payload'

    // ⚠ ET LA CLASSIFICATION DU VERIFICATEUR DOIT DIRE EXACTEMENT CE QUE DIT
    // `aDeriver`. Les deux repondent a la meme question — « cette ligne est-elle
    // a jour ? » — et le jour ou la regle du module gagne un cinquieme cas, ce
    // script ne le saura pas : il recopierait une regle d'argent, ce que la
    // dette 17 a deja coute une fois (l'ecran et le moteur calculaient le prix
    // chacun de leur cote). On ne recopie donc pas la regle pour DECIDER, on la
    // recopie pour NOMMER le motif, et on exige que les deux concordent.
    if (doitReprendre !== (motif !== null)) {
      ecarts.push(`ligne ${l.id} · CLASSIFICATION : aDeriver dit `
        + `« ${doitReprendre ? 'a reprendre' : 'a jour'} », ce script dit `
        + `« ${motif || 'a jour'} » — la regle de peremption a change`)
    }

    if (motif === 'jamais') { jamaisDerivees++; continue }
    if (motif === 'version') { perimees++; continue }
    if (motif === 'payload') { perimeesPayload++; continue }
    comparees++
    const uuid = uuidParCle.get(`${l.user_id}|${String(l.property_id)}`) || null
    // ⚠ `empreinteDuRaw` EST OBLIGATOIRE ICI, ET SON ABSENCE A PRODUIT UN FAUX
    // VERT MESURE LE 27 OCTOBRE 2026 : la base portait 87 `derive_raw_hash` a
    // `null`, le module sans cette option en rendait `null` aussi, et l'etage 1
    // annoncait « aucun ecart » sur une colonne qu'il comparait a elle-meme.
    // Une colonne de la liste `COLONNES` qui ne peut PAS differer n'est pas
    // verifiee : elle est decoree.
    const attendu = deriverRevenus(l.snapshot, l.raw, {
      delais, uuidDuBien: uuid, provider: null, maintenant,
      empreinteDuRaw: l.raw_hash
    })
    for (const col of COMPAREES) {
      const a = attendu[col] === undefined ? null : attendu[col]
      const b = l[col] === undefined ? null : l[col]
      if (a !== null || b !== null) eprouvee.set(col, (eprouvee.get(col) || 0) + 1)
      // `date_versement` revient en « YYYY-MM-DD » des deux cotes, les cents en
      // nombre ; on compare en chaine pour ne pas se faire piper par 0 == '0'.
      if (String(a) !== String(b)) {
        parColonne.set(col, (parColonne.get(col) || 0) + 1)
        if (ecarts.length < 20) {
          ecarts.push(`ligne ${l.id} · ${col} : base « ${b} » / module « ${a} »`)
        }
      }
    }
  }
  console.log(`  ${comparees} ligne(s) comparee(s), `
    + `${jamaisDerivees} jamais derivee(s), ${perimees} a une autre version`)
  if (parColonne.size) {
    console.log('  ⚠ ECARTS PAR COLONNE :')
    for (const [c, n] of [...parColonne].sort((x, y) => y[1] - x[1])) {
      console.log(`     ${c} : ${n}`)
    }
  } else if (comparees === 0) {
    // ⚠ LE FAUX VERT DE L'ETAGE 1, trouve par la review du lot. « Aucun ecart »
    // s'imprimait meme quand ZERO ligne avait ete comparee — une affirmation
    // forte sur une mesure vide. Et c'etait ATTEIGNABLE avec un vert global :
    // sur une base dont le rattrapage n'a pas tourne, toutes les lignes tombent
    // dans « perimees » (une version anterieure), l'etage 1 compare 0 ligne, et
    // l'etage 2 passe si les colonnes v1 sont encore justes. Le script
    // concluait « PARITE ETABLIE » sans avoir rien verifie.
    //
    // Il avait la garde pour les lignes LUES et pour les mois NON VIDES — pas
    // pour les lignes COMPAREES. C'est le defaut que l'etage 1 existe pour
    // empecher, a l'etage 1 lui-meme.
    console.error('\nECHEC : ZERO ligne comparee a l\'etage 1.')
    console.error(`${jamaisDerivees} jamais derivee(s), ${perimees} a une autre `
      + `version, ${perimeesPayload} dont le payload a change depuis le calcul.`)
    console.error('Les colonnes n\'ont donc PAS ete verifiees : lancez le remplissage')
    console.error('ou attendez le rattrapage de 04:00, puis relancez.')
    process.exit(1)
  } else {
    const muettes = COMPAREES.filter(c => !eprouvee.get(c))
    console.log(`  aucun ecart sur ${comparees} ligne(s) et `
      + `${COMPAREES.length - muettes.length}/${COMPAREES.length} colonne(s) eprouvee(s) : `
      + 'les colonnes disent ce que le module calculerait aujourd\'hui.')
    if (muettes.length) {
      // ⚠ UN AVERTISSEMENT, PAS UN ECHEC, et c'est raisonne : sur une petite
      // base, une colonne peut legitimement etre nulle partout (aucun sejour
      // non calculable, aucun blocage). Mais on la NOMME, pour qu'un « aucun
      // ecart » ne se lise pas comme « tout verifie ».
      console.log(`  ⚠ ${muettes.length} colonne(s) NULLES des deux cotes partout, `
        + 'donc non eprouvees : ' + muettes.join(', '))
    }
  }
  // ⚠ ET LE RATTRAPAGE DE 04:00 EST CE QUI REFERME LES TROIS COMPTEURS. Des
  // lignes « jamais derivees », « a une autre version » ou « payload change »
  // ne sont pas un ecart : ce sont des lignes que l'agregat ne voit pas encore.
  // Mais si elles persistent d'un jour sur l'autre, le rattrapage ne tourne
  // pas. ⚠ Et le troisieme compteur vaut TOUTES LES LIGNES juste apres la
  // migration du 27 octobre 2026 : `derive_raw_hash` y nait a `null`, donc
  // chaque ligne est a reprendre une fois. C'est voulu, et c'est pour cela que
  // ce script ECHOUE tant que le rattrapage n'a pas tourne : il refuse de dire
  // « parite etablie » sur zero ligne comparee.
  if (jamaisDerivees || perimees || perimeesPayload) {
    const attente = jamaisDerivees + perimees + perimeesPayload
    console.log(`  → ${attente} ligne(s) attendent le rattrapage de 04:00 `
      + `(${jamaisDerivees} jamais, ${perimees} version, ${perimeesPayload} payload).`)
    console.log('    Si ce nombre ne baisse pas demain, c\'est le cron qu\'il faut regarder.')
  }

  // ═══ ETAGE 2 — L'AGREGAT SQL CONTRE L'ORACLE ════════════════════════════
  //
  // ⚠ SUR PLUSIEURS MOIS, PAS SUR UN SEUL. Un mois vide est d'accord avec
  // n'importe quoi : comparer « 0 = 0 » et conclure a la parite est le faux
  // vert le plus facile a fabriquer. On balaye donc une fenetre, et on EXIGE
  // qu'au moins un mois porte des sejours.
  const moisDemande = val('--mois')
  const moisAComparer = []
  if (moisDemande) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(moisDemande)) {
      console.error(`\nECHEC : --mois=${moisDemande} n'est pas un « YYYY-MM ».`)
      process.exit(2)
    }
    moisAComparer.push(moisDemande)
  } else {
    const [an, mo] = jour.split('-').map(Number)
    for (let d = -3; d <= 3; d++) {
      const t = new Date(Date.UTC(an, mo - 1 + d, 1))
      moisAComparer.push(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`)
    }
  }

  const comptes = [...new Set(lignes.map(l => l.user_id).filter(Boolean))]
  if (!comptes.length) {
    console.error('\nECHEC : aucune ligne ne porte de user_id. Rien a agreger.')
    process.exit(1)
  }
  console.log(`\n── Etage 2 : revenus_du_mois / revenus_hors_mois contre lib/revenus/mois.js ──`)
  console.log(`  ${comptes.length} compte(s), mois ${moisAComparer[0]} → ${moisAComparer[moisAComparer.length - 1]}`)

  let sejoursVus = 0
  let moisAvecSejours = 0
  let appels = 0
  let bornesProbantes = 0
  let bornesHorsMois = 0

  for (const compte of comptes) {
    // Les lignes du compte, au format de l'oracle, BLOCAGES EXCLUS — parce que
    // l'agregat SQL les exclut. Le blocage se recalcule par le module, jamais
    // en lisant la colonne : sinon l'etage 2 comparerait la colonne a
    // elle-meme, et un `est_blocage` faux passerait inapercu des deux cotes.
    const brutes = lignes.filter(l => l.user_id === compte)
    const pourOracle = []
    let blocagesExclus = 0
    for (const l of brutes) {
      const s = l.snapshot || {}
      const r = l.raw || {}
      const montant = netDuSejour(s, r, null)
      if (estUnBlocage(s, r, montant && montant.valeur != null)) { blocagesExclus++; continue }
      pourOracle.push({
        booking_id: l.booking_id, property_id: l.property_id, snapshot: s, raw: r
      })
    }

    // ⚠ `revenus_hors_mois` A PRIS UN `p_mois` LE 28 OCTOBRE 2026 (constat
    // GRAVE 3 de la review : ses compteurs d'orphelins sommaient toutes les
    // periodes sous un bandeau mensuel). On l'appelle donc PAR MOIS, dans la
    // boucle ci-dessous, et plus une fois par compte.
    //
    // ⚠ ET `sans_date`, LUI, RESTE TOUS MOIS CONFONDUS — c'est dans la
    // fonction, pas ici : une ligne sans date de versement n'a pas de mois. La
    // comparaison avec l'oracle porte donc sur le premier mois balaye, et sa
    // valeur ne depend pas du mois demande. Si elle en dependait, ce serait
    // l'ecart a trouver.
    let sansDateSql = null
    appels++

    for (const mois of moisAComparer) {
      const oracle = revenusDuMois(pourOracle, delais, mois, jour, null)
      if (oracle === null) {
        console.error(`\nECHEC : l'oracle a refuse le jour « ${jour} ».`)
        process.exit(1)
      }
      const { data: sql, error: eM } = await sb.rpc('revenus_du_mois', {
        p_user_id: compte, p_mois: mois, p_aujourdhui: jour, p_refs: null
      })
      appels++
      const { data: hors, error: eH } = await sb.rpc('revenus_hors_mois', {
        p_user_id: compte, p_mois: mois, p_refs: null
      })
      appels++
      if (eH) {
        console.error(`\nECHEC : revenus_hors_mois a refuse (${compte}, ${mois}) — ${eH.message}`)
        process.exit(1)
      }
      if (sansDateSql === null) {
        sansDateSql = Number((hors && hors[0] && hors[0].sans_date) || 0)
      }
      if (eM) {
        console.error(`\nECHEC : revenus_du_mois a refuse (${compte}, ${mois}) — ${eM.message}`)
        process.exit(1)
      }
      const rangs = sql || []
      const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

      // Totaux : la somme des lignes rendues, y compris la ligne
      // `property_uuid is null` — l'argent est touche meme sans bien connu.
      const tSql = {
        sejours: rangs.reduce((a, r) => a + n(r.sejours), 0),
        recu_cents: rangs.reduce((a, r) => a + n(r.recu_cents), 0),
        a_venir_cents: rangs.reduce((a, r) => a + n(r.a_venir_cents), 0),
        total_cents: rangs.reduce((a, r) => a + n(r.total_cents), 0),
        bruts: rangs.reduce((a, r) => a + n(r.bruts), 0),
        sans_montant: rangs.reduce((a, r) => a + n(r.sans_montant), 0)
      }
      const o = oracle.total
      sejoursVus += o.sejours
      if (o.sejours > 0 || tSql.sejours > 0) moisAvecSejours++

      const dit = (champ, a, b) => {
        if (a !== b) {
          ecarts.push(`${mois} · total ${champ} : SQL ${a} / oracle ${b}`
            + (champ.endsWith('_cents') ? ` (${CENT(a)} / ${CENT(b)})` : ''))
        }
      }
      dit('sejours', tSql.sejours, o.sejours)
      dit('recu_cents', tSql.recu_cents, o.recu_cents)
      dit('a_venir_cents', tSql.a_venir_cents, o.a_venir_cents)
      dit('total_cents', tSql.total_cents, o.total_cents)
      dit('bruts', tSql.bruts, o.bruts)
      dit('sans_montant', tSql.sans_montant, o.refuses.montant)

      // ⚠ LES DEUX COMPTEURS D'ORPHELINS, QUI N'ETAIENT PAS COMPARES DU TOUT
      // (constat de la review du lot). Ce sont precisement les deux champs dont
      // la semantique a divergé — l'un comptait « UUID nul » au lieu de « bien
      // inexistant », l'autre sommait toutes les periodes — et le verificateur
      // ne pouvait pas les voir : il annoncait « PARITE ETABLIE » en les
      // ignorant.
      //
      // ⚠ ET IL FAUT PASSER `refsConnues` A L'ORACLE POUR QU'IL REPONDE. Avec
      // `null`, `lib/revenus/mois.js` traite la liste comme « je ne sais pas »
      // et laisse son compteur a ZERO par construction : la comparaison aurait
      // ete vide des deux cotes, donc verte, donc inutile. On lui donne la
      // liste des cles provider CONNUES du compte — celles qui ont encore un
      // bien dans `properties`.
      const clesConnues = [...uuidParCle.keys()]
        .filter(k => k.startsWith(`${compte}|`))
        .map(k => k.slice(compte.length + 1))
      const oracleOrphelins = revenusDuMois(pourOracle, delais, mois, jour, clesConnues)
      const nHors = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
      const horsSql = {
        sejours: nHors(hors && hors[0] && hors[0].hors_biens),
        cents: nHors(hors && hors[0] && hors[0].hors_biens_cents)
      }
      dit('hors_biens', horsSql.sejours, oracleOrphelins.hors_biens.sejours)
      dit('hors_biens_cents', horsSql.cents, oracleOrphelins.hors_biens.total_cents)

      // Par bien : l'oracle groupe par cle PROVIDER, le SQL par UUID. On
      // traduit l'oracle avec la MEME table que le writer, et une cle
      // irresoluble se compare a la ligne `property_uuid is null`.
      const oParUuid = new Map()
      for (const [cle, v] of Object.entries(oracle.par_bien)) {
        const u = uuidParCle.get(`${compte}|${cle}`) || '(sans bien)'
        const acc = oParUuid.get(u) || { sejours: 0, total_cents: 0, recu_cents: 0, a_venir_cents: 0 }
        acc.sejours += v.sejours; acc.total_cents += v.total_cents
        acc.recu_cents += v.recu_cents; acc.a_venir_cents += v.a_venir_cents
        oParUuid.set(u, acc)
      }
      const sParUuid = new Map()
      for (const r of rangs) {
        const u = r.property_uuid == null ? '(sans bien)' : String(r.property_uuid)
        sParUuid.set(u, {
          sejours: n(r.sejours), total_cents: n(r.total_cents),
          recu_cents: n(r.recu_cents), a_venir_cents: n(r.a_venir_cents)
        })
      }
      // ⚠⚠ LE PERIMETRE D'UN MEMBRE DELEGUE, ET IL N'ETAIT EXERCE PAR RIEN
      // (constat de la review du lot). `p_refs` valait TOUJOURS `null` dans ce
      // script, donc la branche `property_uuid = any(p_refs)` des deux
      // fonctions n'etait jamais executee — ni ici, ni par un test.
      //
      // C'est la SEULE garde de cloisonnement de ces fonctions : elles tournent
      // avec la cle de service, qui contourne la RLS, et elles sont
      // `security invoker`. Une erreur dans cette branche ne se verrait que
      // chez un membre delegue — jamais chez le titulaire, donc jamais en
      // recette.
      //
      // On prend un SOUS-ENSEMBLE STRICT des biens (le premier), et on compare
      // au meme calcul fait par l'oracle sur les seules lignes de ces biens.
      const uuidDuCompte = [...new Set(brutes
        .map(l => uuidParCle.get(`${compte}|${String(l.property_id)}`))
        .filter(Boolean))]
      if (uuidDuCompte.length >= 2) {
        const perimetre = [uuidDuCompte[0]]
        const { data: borne, error: eB } = await sb.rpc('revenus_du_mois', {
          p_user_id: compte, p_mois: mois, p_aujourdhui: jour, p_refs: perimetre
        })
        appels++
        if (eB) {
          console.error(`\nECHEC : revenus_du_mois a refuse un perimetre borne — ${eB.message}`)
          process.exit(1)
        }
        const lignesDuPerimetre = pourOracle.filter(l =>
          perimetre.includes(uuidParCle.get(`${compte}|${String(l.property_id)}`)))
        const attendu = revenusDuMois(lignesDuPerimetre, delais, mois, jour, null)
        const bSql = (borne || []).reduce((a, r) => ({
          sejours: a.sejours + n(r.sejours),
          total_cents: a.total_cents + n(r.total_cents)
        }), { sejours: 0, total_cents: 0 })
        for (const champ of ['sejours', 'total_cents']) {
          if (bSql[champ] !== attendu.total[champ]) {
            ecarts.push(`${mois} · PERIMETRE BORNE (1 bien sur ${uuidDuCompte.length}) · `
              + `${champ} : SQL ${bSql[champ]} / oracle ${attendu.total[champ]}`)
          }
        }
        // ⚠ ET LES RESERVES SE BORNENT AUSSI, ce qui n'etait exerce par RIEN
        // (constat de la review). `revenus_hors_mois` partait avec
        // `p_refs: null` partout, alors que c'est la fonction dont Thierry a
        // fait changer la semantique membre le 27 octobre : « un membre
        // delegue ne doit voir ni le compte ni le montant des sejours sans
        // bien ». Cette branche-la est la seule garde de cloisonnement de ces
        // fonctions, puisque la cle de service contourne la RLS.
        const { data: horsBorne, error: eHB } = await sb.rpc('revenus_hors_mois', {
          p_user_id: compte, p_mois: mois, p_refs: perimetre
        })
        appels++
        if (eHB) {
          console.error(`\nECHEC : revenus_hors_mois a refuse un perimetre borne — ${eHB.message}`)
          process.exit(1)
        }
        const hb = (horsBorne && horsBorne[0]) || {}
        // Un membre ne voit NI le compte NI le montant des sejours sans bien.
        if (n(hb.hors_biens) !== 0 || n(hb.hors_biens_cents) !== 0) {
          ecarts.push(`${mois} · PERIMETRE BORNE · les sejours sans bien FUITENT vers un membre : `
            + `${n(hb.hors_biens)} sejour(s), ${CENT(n(hb.hors_biens_cents))}`)
        }
        bornesHorsMois++

        // ⚠ ET LE PERIMETRE DOIT RETIRER QUELQUE CHOSE. Si le bien choisi porte
        // tout le mois, la comparaison est vraie sans rien prouver du
        // cloisonnement — elle vaudrait « tout = tout ». On ne peut pas
        // l'exiger a chaque mois (un mois peut n'avoir qu'un bien vendu), mais
        // on le COMPTE pour le dire a la fin.
        if (bSql.sejours < tSql.sejours) bornesProbantes++
      }

      for (const u of new Set([...oParUuid.keys(), ...sParUuid.keys()])) {
        const a = sParUuid.get(u) || { sejours: 0, total_cents: 0, recu_cents: 0, a_venir_cents: 0 }
        const b = oParUuid.get(u) || { sejours: 0, total_cents: 0, recu_cents: 0, a_venir_cents: 0 }
        for (const champ of ['sejours', 'total_cents', 'recu_cents', 'a_venir_cents']) {
          if (a[champ] !== b[champ]) {
            ecarts.push(`${mois} · bien ${u} · ${champ} : SQL ${a[champ]} / oracle ${b[champ]}`)
          }
        }
      }
    }

    // Hors mois : tous mois confondus, donc une seule comparaison par compte.
    //
    // ⚠ ET ON REFUSE DE COMPARER UN `null`. `sansDateSql` est affecte DANS la
    // boucle des mois depuis que `revenus_hors_mois` prend un `p_mois` : s'il
    // valait encore `null` ici, c'est que la boucle n'a rien lu — et
    // `null !== 0` fabriquerait un ECART qui n'existe pas, donc un faux rouge
    // sur une mesure absente. C'est la meme discipline que « zero ligne lue
    // fait echouer » : on ne conclut pas sur ce qu'on n'a pas mesure.
    if (sansDateSql === null) {
      console.error(`\nECHEC : aucun mois n'a rendu les reserves pour ${compte}.`)
      console.error('La comparaison « sans date de versement » n\'a pas eu lieu.')
      process.exit(1)
    }
    const attenduSansDate = revenusDuMois(pourOracle, delais, moisAComparer[0], jour, null)
      .hors_mois.refuses.date
    if (sansDateSql !== attenduSansDate) {
      ecarts.push(`compte ${compte} · sans date de versement : `
        + `SQL ${sansDateSql} / oracle ${attenduSansDate}`)
    }
    if (blocagesExclus) {
      console.log(`  compte ${compte} : ${blocagesExclus} blocage(s) exclu(s) des deux cotes`)
    }
  }

  console.log(`  ${appels} appel(s) SQL, ${sejoursVus} sejour(s) vus par l'oracle, `
    + `${moisAvecSejours} mois/compte non vide(s)`)
  // ⚠ LE CLOISONNEMENT SE DIT, MEME QUAND IL N'A PAS PU ETRE EPROUVE. Sur une
  // base a un seul bien, ou dont tous les sejours d'un mois portent le meme
  // bien, la comparaison bornee est vraie sans rien prouver. Le taire laisserait
  // croire que `p_refs` a ete verifie.
  // ⚠ ET LE CLOISONNEMENT DES RESERVES SE DIT, LUI AUSSI.
  if (bornesHorsMois > 0) {
    console.log(`  reserves bornees EPROUVEES sur ${bornesHorsMois} mois/compte `
      + '(un membre ne voit ni le compte ni le montant des sejours sans bien)')
  } else {
    console.log('  ⚠ reserves bornees NON EPROUVEES : aucun compte a deux biens ou plus.')
  }
  if (bornesProbantes > 0) {
    console.log(`  perimetre borne EPROUVE sur ${bornesProbantes} mois/compte `
      + '(le sous-ensemble retirait bien des sejours)')
  } else {
    console.log('  ⚠ perimetre borne NON EPROUVE : aucun sous-ensemble n\'a retire de sejour')
    console.log('    (base a un seul bien, ou un seul bien vendu par mois).')
    console.log('    La branche `p_refs` des deux fonctions reste donc NON MESUREE ici.')
  }

  // ⚠ ET UN BALAYAGE QUI N'A CROISE AUCUN SEJOUR N'EST PAS UNE PARITE. C'est
  // le meme defaut que zero ligne lue, un etage plus haut.
  if (!moisAvecSejours) {
    console.error('\nECHEC : aucun mois compare ne porte de sejour. La parite n\'est pas mesuree.')
    console.error('(utilisez --mois=YYYY-MM sur un mois vendu)')
    process.exit(1)
  }

  console.log('')
  if (ecarts.length) {
    console.error(`⚠ ${ecarts.length} ECART(S) :`)
    for (const e of ecarts.slice(0, 40)) console.error('  ' + e)
    if (ecarts.length > 40) console.error(`  … et ${ecarts.length - 40} autre(s)`)
    console.error('\nPARITE NON ETABLIE.')
    process.exit(1)
  }
  console.log('PARITE ETABLIE : l\'agregat SQL et lib/revenus/mois.js disent la meme chose.')
})().catch(e => {
  console.error('ECHEC inattendu :', e && e.message ? e.message : e)
  process.exit(1)
})
