// tests/biens-vivants-parite.test.js
// LES DEUX MODULES « BIENS VIVANTS » NE DIVERGENT PAS.
//
// Le serveur est en CommonJS (`lib/biens-vivants.js`), le navigateur en modules
// ES (`shared/biens-vivants.js`) : un seul fichier ne peut pas servir les deux
// dans ce dépôt. Ce qui est partagé est donc la RÈGLE, et ce fichier est le
// seul garde-fou qui l'empêche de se dédoubler en deux vérités.
//
// ⚠ POURQUOI DEUX MODULES EXISTENT. Six écrans ne passent par aucun endpoint :
// les pages YieldFlow, la barre latérale et la messagerie lisent `properties`
// DIRECTEMENT depuis le navigateur, sous RLS. Aucun filtre serveur ne peut les
// atteindre — mesuré le 4 novembre 2026 en cherchant le point 7 de Thierry, et
// c'est l'écart entre sa consigne (« un filtre partagé SERVEUR ») et le code.

const test = require('node:test')
const assert = require('node:assert/strict')

let CLIENT
test.before(async () => { CLIENT = await import('../shared/biens-vivants.js') })

const SERVEUR = require('../lib/biens-vivants')

test("LE TEST QUI COMPTE : les deux modules filtrent la MEME colonne", () => {
  // ⚠ C'EST LA SEULE CHOSE QU'ILS ONT EN COMMUN, et c'est exactement ce qui
  // casserait en silence : renommer la colonne d'un côté laisserait l'autre
  // filtrer sur un nom mort. PostgREST refuse alors la requête ENTIERE en
  // 42703 — donc, côté client, une page qui annonce « aucun logement ».
  assert.equal(CLIENT.COLONNE_ARCHIVE, SERVEUR.COLONNE,
    `le client filtre « ${CLIENT.COLONNE_ARCHIVE} », le serveur « ${SERVEUR.COLONNE} »`)
})

test("les deux `sansArchives` posent le MEME filtre, mesure sur une chaine temoin", () => {
  // ⚠ ON MESURE LE FILTRE POSE, pas le nom de la fonction : deux modules
  // peuvent exporter `sansArchives` et poser `.is()` sur des colonnes
  // differentes, ou l'un `.is(col, null)` et l'autre `.not(col, 'is', null)`.
  const temoin = () => {
    const vu = []
    const chaine = { is: (c, v) => { vu.push(['is', c, v]); return chaine }, vu }
    return chaine
  }
  const a = SERVEUR.sansArchives(temoin())
  const b = CLIENT.sansArchives(temoin())
  assert.deepEqual(a.vu, b.vu, `serveur ${JSON.stringify(a.vu)} vs client ${JSON.stringify(b.vu)}`)
  assert.deepEqual(a.vu, [['is', 'archive_le', null]])
})

test("les deux LEVENT sur autre chose qu une chaine", () => {
  // Un appel ecrit a l'envers — `sansArchives(supabase.from('x'))`, sans
  // `.select()` — doit echouer bruyamment des DEUX cotes. Sinon il rend
  // `undefined` et la page affiche « aucun logement » sans que rien ne le dise.
  for (const [nom, fn] of [['serveur', SERVEUR.sansArchives], ['client', CLIENT.sansArchives]]) {
    for (const mauvais of [undefined, null, {}, { select: () => {} }, 'chaine']) {
      assert.throws(() => fn(mauvais), /sansArchives/,
        `${nom} a accepte ${JSON.stringify(mauvais)}`)
    }
  }
})

test("EXHAUSTIVITE : toute lecture CLIENT de properties est filtree, ou motivee", () => {
  // ⚠ CE TEST EST LE PENDANT, CÔTÉ NAVIGATEUR, de l'exhaustivite de
  // `tests/ecrans-sans-biens-archives.test.js`. Il ne peut pas APPELER les
  // pages — ce sont des documents HTML, pas des handlers —, donc il lit la
  // source, et sa limite est la : il verifie la FORME de l'appel. C'est ce que
  // le depot a de mieux tant que ces ecrans ne sont pas modularises.
  const fs = require('node:fs')
  const path = require('node:path')
  const racine = path.join(__dirname, '..')
  const lire = (p) => fs.readFileSync(path.join(racine, p), 'utf8')

  // Les lectures qui ont le DROIT de voir un bien archive, avec leur raison.
  const MOTIVEES = {
    'pages/messages.html':
      'table de CORRESPONDANCE cle provider -> nom, pas une liste de choix. '
      + 'Depuis le 6 novembre 2026, les conversations d un bien archive ne '
      + 'sortent plus de /api/messages (filtre serveur) : cette table nomme ce '
      + 'que le serveur rend, filtrer ici n ajouterait rien.'
  }

  const fichiers = [
    'apps/yield/comparables.html', 'apps/yield/index.html', 'apps/yield/marche-global.html',
    'apps/yield/marche-temperature.html', 'apps/yield/marche.html', 'apps/yield/prix.html',
    'components/sidebar.js', 'pages/messages.html'
  ]
  const manquants = []
  for (const f of fichiers) {
    const src = lire(f)
    const lectures = (src.match(/from\(\s*'properties'\s*\)/g) || []).length
    assert.ok(lectures >= 1,
      `${f} ne lit plus properties : cette liste est perimee, ce test ne mesure plus rien`)
    if (MOTIVEES[f]) {
      assert.ok(MOTIVEES[f].length > 40, `la raison de ${f} n est pas ecrite`)
      continue
    }
    if (!/sansArchives\(/.test(src)) manquants.push(f)
  }
  assert.deepEqual(manquants, [],
    `ces ecrans lisent properties cote client sans filtrer les archives : ${manquants.join(', ')}`)

  // Et une motivation qui ne correspond plus a rien se retire.
  for (const f of Object.keys(MOTIVEES)) {
    assert.ok(fichiers.includes(f), `${f} est motive mais absent de la liste`)
  }
})
