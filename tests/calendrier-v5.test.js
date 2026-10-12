// tests/calendrier-v5.test.js — page « Calendrier » V5, lot 3 ETAPE 1.
// Spec : docs/specs/spec-refonte-ui-v5-lot-calendrier.md §14.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')
const html = () => lire('pages/calendrier.html')

// ─── Regles V5 ───────────────────────────────────────────────────────────────
test('calendrier : aucun hexa, aucun emoji, aucune icone dessinee', () => {
  const src = sansCommentaires(html())
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(src), 'forme SVG dessinee dans la page')
})

test('calendrier : chaque cle de texte existe dans les trois langues', () => {
  const src = html()
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...src.matchAll(/data-i18n-attr="[^"]*?:([\w.]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1])
  ])
  // Cles DYNAMIQUES (t('cal.param_' + k), t('cal.open_' + id)...) :
  // couvertes nominativement juste apres.
  for (const k of [...cles]) if (k.endsWith('_')) cles.delete(k)
  assert.ok(cles.size > 40, 'extraction vide')
  const PARAMS = ['minStayArr', 'minStayThrough', 'maxStay', 'avail', 'cta', 'ctd', 'stopSell']
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : cle « ${k} » absente`)
    for (const k of PARAMS) assert.ok(('cal.param_' + k) in d, `${l} : cle dynamique cal.param_${k} absente`)
    for (const k of ['avail', 'cta', 'ctd', 'stopSell']) {
      assert.ok(('cal.open_' + k) in d && ('cal.closed_' + k) in d, `${l} : cles open/closed_${k} absentes`)
    }
  }
})

test('calendrier : devise via Intl partout, jamais un symbole en dur (constat 7)', () => {
  const src = sansCommentaires(html())
  assert.ok(!/['"`][€£$]['"`]/.test(src), 'symbole monetaire en dur')
  assert.ok(src.includes('prixIntl('), 'les prix passent par le contrat partage')
  // Et la preuve GBP, par la fonction elle-meme.
  return import('../shared/calendrier-contrat.js').then(({ prixIntl }) => {
    assert.ok(prixIntl(95, 'GBP', 'fr').includes('£'), 'un bien GBP affiche £')
    assert.ok(prixIntl(120, 'EUR', 'fr').includes('€'))
    assert.equal(prixIntl(null, 'EUR', 'fr'), null, 'pas de prix n\'est pas un prix a zero')
  })
})

// ─── Le contrat de parite (§14) ──────────────────────────────────────────────
test('parite : actions, rubriques et champs de fiche viennent du CONTRAT partage', async () => {
  const { ACTIONS_BARRE, RUBRIQUES_POPUP, CHAMPS_FICHE, etatDeNuit } = await import('../shared/calendrier-contrat.js')
  assert.equal(ACTIONS_BARRE.length, 5, 'les CINQ actions de la spec §4.2')
  assert.deepEqual(ACTIONS_BARRE.map(a => a.id), ['prix', 'fermer', 'bloquer', 'reservation', 'plus'])
  assert.equal(RUBRIQUES_POPUP.length, 10)
  assert.ok(RUBRIQUES_POPUP.some(r => r.id === 'stopSell'), 'stop vente DANS la popup (constat 9 : il manquait au telephone)')
  assert.ok(RUBRIQUES_POPUP.some(r => r.id === 'orphelines'), 'reglages orphelines dans la popup (arbitrage (d))')
  assert.ok(CHAMPS_FICHE.some(c => c.id === 'statut'), 'la ligne Statut sur les DEUX ecrans (constat 6)')
  const src = sansCommentaires(html())
  assert.ok(src.includes('ACTIONS_BARRE.map('), 'la barre flottante consomme le contrat')
  assert.ok(src.includes('RUBRIQUES_POPUP.map('), 'la popup consomme le contrat')
  assert.ok(src.includes('CHAMPS_FICHE'), 'la fiche consomme le contrat')
  // Les QUATRE etats (§4.1, dette 20) et leurs priorites.
  assert.equal(etatDeNuit({ vendue: true, fermee: true, horsFenetre: true }), 'vendue')
  assert.equal(etatDeNuit({ vendue: false, fermee: true, horsFenetre: true }), 'attente',
    'hors fenetre du pilote : « pas encore ouverte », pas « fermee » — meme si le retrait a pose stop_sell')
  assert.equal(etatDeNuit({ vendue: false, fermee: true, horsFenetre: false }), 'fermee')
  assert.equal(etatDeNuit({ vendue: false, fermee: false, horsFenetre: false }), 'ouverte')
})

test('orphelines : la detection est un MODULE COMMUN (constat 8), regle de l\'ancien mobile', async () => {
  const { detecterOrphelines } = await import('../shared/nuits-orphelines.js')
  const inv = { '2026-11-10': { min_stay_arrival: 3 } }
  const libres = new Set(['2026-11-10'])
  // Une seule nuit libre coincee entre deux occupees, min 3 nuits -> orpheline.
  const r = detecterOrphelines(['2026-11-09', '2026-11-10', '2026-11-11'], {
    estLibre: iso => libres.has(iso),
    inventaire: iso => inv[iso]
  }, 2)
  assert.ok(r.has('2026-11-10'), 'nuit non couvrable detectee')
  assert.ok(!r.has('2026-11-09'), 'une nuit occupee n\'est jamais orpheline')
  // La meme nuit avec min 1 et voisines libres : vendable.
  const r2 = detecterOrphelines(['2026-11-10'], { estLibre: () => true, inventaire: () => undefined }, 2)
  assert.equal(r2.size, 0)
})

// ─── Inventaire §12, chaque ligne NOMMEE (§14) ──────────────────────────────
test('inventaire §12 : chaque fonction de l\'etape 1 est presente, manquantes nommees', () => {
  const src = html()
  const LIGNES = {
    'bulles de biens non affiches avec photo, Beds24 grisees (retouche pt 4)': 'cal-bulle--grise',
    'bouton reduire : le bloc repart en bulle (retouche pt 4)': 'data-reduire=',
    'periode 1/3/6/12 mois': 'data-mois="12"',
    'navigation non persistee (pas de decalage en localStorage)': 'decalage: 0',
    'lignes masquees par defaut, cochees au menu ... (retouche pt 3)': 'etat.epingles.includes(k))',
    'identite du bien dans la colonne gauche (retouche pt 2)': 'cal-bien__photo',
    'liseres de week-end (retouche pt 1)': 'cal-we--debut',
    'epinglage de lignes PERSISTE': 'epingles: etat.epingles',
    'lien Tarification vers YieldFlow (recadrage etape 1)': '/apps/yield/prix',
    'bandeau lecture seule': 'cal.readonly',
    'bandeau Beds24': 'cal.beds24_some',
    'etats vides titulaire/membre': 'cal.empty_member',
    'barres couleur = canal (module commun)': 'familleSource(',
    'blocages dessines avec leur raison': 'cal-barre--blocage',
    'les 4 etats en couleur (dette 20)': 'etatDeNuit({ vendue, fermee, horsFenetre })',
    'fenetre du pilote lue de yield-pilote': '/api/yield-pilote?bien=',
    'marque orpheline sur les grilles': 'cal-orpheline',
    'selection clavier (Enter/F2/chiffre)': "e.key === 'F2'",
    'saisie inline du prix (jamais un prompt)': 'cal-nuit__saisie',
    'verdicts du writer (NON PUBLIE, local only, task_ids)': 'cal.push_failed',
    'Annuler du toast = ECRITURE INVERSE (constat 1)': 'valeursAvant.map(v => ({ date_from: v.iso, date_to: v.iso',
    'fermer = stop_sell SEUL': 'stop_sell: true',
    'rouvrir = stop_sell false + avail 1': 'stop_sell: false, avail: 1',
    'bien pilote + fermer -> bascule vers Bloquer': "ouvrirFormulaire('bloquer', jours)",
    'nuit sous blocage -> refus + fiche': 'cal.blocked_reopen',
    'popup serree a aujourd\'hui (constat 5, les deux ecrans)': 'if (du < AUJOURDHUI) du = AUJOURDHUI',
    'garde YieldFlow : tarif retire AVANT mutation': 's.rate === undefined',
    'prix par personne (domaine reglages, si la valeur change)': "kind: 'perPerson'",
    'reglages orphelines dans la popup (arbitrage d)': "kind: 'orphanConfig'",
    'formulaire Reservation / Bloquer les dates (dette 64)': 'cal.type_block',
    'blocage : raison obligatoire, aucun montant': 'cal.block_reason_required',
    'capacite en personnes (module commun)': 'messageCapacite(',
    'confirmation en deux temps (le coeur apprend par le feed)': 'cal.booking_sent',
    'fiche : consultation ouverte a tous': 'droitsResa(',
    'fiche : Ouvrir la conversation resolu par booking_id': '/api/messages?booking_id=',
    'fiche : evaluation par le bus des le jour du depart': 'brancherEvaluation(',
    'fiche : badge pas d\'e-mail': 'badgeSansEmailVisible(',
    'fiche : prix ABSENT du payload si non touche': 'charge.prixParNuit === undefined',
    'fiche : annulation confirmee, la barre reste': 'cal.cancel_confirm',
    'fiche blocage : modifier / supprimer': 'rouvrirFermeture',
    'selecteur de vue mobile conserve (arbitrage a)': 'vue-mobile',
    'mois mobile persiste': 'annee: etat.annee',
    'appui long mobile = selection': "setTimeout(() => {",
    'X-Compte sur les appels directs': 'enteteCompte()'
  }
  const manquantes = Object.entries(LIGNES).filter(([, motif]) => !src.includes(motif)).map(([nom]) => nom)
  assert.deepEqual(manquantes, [], 'fonctions de l\'inventaire ABSENTES : ' + manquantes.join(' ; '))
})

test('textes-contrats de l\'etape 1 presents en fr/en/es (§13)', () => {
  const ATTENDUS = {
    fr: ['La disponibilité et la fermeture se règlent toujours ici', 'aucun automatisme n’y touche jamais', 'Envoyée au canal ✓', 'c’est ce que le calendrier affichera'],
    en: ['Availability and closing are still set here', 'no automation ever touches it', 'Sent to the channel ✓', 'that’s what the calendar will show'],
    es: ['La disponibilidad y el cierre se ajustan siempre aquí', 'ningún automatismo lo toca jamás', 'Enviada al canal ✓', 'es lo que mostrará el calendario']
  }
  for (const [lang, textes] of Object.entries(ATTENDUS)) {
    const d = lire(`shared/i18n/${lang}.json`)
    for (const txt of textes) assert.ok(d.includes(txt), `${lang} : texte-contrat absent « ${txt} »`)
  }
})

// ─── Gardes de perimetre ─────────────────────────────────────────────────────
test('calendrier : aucun appel provider, moteur ou AirROI depuis la page', () => {
  const src = sansCommentaires(html())
  assert.ok(!/channex\.io|beds24\.com|airroi/i.test(src))
  assert.ok(!src.includes('/api/beds24'), 'jamais un provider')
  assert.ok(!src.includes('/api/cron'), 'jamais le moteur')
})

test('etape 1 : les anciennes pages calendrier restent INTACTES (redirection = commit separe apres recette)', () => {
  assert.ok(!lire('pages/biens-calendrier.html').includes("location.replace('/calendrier'"))
  assert.ok(!lire('pages/calendrier-mobile.html').includes("location.replace('/calendrier'"))
  assert.ok(lire('vercel.json').includes('"/calendrier"'), 'la route /calendrier existe')
  assert.ok(!/"destination": "\/pages\/calendrier\.html"/.test(lire('vercel.json')), 'cleanUrls : pas de .html en destination')
})
