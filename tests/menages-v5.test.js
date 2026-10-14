// tests/menages-v5.test.js — page « Ménages » V5, lot 4 ÉTAPE 1 (lecture seule).
// Spec : docs/specs/lot-menages-v5/spec-refonte-ui-v5-lot-menages.md (+ §13).
// Fond : docs/specs/inventaire-menages.md (parties E, F, G).

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
const html = () => lire('pages/menages.html')

// ─── Règles V5 ───────────────────────────────────────────────────────────────
test('ménages : aucun hexa, aucun emoji, aucune icône dessinée', () => {
  const src = sansCommentaires(html())
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(src), 'forme SVG dessinée dans la page')
})

test('ménages : les pastels des prestataires vivent dans theme.css, la page n\'en connaît que le nom', () => {
  const theme = lire('shared/theme.css')
  for (let i = 1; i <= 8; i++) assert.ok(theme.includes(`--presta-${i}:`), `--presta-${i} absent de theme.css`)
  // La page passe par le MODULE partagé (shared/presta-couleur.js), qui seul
  // nomme les jetons — plus aucune copie locale du hash (revue de 4235a21).
  assert.ok(sansCommentaires(html()).includes("from '/shared/presta-couleur.js'"), 'la page importe le module partagé')
  assert.ok(lire('shared/presta-couleur.js').includes('var(--presta-'), 'le module nomme les jetons')
  // Et ui.css reste sans hexa (règle de revue, spec socle §6.1).
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(sansCommentaires(lire('shared/ui.css'))), 'hexa dans ui.css')
})

test('ménages : chaque clé de texte existe dans les trois langues', () => {
  const src = html()
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...src.matchAll(/data-i18n-attr="[^"]*?:([\w.]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1])
  ])
  // Clés DYNAMIQUES (t('menages.tt_' + état), t('menages.retour_' …)) :
  // couvertes nominativement juste après.
  for (const k of [...cles]) if (k.endsWith('_')) cles.delete(k)
  assert.ok(cles.size > 15, 'extraction vide')
  const ETATS = ['fait', 'afaire', 'alerte']
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : clé « ${k} » absente`)
    for (const e of ETATS) assert.ok(('menages.tt_' + e) in d, `${l} : clé dynamique menages.tt_${e} absente`)
  }
})

test('ménages : dates via Intl, jamais de formatage à la main', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('Intl.DateTimeFormat'), 'les dates passent par Intl')
  assert.ok(!/toLocaleDateString\('fr/.test(src), 'locale codée en dur')
})

// ─── Les décisions du design (§13), chacune NOMMÉE ──────────────────────────
test('décisions §13 : chaque règle de l\'étape 1 est présente, manquantes nommées', () => {
  const src = html()
  const LIGNES = {
    'la vérité « fait » vient du serveur (D1 lecture), jamais du localStorage': 'm.fait',
    'TROIS états seulement, lisibles sans légende (13/10)': "'alerte'",
    'badge retour vert/rouge sur un ménage fait (Q3)': 'men-mk__retour',
    'jours à régler = engrenage gris, jamais « € » (Q4)': 'men-regler',
    'bien non confié : aucune ligne, jamais de rouge (3 septembre)': 'menages.non_confie',
    'les jours sans AUCUNE prestataire : la COLONNE du bien, pas une ligne (13/10)': 'men-jj--trou',
    'sans prestataires:read : ligne neutre, pas d\'identifiant (invariant A.5)': 'CLE_COUVERTURE',
    'ligne temporaire de la remplaçante (ménage sans barre)': 'lignesDuBien',
    'deux ménages même jour même ligne : pastille chiffrée': 'men-mk__n',
    'désactivée : prénom grisé, ligne vide (13/10)': 'men-qui--off',
    'couleur stable par personne (hash, pastels du thème)': 'couleurDe(',
    'la BANDE du calendrier, composant partagé (13/10)': 'bandeJoursHtml',
    'le bloc bordé par bien du calendrier (13/10)': 'cal-bien__bandeau',
    'poignée de déplacement, ordre persisté (13/10)': 'brancherPoignees',
    'l\'angle et les bulles du calendrier': 'cal-angle__menu',
    'troncature DITE (bandeau, pas console.warn)': 'menages.truncated',
    'anti-course : la réponse en retard ne repeint pas': 'jetonLecture',
    'navigation non persistée (comme le calendrier)': 'decalage: 0',
    'biens masqués persistés par compte': 'hs_menages_v5_prefs',
    'le sélecteur en MOIS du calendrier (recette 13/10)': 'data-mois="12"',
    'au-delà de 92 jours, lecture par TRANCHES fusionnées': 'TRANCHE_MAX',
    'bulle « À traiter » : le module partagé décide, la page peint (étape 2)': 'lignesATraiter',
    'la bulle a sa PROPRE fenêtre J−30 → J+30, pas celle du planning': 'chargerATraiter',
    'badge ambre de l\'onglet Ménages = les lignes de la bulle': 'menagesATraiter',
    'une bulle qui n\'a pas pu lire se TAIT, elle n\'annonce pas le calme': 'menages.atraiter_panne',
    'rien à traiter : une ligne blanche à coche verte, sans ambre': 'men-bulle--calme',
    'la miniature du bien reste, initiales à défaut de photo': 'men-atr__ini',
    'valider un ménage écrit sur le SERVEUR, writer partagé avec la PWA (D1)': 'validerMenage',
    'changer la prestataire depuis la bulle': 'ouvrirChangement',
    '« Annuler » rejoue l\'inverse RÉEL (defaire), pas un simple retrait visuel': "action: 'defaire'",
    'volet « Équipe ménage » : il LIT, la configuration reste l\'écran existant': 'ouvrirEquipe',
    'un clic ouvre SA fiche en modification, pas la liste': 'prestataires?presta=',
    '« Ajouter » ouvre le formulaire vierge': 'prestataires?nouveau=1',
    'le COMPTE de retours, jamais une moyenne étoilée (décision H.6)': 'retoursHtml',
    'une désactivée reste listée, grisée': 'men-eq--off',
    '« Ajouter » réservé au titulaire, absent du DOM sinon (D6)': 'estTitulaire()',
    'fiche ménage : les TROIS étapes datées (Q1), aucune inventée': 'function frise',
    'la NOTE pour la prestataire est reconstruite (bloquant E.1)': 'enregistrerNote',
    'elle part par le SERVEUR, pas depuis le navigateur': "action: 'note'",
    'la note existante est préremplie — sinon enregistrer l\'effacerait': 'm.note',
    'réassigner depuis la fiche': 'data-fiche-presta',
    'X-Compte sur chaque appel': 'enteteCompte()',
    'entrée sous menages:read, erreur 403 dite': 'menages.no_access'
  }
  const manquantes = Object.entries(LIGNES).filter(([, motif]) => !src.includes(motif)).map(([nom]) => nom)
  assert.deepEqual(manquantes, [], 'règles ABSENTES : ' + manquantes.join(' ; '))
})

test('ménages : l\'état d\'une pastille suit les décisions Q1/Q2 (ordre des tests)', () => {
  const src = sansCommentaires(html())
  // fait AVANT « à faire » (un ménage fait reste vert même porté), et
  // porté/différé = À FAIRE, tout le reste = ALERTE (décision du 13 octobre).
  const corps = /function etatPastille[\s\S]*?\n}/.exec(src)
  assert.ok(corps, 'etatPastille introuvable')
  const ordre = ['m.fait', 'm.porteur', 'alerte']
  let pos = -1
  for (const jalon of ordre) {
    const p = corps[0].indexOf(jalon)
    assert.ok(p > pos, `ordre des états : « ${jalon} » mal placé`)
    pos = p
  }
  // Et AUCUN état « en cours » : il n'existe pas en donnée (Q1).
  assert.ok(!/en[_ ]cours|started/.test(corps[0]), 'un état inventé')
})

// ─── Gardes de périmètre ─────────────────────────────────────────────────────
test('ménages : aucun appel provider ni moteur depuis la page, un seul endpoint de lecture', () => {
  const src = sansCommentaires(html())
  assert.ok(!/channex\.io|beds24\.com|airroi/i.test(src))
  assert.ok(!src.includes('/api/beds24'), 'jamais un provider')
  assert.ok(!src.includes('/api/cron'), 'jamais le moteur')
  assert.ok(src.includes('/api/garde?du='), 'la lecture passe par api/garde')
  assert.ok(!src.includes("supabase.from("), 'aucune lecture Supabase directe')
})

test('ménages : la route /menages existe (cleanUrls : pas de .html en destination)', () => {
  const v = lire('vercel.json')
  assert.ok(v.includes('"/menages"'), 'route absente')
  assert.ok(!/"destination": "\/pages\/menages\.html"/.test(v), 'destination avec .html')
})

test('ménages : les écritures passent par l\'ENDPOINT gardé, jamais par Supabase direct', () => {
  // ⚠ Depuis l'étape 3 (gestes de la bulle), la page écrit. Ce qu'on garde :
  // aucune table touchée depuis le navigateur — tout passe par /api/menages,
  // qui porte la session, le droit et le périmètre.
  const src = sansCommentaires(html())
  assert.ok(!src.includes('.insert(') && !src.includes('.update(') && !src.includes('.upsert(') &&
            !src.includes('.delete('), 'écriture Supabase directe depuis la page')
  assert.ok(src.includes("poster('/api/menages'"), 'les gestes passent par l\'endpoint')
  // Et chaque bouton suit SON droit, absent du DOM sinon (décision G12).
  assert.ok(/peutEcrire\('menages'\)/.test(src), '« Valider » sous menages:write')
  assert.ok(/peutEcrire\('prestataires'\)/.test(src), '« Changer » sous prestataires:write')
})

test('ménages : le sprite porte les icônes neuves (bouclier barré, pouces)', () => {
  const sprite = lire('shared/icons.svg')
  for (const id of ['i-shield-off', 'i-thumb-up', 'i-thumb-down']) {
    assert.ok(sprite.includes(`id="${id}"`), `${id} absent du sprite`)
  }
})

// ─── La fenêtre de configuration d'une prestataire ─────────────────────────
//
// ⚠ CE QUE CES GARDE-FOUS TIENNENT. Cette fenêtre écrit TOUT ce qu'un hôte
// règle sur une personne. Trois promesses s'y perdraient sans bruit : que son
// JETON ne traverse jamais l'écran, que la phrase d'état vienne du MOTEUR et
// non d'une approximation locale, et que chaque écriture passe par l'endpoint
// qui en est le writer.

test('config : la phrase d\'état vient du module du moteur, elle n\'est pas recalculée', () => {
  const src = sansCommentaires(html())
  assert.ok(/import \{[^}]*etatDeLaPrestataire[^}]*\} from '\/shared\/presta-etat\.js'/.test(src),
    'le module d\'état doit être importé')
  assert.ok(src.includes('etatDeLaPrestataire({'), 'et appelé')
  // La règle des trois états de `weekdays` ne se réécrit pas dans la page :
  // elle est dans `defautDeLaLiaison`, qui est importé.
  assert.ok(/import \{[^}]*defautDeLaLiaison[^}]*\}/.test(src))
})

test('config : AUCUNE écriture directe en base, chaque geste passe par son endpoint', () => {
  const src = sansCommentaires(html())
  // L'écran d'avant écrivait `public_tokens` et `menage_reglages` depuis le
  // navigateur, sous RLS. Ici, le serveur le fait — un writer client de moins.
  assert.ok(!/supabase\s*\.\s*from\s*\(/.test(src), 'aucune table touchée depuis le navigateur')
  for (const action of ['reglages_lien', 'liaisons', 'reglerVisibilite', 'deactivate', 'regenerate']) {
    assert.ok(src.includes(`'${action}'`), `l'action ${action} doit passer par un endpoint`)
  }
})

test('config : le JETON ne traverse jamais l\'écran — il se demande au geste', () => {
  const src = sansCommentaires(html())
  // Son lien est son mot de passe. La fiche ne le charge pas : « Envoyer le
  // lien » et « Ouvrir sa page » le demandent au moment du clic.
  assert.ok(src.includes("action=lien&profile_id="), 'le lien se demande à /api/membres')
  assert.ok(!/personne\.(pwa_)?token/.test(src), 'et il n\'est jamais lu depuis la fiche')
  assert.ok(src.includes("'noopener'"), 'la page ouverte n\'a aucune poignée sur celle de l\'hôte')
})

test('config : retirer de l\'équipe coupe les LIAISONS d\'abord, puis le profil', () => {
  // Le moteur ne lit ni le lien ni le statut du profil : ce sont les liaisons
  // qui le font travailler. Dans l'autre ordre, un échec laisserait le cron
  // attribuer des ménages à quelqu'un dont le lien n'existe plus.
  const src = sansCommentaires(html())
  const i = src.indexOf('async function retirerDeLEquipe')
  assert.ok(i > 0)
  const corps = src.slice(i, i + 2000)
  assert.ok(corps.indexOf("action: 'liaisons'") < corps.indexOf("action: 'deactivate'"),
    'les liaisons sont coupées AVANT la désactivation')
  assert.ok(corps.includes('retirer_demi'), 'et un retrait à moitié fait se DIT')
})

test('config : un périmètre vide est refusé à l\'écran — il OUVRE l\'accès, il ne le ferme pas', () => {
  // Convention inversée de `public_tokens.property_ids` : vide = TOUS les
  // biens du compte. Retirer le dernier bien doit donc être refusé, et le
  // message renvoyer vers « Retirer de l'équipe ».
  assert.ok(sansCommentaires(html()).includes('dernier_bien'))
})

test('config : les quatre périodes de ratio sont celles que la BASE accepte', () => {
  // La maquette en proposait trois autres (30 j / 90 j / 1 an) : une valeur
  // hors du CHECK ferait échouer l'écriture avec un message Postgres.
  const src = sansCommentaires(html())
  assert.ok(src.includes("CFG_PERIODES = ['15j', '30j', '6mois', 'toujours']"))
  const fr = JSON.parse(lire('shared/i18n/fr.json'))
  for (const p of ['15j', '30j', '6mois', 'toujours']) {
    assert.ok(fr[`menages.equipe.config.periode_${p}`], `libellé manquant pour ${p}`)
  }
})

test('config : l\'aperçu ouvre SA page en mode `apercu=1`, jamais autrement', () => {
  // ⚠ L'INVARIANT A CHANGÉ DE FORME, PAS DE FOND (recette du 14 octobre).
  // L'aperçu était reconstitué par l'écran ; c'est maintenant une iframe sur
  // son vrai lien. Le danger reste le même : le chargement de sa page est le
  // writer de sa dernière ouverture. Sans `apercu=1`, l'hôte qui s'inquiète
  // ferait croire qu'ELLE a regardé, et l'alerte « Ménage non reçu » se
  // tairait à tort.
  const src = sansCommentaires(html())
  assert.ok(src.includes("'apercu=1'"), 'le lien du cadre porte le mode aperçu')
  // Et l'écran n'appelle toujours pas l'endpoint lui-même.
  assert.ok(!src.includes('/api/menages-public'))
})

test('config : le lien du cadre ne survit pas au changement de fiche', () => {
  // Le cadre d'une personne ne doit jamais s'ouvrir sur la page d'une autre.
  const src = sansCommentaires(html())
  const i = src.indexOf('async function ouvrirConfig')
  assert.ok(i > 0)
  assert.ok(src.slice(i, i + 700).includes('cfg.lienApercu = null'))
})

test('PWA : le mode aperçu coupe les écritures, le jeton et l\'installation', () => {
  // ⚠ LE GARDE EST SUR `fetch`, PAS SUR LES BOUTONS : un bouton qu'on oublie
  // de masquer reste alors inoffensif ; l'inverse n'est pas vrai.
  const src = sansCommentaires(lire('apps/menages/public.html'))
  assert.ok(/window\.fetch = /.test(src), 'les écritures sont refusées à la source')
  assert.ok(src.includes("if (APERCU) return fromUrl"),
    'le jeton ne se range pas dans le navigateur de l\'hôte')
  assert.ok(src.includes('"serviceWorker" in navigator && !APERCU'),
    'ni service worker en aperçu')
  assert.ok(/injectManifest[\s\S]{0,200}if \(APERCU\) return/.test(src),
    'ni manifeste : on n\'installe pas l\'application de quelqu\'un d\'autre')
})

test('config : CHAQUE geste rendu a un gestionnaire — aucun bouton mort', () => {
  // ⚠ LE GARDE-FOU NÉ DU CONSTAT HAUT DE LA REVUE DE 6d007f3. En remplaçant
  // l'interrupteur et les deux menus par un seul, le bloc qui traitait les
  // CASES DE JOURS est parti avec eux : sept cases restaient peintes et
  // cliquables, et ne faisaient rien. Aucun test ne l'a vu — ils vérifiaient
  // ce qui est rendu, pas ce qui répond.
  //
  // La question posée est volontairement modeste : « ce `data-cfg-…` que la
  // page dessine est-il lu quelque part ? ». Elle ne dit rien de ce que fait
  // le gestionnaire ; elle attrape ce qui n'en a AUCUN.
  const src = sansCommentaires(html())
  // `conge-off` → `cfgCongeOff`, comme le `dataset` du navigateur le nomme.
  const nomDataset = s => 'cfg' + s.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  // `sec` est un repère de section pour le défilement, pas un geste.
  const STRUCTURELS = new Set(['sec'])
  const rendus = new Set()
  for (const m of src.matchAll(/data-cfg-([a-z-]+)[=">\s]/g)) rendus.add(m[1])
  const morts = []
  for (const attr of rendus) {
    if (STRUCTURELS.has(attr)) continue
    const nom = nomDataset(attr)
    // Trois formes de lecture : `d.cfgX`, `'cfgX' in d`, ou `dataset.cfgX`.
    const lu = new RegExp(`d\\.${nom}\\b|'${nom}' in d|dataset\\.${nom}\\b`).test(src)
    if (!lu) morts.push(attr)
  }
  assert.deepEqual(morts, [], 'gestes rendus sans gestionnaire')
})

test('PWA : l\'aperçu ne laisse AUCUNE mémoire chez l\'hôte', () => {
  // ⚠ LE CONSTAT DE SÉCURITÉ DE LA REVUE DE 6d007f3. Le garde ne portait que
  // sur le jeton. Cette page range aussi, sous des clés qui ne portent AUCUN
  // identifiant de personne, le miroir de ses ménages faits, sa file d'actions
  // hors ligne et ses notifications acquittées. Dans l'iframe — même origine —
  // ce miroir écrasait celui de l'hôte s'il utilise aussi l'application.
  const src = sansCommentaires(lire('apps/menages/public.html'))
  assert.ok(/Object\.defineProperty\(window, 'localStorage'/.test(src),
    'le stockage local est neutralisé en aperçu, pas seulement le jeton')
  const i = src.indexOf('if (APERCU) {')
  const j = src.indexOf("Object.defineProperty(window, 'localStorage'")
  assert.ok(i > 0 && j > i && j - i < 1200, 'et il est posé AVANT tout autre code de la page')
})

test('PWA : le service worker ne met JAMAIS en cache une URL portant un jeton', () => {
  // La clé du cache est l'URL complète : un document mis en cache sous
  // `public.html?token=…` range le jeton dans le Cache Storage, et il y reste.
  const sw = sansCommentaires(lire('apps/menages/sw.js'))
  assert.ok(/req\.url\.includes\('token='\)/.test(sw))
  // ⚠ Et la version du cache doit avoir CHANGÉ : l'activation n'évince que les
  // versions dont le nom diffère. Sans bump, les entrées déjà écrites avec un
  // jeton survivent au correctif.
  assert.ok(!sw.includes('hotesmart-clean-v3-refonte'), 'la version du cache est bumpée')
})

test('config : « Ouvrir sa page » garde le mode lecture seule', () => {
  // Ce bouton est à deux centimètres du cadre. Sans le mode, il horodate sa
  // dernière ouverture, range son jeton chez l'hôte et installe son
  // application — et le badge passe au vert sur quelqu'un qui n'a rien ouvert.
  const src = sansCommentaires(html())
  const i = src.indexOf('async function ouvrirSaPage')
  assert.ok(i > 0)
  const corps = src.slice(i, i + 900)
  assert.ok(corps.includes('enApercu(lien)'), 'le lien ouvert porte `apercu=1`')
  assert.ok(corps.includes('estSaPage(lien)'), 'et on vérifie qu\'il mène bien à SA page')
})

test('config : l\'état « À jour » ne se conclut pas sur une lecture manquante', () => {
  // « Aucun ménage connu » et « la lecture n'a pas eu lieu » se ressemblent
  // dans un tableau vide — seul le second interdit de dire « À jour ».
  const src = sansCommentaires(html())
  const i = src.indexOf('function vueHtml')
  assert.ok(i > 0)
  const corps = src.slice(i, i + 900)
  assert.ok(corps.includes('if (!etat.bulleLue || etat.aTraiterTronque) return'),
    'ni sur une lecture TRONQUÉE : un vert conclu sur une liste coupée est le même mensonge')
  assert.ok(corps.includes('etat.menagesBulle'),
    'et la fenêtre lue est celle de la bulle, pas le planning que l\'hôte fait varier')
})
