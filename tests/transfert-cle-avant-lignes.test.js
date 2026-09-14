// tests/transfert-cle-avant-lignes.test.js
// LE PRIX DU CACHE LONG DOIT ETRE PAYE DE FACON FIABLE.
//
// Depuis le 14 septembre 2026, `CACHE_MS` vaut 15 minutes : la lecture de
// `provider_keys_migrated` n'est plus exposee 288 fois par jour a une passerelle
// saturee. Le prix est que le cron ignore une cle fraichement migree pendant
// tout ce temps. Il est paye dans le script de transfert — cle enregistree AVANT
// que les lignes ne bougent, puis attente de la fenetre.
//
// LA REVIEW A MONTRE QUE CE PRIX N'ETAIT PAS PAYE DE FACON FIABLE : trois
// chemins laissaient le transfert partir SANS garde enregistree, ou laissaient
// un bien marque migre SANS transfert. Aucun n'etait couvert.

process.env.TZ = 'Europe/Paris'
process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('fs')
const path = require('path')
const CHEMIN = path.join(__dirname, '..', 'scripts/transferer-bien-vers-fiche-neuve.js')
const src = fs.readFileSync(CHEMIN, 'utf8')

test('LE TEST QUI COMPTE : --sans-attente NU est refuse AVANT tout appel reseau', () => {
  // ⚠ Le refus etait leve par `attendreFenetreDeCache`, donc APRES la pause et
  // APRES l'enregistrement de la cle migree : une garde posee pour empecher un
  // geste par reflexe s'executait apres deux ecritures, dont l'une laisse un
  // bien mort-vivant si on s'arrete la. Releve en review.
  //
  // On LANCE le script : c'est la seule facon de prouver qu'il refuse avant
  // d'avoir rien fait. Sans `--ecrire`, il ne peut de toute facon rien ecrire.
  let sortie = ''
  let code = 0
  try {
    // ⚠ AVEC UN BIEN VALIDE : sans lui, le script sort sur son message d'usage
    // avant meme d'examiner le drapeau, et le test passerait pour la mauvaise
    // raison. Il faut aller jusqu'au parsing du drapeau pour prouver qu'il
    // refuse — au chargement du module, donc avant `main()` et tout reseau.
    execFileSync('node', [CHEMIN, 'coeur-23', '--sans-attente'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    code = e.status
    sortie = String(e.stderr || '') + String(e.stdout || '')
  }
  assert.equal(code, 1, 'le script refuse et sort en erreur')
  assert.match(sortie, /REFUS : --sans-attente exige une raison/)
  assert.match(sortie, /ANCIENNE cle/, 'et il dit la consequence, pas seulement « non »')
  assert.ok(!/automation_paused/.test(sortie) && !/audit AVANT/.test(sortie),
    'ni pause, ni audit : le refus tombe au chargement du module, avant tout appel reseau')
})

test('LE TEST QUI COMPTE : l enregistrement de la cle est la CONDITION du transfert', () => {
  // ⚠ Le `catch` d'origine avait ete ecrit pour l'ordre ANCIEN (cle APRES
  // transfert) : il journalisait « Le transfert est fait » — devenu faux — et
  // CONTINUAIT. Le script attendait alors 15 minutes, affichait « ✓ fenetre
  // ecoulee, le cron connait la cle migree », puis deplacait les lignes sans
  // aucune garde. Le 10 septembre a l'identique, avec un compte a rebours
  // rassurant par-dessus.
  assert.ok(!src.includes('Le transfert est fait, mais le cron va rapatrier'),
    'le message ecrit pour l ordre ancien a disparu')
  assert.ok(!/catch \(e\) \{[\s\S]{0,400}process\.exitCode = 1[\s\S]{0,80}\}\s*\n\s*\}\s*\n\s*await attendreFenetreDeCache/.test(src),
    'l echec de l enregistrement ne se contente plus d un code de sortie')

  const posNote = src.indexOf('await noterCleMigree(')
  const posAttente = src.indexOf('await attendreFenetreDeCache(')
  const posTransfert = src.indexOf("rpc('transferer_bien'")
  assert.ok(posNote > 0 && posAttente > 0 && posTransfert > 0, 'les trois etapes existent')
  assert.ok(posNote < posAttente && posAttente < posTransfert,
    'et dans cet ordre : cle, puis attente, puis transfert')
})

test('LE TEST QUI COMPTE : l erreur du SELECT de la fiche source est LUE', () => {
  // Sans `error`, une lecture en echec rendait `src = null`, le bloc entier
  // etait saute SANS UN MOT, et le transfert partait non protege — en silence
  // total. La panne qui produit ce cas est exactement celle que ce lot traite.
  assert.ok(src.includes('const { data: src, error: eSrc }'), 'l erreur est destructuree')
  assert.ok(src.includes('if (eSrc) throw'), 'et elle arrete le script')
  assert.ok(/if \(!src\) throw/.test(src), 'une fiche introuvable aussi')
  assert.ok(/if \(!src\.provider_property_id\) \{\s*\n\s*throw/.test(src),
    'et une source sans cle provider : rien ne protegerait le transfert')
})

test('LE TEST QUI COMPTE : tout arret entre la cle et le transfert ANNULE l enregistrement', () => {
  // Sinon : bien marque migre, aucune ligne deplacee. Plus rien ne le touche —
  // ni synchro, ni message, ni code d acces, ni avis — et rien ne le signale.
  // Un bien mort-vivant, invisible.
  assert.ok(src.includes('const annulerEnregistrement'), 'l annulation existe')
  assert.ok(src.includes("await annulerEnregistrement('transfert refuse')"),
    'le refus du transfert l appelle')
  assert.ok(src.includes("process.on('SIGINT'") && src.includes("process.on('SIGTERM'"),
    'et une interruption pendant l attente aussi — c est le moment ou l operateur croit le script fige')
  const posAnnule = src.indexOf('const annulerEnregistrement')
  const posAttente = src.indexOf('await attendreFenetreDeCache(')
  assert.ok(posAnnule > 0 && posAnnule < posAttente,
    'et le filet est pose AVANT l attente, pas apres')
})

test('LE TEST QUI COMPTE : retirerCleMigree refuse un appel incomplet, et vide le cache', async () => {
  const { retirerCleMigree } = require('../lib/cles-migrees')
  for (const args of [{ provider: 'beds24', propId: '1' }, { userId: 'a', propId: '1' }, { userId: 'a', provider: 'beds24' }]) {
    await assert.rejects(() => retirerCleMigree({}, args), /userId, provider et propId requis/)
  }

  // Le cache DOIT etre vide : sinon le script continuerait a croire la cle
  // migree alors qu'il vient de l annuler.
  let supprime = null
  const sb = { from () {
    const q = { delete: () => q, eq: (c, v) => { (supprime = supprime || {})[c] = v; return q },
                then: (r) => Promise.resolve({ error: null }).then(r) }
    return q
  } }
  await retirerCleMigree(sb, { userId: 'hote-A', provider: 'beds24', propId: 169567 })
  assert.deepEqual(supprime, { user_id: 'hote-A', provider: 'beds24', provider_property_id: '169567' },
    'la suppression est bornee au compte, au provider ET a la cle — jamais plus large')
})
