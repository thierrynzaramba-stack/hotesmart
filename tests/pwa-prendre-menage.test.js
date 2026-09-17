// tests/pwa-prendre-menage.test.js
// Refonte PWA v2, lot 2 — les gardes SERVEUR de « prendre un ménage ».
//
// ⚠ Le reste du lot n'est éprouvé que côté DOM (tests/pwa-mes-jours-dom.test.js).
// Or les gardes de la LECTURE disent ce qu'on affiche ; elles ne protègent rien
// d'un appel forgé. Ce fichier tient les invariants du chemin d'écriture, et la
// cohérence entre ce qui est lisible et ce qui est prenable.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'menages-public.js'), 'utf8')
// Le bloc d'écriture seul : les gardes de la lecture ont leur propre section
// plus haut dans le fichier, et les confondre ferait passer un test sur l'autre.
const ECRITURE = API.slice(API.indexOf('async function prendreUnMenage'),
                           API.indexOf('// ─── « MES DISPONIBILITÉS »'))
const LECTURE = API.slice(API.indexOf('let aPrendre = []'),
                          API.indexOf('// NOUVEAU : on renvoie aussi la liste'))

// ═══════════════════════════════════════════════════════════════════════════
// CE QUI EST PROPOSÉ
// ═══════════════════════════════════════════════════════════════════════════

test('lecture : seul le couple `unassigned` + `manual` est écarté', () => {
  // ⚠ RÉGRESSION FERMÉE, ET C'ÉTAIT LE DÉFAUT CENTRAL DU LOT.
  // `assigned_by = 'manual'` a DEUX sens : l'hôte qui désassigne (`unassigned`)
  // et une prestataire qui refuse (`orphaned`). Filtrer sur `assigned_by` seul
  // écartait tous les ménages REFUSÉS — le cas même que cette fonctionnalité
  // existe pour résoudre.
  assert.match(LECTURE, /\.in\('status', \['orphaned', 'unassigned'\]\)/)
  assert.match(LECTURE, /status\.eq\.orphaned,assigned_by\.is\.null,assigned_by\.neq\.manual/)
  // Le NULL doit être nommé : `assigned_by <> 'manual'` vaut NULL, donc faux,
  // quand la colonne est nulle — le cas le plus courant.
  assert.ok(LECTURE.includes('assigned_by.is.null'),
    'sans le NULL explicite, le filtre vide la fonctionnalité')
  // Et l'ancien filtre, celui qui écartait tout `manual`, a bien disparu.
  assert.ok(!/\.neq\('assigned_by', 'manual'\)/.test(LECTURE))
})

test('lecture : ni porteur, ni proposition en cours', () => {
  // Un ménage proposé à quelqu'un d'autre n'est pas libre : l'afficher
  // « à prendre » lancerait une course avec une collègue qui s'apprête
  // peut-être à répondre.
  assert.match(LECTURE, /\.is\('provider_id', null\)/)
  assert.match(LECTURE, /\.is\('offered_to', null\)/)
})

test('lecture : ses biens, et aucune donnée voyageur', () => {
  // ⚠ C'est ce qui sépare cette lecture de celle qui a fuité le 14 septembre :
  // un lien orphelin y voyait 11 séjours avec les NOMS DES VOYAGEURS.
  assert.match(LECTURE, /\.in\('property_id', propIds\)/)
  assert.match(LECTURE, /\.select\('booking_id, property_id, departure_date, status'\)/)
  for (const champ of ['firstName', 'lastName', 'numAdult', 'numChild', 'guest']) {
    assert.ok(!LECTURE.includes(champ), `${champ} ne doit pas sortir d'ici`)
  }
})

test('lecture : une panne coupe, elle ne rend pas une liste vide', () => {
  // « Rien à prendre » et « la lecture a échoué » ne doivent pas se ressembler.
  assert.match(LECTURE, /if \(errLibres\)/)
  assert.match(LECTURE, /503/)
})

// ═══════════════════════════════════════════════════════════════════════════
// LES CINQ GARDES DE L'ÉCRITURE
// ═══════════════════════════════════════════════════════════════════════════

test('écriture : un profil ACTIF est exigé', () => {
  // Un lien sans profil ne porte aucune assignation : le laisser prendre un
  // ménage l'attribuerait à personne.
  assert.match(ECRITURE, /profilActifDuJeton/)
  assert.match(ECRITURE, /refuserPorteur/)
})

test('écriture : ses biens uniquement', () => {
  assert.match(ECRITURE, /pt\.property_ids/)
  assert.match(ECRITURE, /403/)
  // Un `property_ids` vide signifie « tous les biens du compte », comme partout
  // sur cet endpoint — ce n'est pas une absence de périmètre.
  assert.match(ECRITURE, /permis\.length && !permis\.includes/)
})

test('écriture : les DEUX bornes de la fenêtre, pas seulement le passé', () => {
  // ⚠ La lecture borne en haut à `visibility_days` ; l'écriture ne bornait rien
  // de ce côté. « Lisible donc prenable » était vrai, l'inverse non — et une
  // garde d'écriture plus large que sa lecture finit par être celle qui compte.
  assert.match(ECRITURE, /jour < todayInParis\(\)/, 'borne basse, en heure de Paris')
  assert.match(ECRITURE, /visibility_days/, 'borne haute, celle de la lecture')
  assert.match(ECRITURE, /jour > finFenetre/)
})

test('écriture : le format de la date est vérifié AVANT la base', () => {
  // ⚠ Sans lui, la borne basse — une comparaison de CHAÎNES — se contourne :
  // « 2026-9-7 » est lexicographiquement SUPÉRIEUR à « 2026-09-17 » (parce que
  // '9' > '0'), alors que Postgres le lit comme le 7 septembre.
  const routeur = API.slice(API.indexOf("if (action === 'prendreMenage')"),
                            API.indexOf("if (action === 'declarerConge'"))
  assert.match(routeur, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/)
  assert.ok(routeur.indexOf('test(String(departure_date))') < routeur.indexOf('prendreUnMenage'),
    'le format se vérifie avant tout accès base')
})

test('écriture : la décision de l\'hôte se reconnaît au STATUT, pas au verrou', () => {
  // Tester `assigned_by` seul renvoyait « votre hôte gère ce ménage lui-même »
  // à quelqu'un qui regardait un ménage REFUSÉ, auquel l'hôte n'avait jamais
  // touché — une phrase fausse, sur le cas même qu'on veut résoudre.
  assert.match(ECRITURE, /menage\.assigned_by === 'manual' && menage\.status === 'unassigned'/)
  assert.ok(!/if \(menage\.assigned_by === 'manual'\) \{/.test(ECRITURE),
    'le test sur le seul verrou a disparu')
})

test('écriture : la COURSE est tranchée dans l\'écriture, pas avant', () => {
  // ⚠ Les tests de lecture ont une fenêtre derrière eux : deux prestataires
  // peuvent toucher la même bulle à la même seconde. La condition est donc
  // refaite dans l'`update`, où elle est atomique.
  const maj = ECRITURE.slice(ECRITURE.indexOf('.update({'))
  assert.match(maj, /\.is\('provider_id', null\)/)
  assert.match(maj, /\.is\('offered_to', null\)/)
  assert.match(maj, /\.in\('status', \['orphaned', 'unassigned'\]\)/)
  // Zéro ligne = course perdue, pas panne. On le DIT — sinon elle s'organise
  // autour d'un ménage qui ne lui revient pas.
  assert.match(ECRITURE, /if \(!maj \|\| !maj\.length\)/)
  assert.match(ECRITURE, /409/)
})

// ═══════════════════════════════════════════════════════════════════════════
// CE QUE L'ÉCRITURE LAISSE DERRIÈRE ELLE
// ═══════════════════════════════════════════════════════════════════════════

test('la prise pose `assigned_by: manual` — sinon le cron la lui reprend', () => {
  // ⚠ `poserPropositionsDues` sélectionne exactement `assigned_by = 'auto'` et
  // ne protège le porteur que s'il est la personne de garde du jour. Or ce
  // qu'elle vient de prendre n'a, par construction, personne de garde : le cron
  // le proposait à quelqu'un d'autre, dont l'acceptation le lui retirait sans
  // un mot.
  const maj = ECRITURE.slice(ECRITURE.indexOf('.update({'), ECRITURE.indexOf('.eq(\'id\', menage.id)'))
  assert.match(maj, /assigned_by: 'manual'/)
  assert.match(maj, /provider_id: profil\.id/)
  assert.match(maj, /status: 'accepted'/)

  // Contre-épreuve sur le lecteur : le filtre du cron est bien `'auto'`.
  const CRON = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cleaning', 'sync-menages-entite.js'), 'utf8')
  assert.match(CRON, /\.eq\('assigned_by', 'auto'\)/,
    'si ce filtre change, la protection posée ici doit être revue')
})

test('la trace est écrite, et son échec ne passe pas sous silence', () => {
  // C'est le seul canal par lequel l'hôte apprend que le ménage a changé de
  // main. Le ménage, lui, EST pris : on rend le succès, mais on crie.
  assert.match(ECRITURE, /menage_assignment_log/)
  assert.match(ECRITURE, /actor: 'provider'/)
  assert.match(ECRITURE, /if \(errLog\)/)
  assert.match(ECRITURE, /trace de prise NON ECRITE/)
})

test('le cœur n\'est pas écrit ailleurs que sur la ligne du ménage', () => {
  // Le ménage change de porteur ; rien d'autre ne bouge. Aucune écriture de
  // `bookings_snapshot` ni de `menage_done` sur ce chemin.
  for (const table of ['bookings_snapshot', 'menage_done', 'public_tokens']) {
    assert.ok(!new RegExp(`from\\('${table}'\\)[\\s\\S]{0,120}(insert|update|upsert|delete)\\(`).test(ECRITURE),
      `${table} ne doit pas être écrite par la prise`)
  }
})
