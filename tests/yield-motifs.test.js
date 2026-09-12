// tests/yield-motifs.test.js
// LE DEFAUT QU'IL EMPECHE : un hote qui lit `aucune_nuit_avec_occupants` sur
// son ecran. Pire qu'un tiret muet — illisible, ET ça a l'air d'une panne.
//
// Tout le chantier YieldFlow repose sur une regle : un indicateur `null` dit
// « je ne sais pas » ET POURQUOI. Les six modules du moteur portent une
// quarantaine de motifs, et il s'en ajoute a chaque lot. Ce test DERIVE la
// liste depuis les modules — il ne la recopie pas (regle 13 : le departement 72
// avait ete classe en zone A parce qu'une liste de reference avait ete
// retranscrite a la main).
//
// Spec : docs/specs/spec-yieldflow-v1.md §7 (etape 4, lot 4.2)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const MODULES = ['indicateurs', 'capacite', 'pickup', 'reference', 'eclatement', 'vacances']

let traduction = null
test.before(async () => {
  traduction = await import('../shared/yield-motifs.js')
})

// ─── La liste DERIVEE du moteur ──────────────────────────────────────────────

function motifsDuMoteur () {
  const trouves = new Map()   // code -> [ou il a ete vu]
  const noter = (code, ou) => {
    if (!trouves.has(code)) trouves.set(code, [])
    trouves.get(code).push(ou)
  }

  // 1. Les constantes EXPORTEES : la source la plus sure.
  const indicateurs = require('../lib/yield/indicateurs')
  for (const v of Object.values(indicateurs.MOTIFS_NON_CALCULABLE)) noter(v, 'indicateurs')
  const capacite = require('../lib/yield/capacite')
  for (const v of Object.values(capacite.NON_CALCULABLE)) noter(v, 'capacite')
  const pickup = require('../lib/yield/pickup')
  for (const v of Object.values(pickup.DRAPEAUX)) noter(v, 'pickup.DRAPEAUX')
  for (const v of Object.values(pickup.MOTIFS_ECART)) noter(v, 'pickup.MOTIFS_ECART')

  // 2. Les chaines litterales poussees dans `non_calculable` ou rendues comme
  //    motif. ⚠ C'est la moitie qui ECHAPPE aux constantes — et c'est celle
  //    qui grossit a chaque lot, donc celle qu'on oublie.
  for (const nom of MODULES) {
    const src = fs.readFileSync(path.join(RACINE, 'lib/yield', `${nom}.js`), 'utf8')
    const motifs = [
      ...src.matchAll(/non_calculable(?:\.push\(|\s*[:=]\s*)['"]([a-z0-9_]+)['"]/g),
      ...src.matchAll(/non_calculable:\s*['"]([a-z0-9_]+)['"]/g)
    ]
    for (const m of motifs) noter(m[1], nom)
  }

  // 3. ⚠ LA MOITIE QUI ECHAPPE AUX DEUX PREMIERES, ET QUI ETAIT RECOPIEE.
  // Les motifs de comparaison N-1 sont construits dans un ternaire, et
  // `reference.js` rend `non_calculable: s.non_calculable || 'x'` — deux formes
  // que les regex ci-dessus ne voient pas. La premiere version listait ces
  // motifs A LA MAIN, dans le test dont la raison d'etre est de ne jamais
  // retranscrire une liste de reference (releve en review : c'etait la regle 13
  // enfreinte a l'interieur de son propre gardien).
  //
  // On balaie donc TOUTE chaine en `snake_case` citee dans un fichier du
  // moteur, et on ne garde que celles qui ressemblent a un motif : au moins
  // deux mots, et jamais un nom de champ ni une valeur de donnee.
  const CHAMPS = new Set(['date_debut', 'date_fin', 'annee_scolaire', 'stop_sell',
    'min_stay_arrival', 'min_stay_through', 'max_stay', 'base_price', 'user_id',
    'booking_id', 'property_id', 'provider_property_id', 'jours_ouverts',
    'raw_hash', 'inserted_at', 'zone_scolaire', 'prix_minimum', 'amount_type',
    'price_details', 'guest_view', 'decimal_places', 'invoice_items',
    'jour_de_semaine', 'segment_x_jour', 'segment_detaille_x_jour',
    'vacances_zone_du_bien', 'vacances_autre_zone', 'hors_vacances',
    'part_vendue', 'jours_avant', 'date_vente', 'date_vente_fiable',
    'prix_par_nuit', 'prix_total', 'hors_reference', 'long_sejour',
    'numero_ligne', 'meme_jour_calendaire', 'delai_avant_le_debut',
    // Noms de TABLES : une fenetre de contexte large les attrape quand une
    // lecture voisine un motif. Ce ne sont pas des motifs.
    'calendar_inventory', 'bookings_snapshot', 'price_display_log',
    'yield_exceptions', 'school_holidays'])
  for (const nom of MODULES) {
    const src = fs.readFileSync(path.join(RACINE, 'lib/yield', `${nom}.js`), 'utf8')
    // Les chaines litterales du fichier, hors commentaires.
    const sansCommentaires = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const m of sansCommentaires.matchAll(/['"]([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6})['"]/g)) {
      const code = m[1]
      if (CHAMPS.has(code)) continue
      // Un motif est cite dans un contexte de motif : `non_calculable`,
      // `raison`, `push(`, ou une constante de motif.
      // Fenetre large : dans `comparerAN1` le mot `motif` est a 170 caracteres du
      // dernier code du ternaire. Trop etroite, la fenetre ratait la moitie de
      // la famille — et le test des orphelines le disait.
      const autour = sansCommentaires.slice(Math.max(0, m.index - 320), m.index)
      // `motif` couvre le ternaire de `comparerAN1`, ou le code est affecte a
      // une variable avant d'atterrir dans `non_calculable`.
      if (!/(non_calculable|raison|motif|\.push\(|MOTIFS|DRAPEAUX|NON_CALCULABLE|ECART)/.test(autour)) continue
      noter(code, nom)
    }
  }
  return trouves
}

test('LE TEST QUI COMPTE : TOUS les motifs du moteur ont une traduction', () => {
  const duMoteur = motifsDuMoteur()
  // ⚠ UN PLANCHER GLOBAL NE PROUVE RIEN — releve en review : les constantes
  // seules en font 24, donc supprimer les litteraux d'UN module passait sous le
  // radar. On exige que CHAQUE module ait ete visite.
  const parModule = {}
  for (const [, ou] of duMoteur) for (const o of ou) parModule[o] = (parModule[o] || 0) + 1
  for (const m of ['indicateurs', 'capacite', 'pickup', 'reference']) {
    assert.ok(Object.keys(parModule).some(k => k.startsWith(m)),
      `aucun motif derive de ${m} : le derivateur ne cherche plus au bon endroit`)
  }
  assert.ok(duMoteur.size >= 30,
    `le derivateur n'a trouve que ${duMoteur.size} motifs`)

  const sansTraduction = []
  for (const [code, ou] of duMoteur) {
    if (!traduction.MOTIFS[code]) sansTraduction.push(`${code} (${[...new Set(ou)].join(', ')})`)
  }
  assert.deepStrictEqual(sansTraduction, [],
    'motifs sans traduction : l ecran afficherait ces codes bruts a un hote')
})

test('chaque traduction dit la CAUSE, pas seulement un libelle', () => {
  for (const [code, m] of Object.entries(traduction.MOTIFS)) {
    assert.ok(m.titre && m.titre.length >= 3, `${code} : titre manquant`)
    assert.ok(m.quoi && m.quoi.length >= 30,
      `${code} : l'explication doit dire POURQUOI, pas repeter le titre`)
    // ⚠ AUCUN CODE TECHNIQUE DANS LE TEXTE VU PAR L'HOTE.
    assert.ok(!/_[a-z]+_/.test(m.titre), `${code} : le titre contient un code technique`)
  }
})

test('un motif INCONNU est dit, jamais masque', () => {
  // Mieux vaut un code brut visible qu'une case vide dont personne ne saura
  // qu'elle cachait quelque chose. C'est ce qui permettra au prochain lot de
  // reperer un motif oublie EN PRODUCTION, pas seulement en test.
  const m = traduction.motif('motif_du_futur')
  assert.ok(m.inconnu)
  assert.match(m.quoi, /motif_du_futur/)
  assert.strictEqual(traduction.motif(null), null)
})

test('les quatre niveaux de repli de la reference sont traduits', () => {
  const { NIVEAUX } = require('../lib/yield/reference')
  for (const n of NIVEAUX) {
    assert.ok(traduction.NIVEAUX_REFERENCE[n], `niveau « ${n} » sans traduction`)
    assert.ok(traduction.NIVEAUX_REFERENCE[n].quoi.length >= 30, `niveau « ${n} » : explication trop courte`)
  }
  assert.strictEqual(Object.keys(traduction.NIVEAUX_REFERENCE).length, NIVEAUX.length,
    'un niveau traduit qui n existe plus dans le moteur')
})

test('les cinq segments du moteur sont traduits, variantes comprises', () => {
  const { SEGMENTS } = require('../lib/yield/reference')
  for (const s of Object.values(SEGMENTS)) {
    assert.ok(traduction.SEGMENTS[s], `segment « ${s} » sans traduction`)
  }
  // Les variantes detaillees portent un suffixe : `vacances_zone_du_bien:hiver`.
  assert.strictEqual(traduction.nomSegment('vacances_zone_du_bien:hiver'),
    'Vacances de la zone du logement — Hiver')
  assert.strictEqual(traduction.nomSegment('hors_vacances'), 'Hors vacances')
  assert.strictEqual(traduction.nomSegment('pont'), 'Pont')
  assert.strictEqual(traduction.nomSegment(null), '—')
  // Un segment inconnu se montre tel quel plutot que de disparaitre.
  assert.strictEqual(traduction.nomSegment('segment_du_futur'), 'segment_du_futur')
})

test('aucune traduction ORPHELINE : elles designent toutes un motif reel', () => {
  // Une traduction qui ne correspond plus a rien est une fausse assurance :
  // elle laisse croire que le cas est couvert alors que le moteur a change.
  const duMoteur = motifsDuMoteur()
  // Les variantes construites a l'execution (suffixe `_partiel`) n'apparaissent
  // pas telles quelles dans les sources : on les rattache a leur base.
  // ⚠ LE SUFFIXE `_partiel` EST CONSTRUIT A L'EXECUTION
  // (`MOTIFS.AUCUNE_DONNEE_PERSONNES + '_partiel'`), donc il n'apparait pas tel
  // quel dans les sources. On ne neutralise QUE les codes dont la base existe
  // ET dont la concatenation est reellement ecrite quelque part — sinon une
  // traduction orpheline nommee `x_partiel` passerait (releve en review).
  const concatenations = MODULES.map(n =>
    fs.readFileSync(path.join(RACINE, 'lib/yield', `${n}.js`), 'utf8')).join('')
  const orphelines = Object.keys(traduction.MOTIFS).filter(code => {
    if (duMoteur.has(code)) return false
    const base = code.replace(/_partiel$/, '')
    if (base === code) return true
    return !(duMoteur.has(base) && concatenations.includes("+ '_partiel'"))
  })
  assert.deepStrictEqual(orphelines, [],
    'traductions sans motif correspondant dans le moteur')
})

// ─── UN MOTIF TRADUIT MAIS JAMAIS AFFICHE EST AUSSI PERDU QU'UN MOTIF NON
//     TRADUIT ─────────────────────────────────────────────────────────────────
// ⚠ LE CONSTAT LE PLUS STRUCTURANT DE LA REVIEW DU LOT 4.2. Les tests
// precedents prouvent que la TRADUCTION existe, jamais qu'un chemin l'affiche.
// Treize motifs sur quarante et un etaient morts — dont les six raisons de
// capacite, dont la plus grave affichait « vous n'avez pas renseigne votre
// calendrier » a un hote Beds24 qui n'en a pas. `npm test` etait vert.

const ECRAN = path.join(RACINE, 'apps/yield/index.html')

// Les codes que l'ecran peut reellement rendre : ceux qu'il cite en clair, plus
// ceux qui lui arrivent par un champ de l'API qu'il affiche sans les nommer.
function codesAffichables () {
  const src = fs.readFileSync(ECRAN, 'utf8')
  const cites = new Set([...src.matchAll(/['"]([a-z][a-z0-9_]{6,})['"]/g)].map(m => m[1]))

  // ⚠ LES CHAMPS RELAYES EN BLOC. `badges(r.non_calculable)`,
  // `badgeMotif(v.non_calculable)` : l'ecran ne nomme aucun code, il affiche
  // ce que l'API lui donne. On note QUELS champs sont relayes, et le test
  // suivant verifie que chaque motif transite par l'un d'eux.
  const relais = {
    // champ de la reponse -> vrai si l'ecran l'affiche
    realise_non_calculable: /badges\(restants\)/.test(src),
    projection_non_calculable: /badges\(\(p\.non_calculable/.test(src),
    pickup_drapeaux: /badges\(\(a\.drapeaux/.test(src),
    reference_non_calculable: /v\.non_calculable \? \[v\.non_calculable\]/.test(src),
    courbe_non_calculable: /v\.non_calculable \? \[v\.non_calculable\]/.test(src),
    comparaison_non_calculable: /badgeMotif\(c\.non_calculable\)/.test(src),
    capacite_raison: /r\.capacite_raison/.test(src)
  }
  return { cites, relais, src }
}

test('LE TEST QUI COMPTE : chaque motif traduit a un chemin d affichage', () => {
  const { cites, relais, src } = codesAffichables()

  // Les sept relais doivent tous exister : c'est par eux que passent les
  // motifs que l'ecran ne nomme pas un par un.
  for (const [nom, present] of Object.entries(relais)) {
    assert.ok(present, `le relais « ${nom} » a disparu de l ecran : les motifs qu il portait sont muets`)
  }

  // ⚠ CES MOTIFS-LA DOIVENT ETRE CITES EXPLICITEMENT, parce qu'aucun relais ne
  // les porte : ils viennent d'un champ que l'ecran doit aller chercher.
  const EXIGES = [
    // Les six raisons de capacite : elles arrivent par `capacite_raison`, pas
    // par `non_calculable`. Sans traitement dedie, l'ecran affichait le motif
    // GENERIQUE — et donc une explication fausse.
    'provider_sans_memoire_intention', 'memoire_non_amorcee',
    'futur_sans_memoire_intention', 'base_price_non_selectionne',
    // Le RevPAR partiel nuance une valeur PRESENTE : `cell()` jetait ses
    // motifs des qu'une valeur existait.
    'revpar_sur_ca_partiel',
    // Les dates de vente ecartees, explicitement demandees par le product owner.
    'date_de_vente_non_fiable',
    // Les drapeaux qui disqualifient le N-1 du pickup : sans eux, la colonne
    // « CA N-1 » affiche « 0 € » la ou la verite est « rien de visible ».
    'aveugle_avant_bascule', 'periode_n1_fermee_a_la_vente', 'capacite_n1_non_amorcee',
    // Les limites de lecture, qui n'ont de place nulle part ailleurs.
    'hors_fenetre_du_contexte', 'date_invalide', 'fenetre_invalide',
    'segment_non_reconnu',
    // En legende, pas sur chaque ligne — mais presents.
    'capacite_en_personnes_inconnue', 'aucune_nuit_avec_occupants'
  ]
  const muets = EXIGES.filter(c => !cites.has(c))
  assert.deepStrictEqual(muets, [],
    'motifs traduits qu aucun chemin de l ecran ne peut afficher')

  // ⚠ AUCUN MOTIF RETIRE D UN ENDROIT SANS ETRE REPRIS AILLEURS.
  // Un motif peut legitimement quitter une colonne — parce qu il y criait a
  // chaque ligne — mais il doit alors reapparaitre quelque part : en legende,
  // en alerte de tete, ou dans une autre colonne. Sinon il est simplement
  // perdu, et c est le defaut que tout ce fichier combat.
  // ⚠ `[a-z0-9_]`, pas `[a-z_]` : `portefeuille_n1_reconstruit` contient un
  // chiffre, et la classe sans chiffres ne matchait RIEN — le test passait en
  // ne verifiant rien du tout.
  // ⚠ SEULEMENT LES RETRAITS DANS UN FILTRE D'AFFICHAGE. Un `vue !==
  // 'exploration'` compare un nom de vue, pas un motif : la premiere version
  // l'attrapait et reclamait une « reprise » pour un mot qui n'en est pas un.
  const retires = [...new Set(
    [...src.matchAll(/\.filter\([^)]*?[a-z]+ !== '([a-z0-9_]+)'/gs)].map(m => m[1])
  )]
  // Chaque retrait doit etre accompagne d une reprise, verifiee nommement.
  const REPRISES = {
    // Vrai sur TOUTES les lignes du pickup : explique une fois sous le tableau.
    portefeuille_n1_reconstruit: /N-1 est reconstruit, jamais observé/,
    // Remonte en alerte de tete : c est le premier geste a faire, pas une note
    // de bas de colonne repetee trente-deux fois.
    periode_fermee_a_la_vente: /période\(s\) fermée\(s\) à la vente/
  }
  for (const code of retires) {
    assert.ok(REPRISES[code],
      `« ${code} » est retire de l affichage sans reprise declaree`)
    assert.match(src, REPRISES[code],
      `« ${code} » est retire mais sa reprise a disparu : le motif est muet`)
  }
})

// ⚠ CE QUI ETAIT ICI EST PARTI DANS `tests/yield-ecran.test.js`.
// Trois assertions verifiaient la MISE EN FORME du source (`/vue === 'pilotage'
// \s*\n\s*\? d\.realise\.filter/`…) : renommer une variable ou reformater un
// ternaire les cassait sans changer le comportement, et inversement elles ne
// disaient rien de ce que le filtre garde. Releve en review. Le test de rendu
// execute le vrai code sur une reponse fabriquee et lit le HTML produit —
// c'est la difference entre la forme et la correction (regle 13).

test('les drapeaux d ecran ne polluent pas la table des motifs du moteur', () => {
  // `capacite_estimee`, `periode_a_venir`… ne designent aucun motif du moteur :
  // les mettre dans MOTIFS ferait echouer le test des orphelines, a juste titre.
  for (const code of Object.keys(traduction.DRAPEAUX_ECRAN)) {
    assert.ok(!traduction.MOTIFS[code],
      `« ${code} » est un drapeau d ecran : il n a rien a faire dans MOTIFS`)
    assert.ok(traduction.motif(code) && !traduction.motif(code).inconnu,
      `« ${code} » doit rester affichable`)
  }
})
