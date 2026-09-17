// tests/cron-messages-niveau-log.test.js
//
// LE NIVEAU DE LOG PORTE UNE INFORMATION, ET ELLE ÉTAIT FAUSSE.
//
// ⚠ Vercel étiquette « error » toute invocation qui écrit sur STDERR, quel que
// soit le statut HTTP. `console.warn` y va. Or une abstention pour `budget` ou
// `cycle_en_retard` est le fonctionnement NORMAL d'un rattrapage à point de
// reprise : elle se produit à chaque cycle tant que le fil est plus long que le
// budget. Le cron dédié ressortait donc en « error » à chaque passage d'un
// rattrapage qui se déroulait exactement comme prévu.
//
// ⚠ ON TESTE LE NIVEAU, PAS LE TEXTE. Le contenu du journal n'a pas changé
// d'un caractère — c'est le canal qui mentait. Un test sur la phrase passerait
// tout aussi bien avec le mauvais niveau, et c'est précisément le défaut.

// ⚠ DES VALEURS FACTICES, POSEES AVANT LE PREMIER `require`. La chaine de
// `cron-channel-messages-sync` atteint `record-message.js`, qui cree un client
// Supabase AU CHARGEMENT du module : sans ces deux variables, le fichier de test
// leve avant d'avoir execute une seule assertion. Elles ne servent qu'a laisser
// `createClient` se construire — chaque test injecte ensuite SON propre double,
// et aucune requete ne part.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://factice.supabase.co'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice'

// ⚠ LE FAUX `founder-notify` EST POSE AVANT TOUT AUTRE REQUIRE, ET C'EST UNE
// QUESTION DE SURETE, PAS DE VITESSE. Deux de ces tests poussent le compteur
// jusqu'a `ABSTENTIONS_AVANT_INCIDENT` : sans ce leurre, `reportIncident` part
// POUR DE VRAI. Son anti-spam echoue OUVERT (une lecture ratee rend
// `alreadyAlerted = false`), donc sur toute machine ou `ALERT_BREVO_API_KEY` et
// `FOUNDER_PHONE` sont dans l'environnement — un shell apres un `vercel env
// pull`, ou la CI — `npm test` enverrait deux SMS et deux e-mails reels au
// fondateur. Mesure au passage : 7,1 s par test en echecs DNS purs sans lui.
const cheminNotify = require.resolve('../lib/founder-notify')
const incidents = []
require.cache[cheminNotify] = {
  id: cheminNotify, filename: cheminNotify, loaded: true, exports: {
    reportIncident: async (type, opts) => { incidents.push({ type, ...opts }); return true }
  }
}

const test = require('node:test')
const assert = require('node:assert')

// Capture les trois canaux le temps d'un appel, puis les rend.
async function capturer (fn) {
  const vrais = { log: console.log, warn: console.warn, error: console.error }
  const vu = { log: [], warn: [], error: [] }
  console.log = (...a) => vu.log.push(a.join(' '))
  console.warn = (...a) => vu.warn.push(a.join(' '))
  console.error = (...a) => vu.error.push(a.join(' '))
  try { vu.resultat = await fn() } finally { Object.assign(console, vrais) }
  return vu
}

// Un double d'état : `sAbstenir` n'est pas exporté, on passe donc par
// `importerMessagesDuBien`, qui est le vrai chemin.
function supabaseAvec ({ abstentionsAvant = 0, motifAvant = null, reprise = null }) {
  const ligne = {
    last_run: null,
    total_messages: abstentionsAvant,
    errors: reprise || motifAvant ? [{ ...(reprise || {}), count: 1, motif: motifAvant }] : null
  }
  // ⚠ LE DOUBLE MEMORISE CE QU'ON LUI ECRIT. Sans ça, aucune assertion ne peut
  // porter sur l'ETAT ECRIT — et c'est exactement le trou que la contre-épreuve
  // a révélé : retirer la remise à zéro du compteur ne faisait rougir aucun test,
  // parce que tous regardaient la fonction pure `aProgresse` et jamais son effet.
  const client = { ecrits: [] }
  client.from = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: ligne, error: null }),
      upsert: async (row) => { client.ecrits.push(row); return { error: null } },
      insert: async (row) => { client.ecrits.push(row); return { error: null } }
    }
    return chain
  }
  return client
}

// Un provider double : la passe est INTERROMPUE, mais elle a fait avancer les
// choses. C'est le cas nominal d'un rattrapage à point de reprise, et le seul
// chemin qui produit un progrès.
function avecProviderQuiAvance ({ imported, reprise }) {
  const abs = require.resolve('../lib/channels')
  const Module = require('node:module')
  const m = new Module(abs)
  m.exports = { getProvider: () => ({
    importMessages: async () => ({ interrompu: 'budget', imported, reprise })
  }) }
  m.loaded = true
  require.cache[abs] = m
  return () => { delete require.cache[abs] }
}

const bien = { user_id: 'hote', provider_property_id: 'p-colomiers', name: 'Colomiers' }

// ⚠ On force l'abstention par le chemin `cycle_en_retard` : une échéance déjà
// dépassée sort AVANT tout appel provider. Aucun réseau, aucune écriture réelle.
async function abstenir (supabase) {
  delete require.cache[require.resolve('../lib/cron-channel-messages-sync')]
  const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')
  return importerMessagesDuBien(supabase, bien, { echeance: Date.now() - 1, results: {} })
}

test('une abstention ATTENDUE ne part pas sur stderr', async () => {
  const vu = await capturer(() => abstenir(supabaseAvec({ abstentionsAvant: 0 })))
  assert.strictEqual(vu.resultat.abstenu, true)
  assert.strictEqual(vu.resultat.motif, 'cycle_en_retard')
  assert.ok(vu.log.some(l => /abstention \(cycle_en_retard\)/.test(l)),
    'la ligne est bien écrite, sur stdout')
  assert.strictEqual(vu.warn.length, 0, 'rien sur console.warn')
  // ⚠ `console.error` VA AUSSI SUR STDERR, et l'assertion l'oubliait : une
  // regression qui route un message de chemin nominal vers `error` (l'echec
  // d'ecriture de `ecrireEtat`, par exemple, qui est sur ce chemin exact)
  // laissait le test vert pendant que l'invocation restait etiquetee « error ».
  assert.strictEqual(vu.error.length, 0, 'ni sur console.error — les deux sont stderr')
})

test('la même abstention devient une ALERTE quand elle s\'installe', async () => {
  // ⚠ LE SEUIL COMPTE AUTANT QUE LE MOTIF. Un motif attendu qui se répète au-delà
  // de `ABSTENTIONS_AVANT_INCIDENT` n'est plus attendu : le budget ne suffit
  // structurellement pas, et c'est bien une alerte.
  const { ABSTENTIONS_AVANT_INCIDENT } = require('../lib/cron-channel-messages-sync')
  const vu = await capturer(() =>
    abstenir(supabaseAvec({ abstentionsAvant: ABSTENTIONS_AVANT_INCIDENT })))

  assert.ok(vu.warn.some(l => /abstention \(cycle_en_retard\)/.test(l)),
    'installée, elle repasse sur stderr')
})

test('un motif ANORMAL reste sur stderr dès la première fois', async () => {
  // ⚠ `etat_illisible` n'est pas un rythme, c'est une panne : on ne sait pas où
  // on en est, et on n'écrit rien. Le niveau doit le dire tout de suite.
  const casse = {
    from () {
      const chain = { select: () => chain, eq: () => chain,
                      maybeSingle: async () => ({ data: null, error: { message: 'pooler mort' } }) }
      return chain
    }
  }
  const vu = await capturer(() => abstenir(casse))
  assert.strictEqual(vu.resultat.motif, 'etat_illisible')
  assert.ok(vu.warn.length + vu.error.length > 0, 'une vraie panne parle sur stderr')
})

test('les motifs attendus sont NOMMÉS, pas devinés', () => {
  // Une liste explicite : ajouter un motif au cron sans décider de son niveau
  // doit être un choix, pas un défaut hérité.
  const { MOTIFS_ATTENDUS } = require('../lib/cron-channel-messages-sync')
  assert.ok(MOTIFS_ATTENDUS instanceof Set)
  assert.deepStrictEqual([...MOTIFS_ATTENDUS].sort(), ['budget', 'cycle_en_retard'])
  // ⚠ Un motif `provider_*` n'y est PAS, et ne doit jamais y entrer : une panne
  // du provider est une panne, quel que soit le nombre de fois qu'elle survient.
  assert.ok(![...MOTIFS_ATTENDUS].some(m => m.startsWith('provider_')))
})

test('« biens non atteints dans le budget » décrit le NOMINAL, pas un incident', () => {
  // Le budget est fait pour ne pas tout atteindre, et `ordonnerPourImport` fait
  // passer devant ceux qu'on n'a pas servis. Le dire sur stderr faisait étiqueter
  // « error » toute invocation d'un parc plus grand qu'une passe.
  const fs = require('node:fs'), path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-messages.js'), 'utf8')
  // ⚠ LES DEUX BORNES SONT VERIFIEES AVANT DE DECOUPER. `indexOf` rend `-1`
  // quand le repere bouge, et `slice(debut, -1)` elargit alors SILENCIEUSEMENT au
  // reste du fichier : l'assertion `!warn` scannait du code sans rapport et
  // passait. Un test fragile doit echouer ferme, pas ouvert.
  const debut = src.indexOf('if (nonAtteints)')
  const fin = src.indexOf('const bilan')
  assert.ok(debut >= 0 && fin > debut, 'les repères du bloc existent toujours')
  // ⚠ LES COMMENTAIRES SONT RETIRES AVANT D'ASSERTER. Une assertion NEGATIVE sur
  // du source brut echoue des qu'un commentaire mentionne le terme qu'on
  // interdit — et c'est arrive : le commentaire explique pourquoi on ne compte
  // PLUS `traites === 0`. Un test doit lire le code, pas sa prose.
  const bloc = src.slice(debut, fin).replace(/\/\/.*$/gm, '')
  // ⚠ LE `warn` RESTE, MAIS SEULEMENT POUR L'ECHEC TOTAL. La demotion en bloc
  // rendait muette la seule trace d'une passe qui n'a rien fait : les biens
  // sautes n'ecrivent volontairement aucun etat, donc aucun compteur
  // d'abstention ne monte et `messages_import_suspendu` ne peut PAS partir pour
  // eux. On verifie donc le SENS du ternaire, pas seulement sa presence —
  // l'inverser est le defaut, et il passerait un test qui cherche les deux mots.
  // ⚠ SUR LES RESULTATS, PAS LES TENTATIVES. `traites++` compte les biens
  // ENTRES, y compris celui qui lève aussitôt : le scénario nommé (un pooler qui
  // pend dans le premier bien) donnait `traites: 1` et restait sur stdout.
  assert.match(bloc, /aboutis === 0/, 'l\'échec total se compte sur ce qui a abouti')
  assert.ok(!/traites === 0/.test(bloc), 'et plus sur les tentatives')
  assert.match(bloc, /rienFait\s*\?\s*console\.warn\s*:\s*console\.log/,
    'warn est la branche EXCEPTIONNELLE, log la nominale')
})

// ─── Le progrès, pas le nombre de tours ────────────────────────────────────

test('une abstention QUI A FAIT AVANCER remet le compteur à zéro', async () => {
  // ⚠ LE DÉFAUT CENTRAL, trouvé en review. Un rattrapage sur un fil plus long que
  // le budget s'abstient à CHAQUE cycle : avec un seuil brut, dès le 3e la ligne
  // repassait sur stderr pour tout le reste du rattrapage — et
  // `messages_import_suspendu` partait en disant « Import suspendu » alors que
  // `imported > 0` et que la reprise avançait. C'est l'alarme reçue sur Colomiers
  // pendant que l'import convergeait.
  const { aProgresse } = require('../lib/cron-channel-messages-sync')
  const etat = { abstentions: 40, reprise: { fil: 'f1', page: 3 } }
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 4 }, 0), true, 'la page avance')
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 3 }, 120), true,
    'même page, mais 120 messages écrits : le budget a coupé DANS la page')
  assert.strictEqual(aProgresse(etat, { fil: 'f2', page: 1 }, 5), true,
    'fil différent AVEC des écritures')
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 3 }, 0), false,
    'même fil, même page, rien écrit : RIEN n\'a bougé')
  assert.strictEqual(aProgresse({ abstentions: 0, reprise: null }, null, 0), false,
    'aucune reprise et rien écrit : pas un progrès')
})

test('le blocage de 125 cycles alerterait ENCORE — c\'est un NON-progrès répété', async () => {
  // ⚠ LA GARDE CONTRE LE RISQUE DE CE CORRECTIF. Le blocage du 15 septembre était
  // exactement ça : reprise rejetée, les mêmes 22 fils relus, zéro message écrit.
  // Le compteur monte donc toujours, et l'alerte part au 3e cycle comme avant.
  const { aProgresse } = require('../lib/cron-channel-messages-sync')
  const bloque = { abstentions: 2, reprise: { fil: 'f1', page: 1 } }
  assert.strictEqual(aProgresse(bloque, { fil: 'f1', page: 1 }, 0), false)

  const vu = await capturer(() => abstenir(supabaseAvec({
    abstentionsAvant: 2, reprise: { fil: 'f1', page: 1 } })))
  assert.strictEqual(vu.resultat.abstenu, true)
  assert.ok(vu.warn.some(l => /abstention/.test(l)),
    'au 3e cycle sans progrès, la voix repasse sur stderr')
})

test('la BORNE exacte est éprouvée, pas seulement au-delà', async () => {
  // ⚠ Le test précédent passait `ABSTENTIONS_AVANT_INCIDENT`, donc la 4e
  // abstention — jamais la 3e, le cycle même où `reportIncident` part. Un `<=`
  // au lieu d'un `<` aurait laissé la ligne sur stdout à l'instant précis où
  // l'e-mail d'incident est envoyé, et tous les tests seraient restés verts.
  const { ABSTENTIONS_AVANT_INCIDENT } = require('../lib/cron-channel-messages-sync')
  const juste = await capturer(() => abstenir(supabaseAvec({
    abstentionsAvant: ABSTENTIONS_AVANT_INCIDENT - 2, reprise: { fil: 'f1', page: 1 } })))
  assert.strictEqual(juste.warn.length, 0,
    `à ${ABSTENTIONS_AVANT_INCIDENT - 1} abstentions, on est encore sous le seuil`)

  const pile = await capturer(() => abstenir(supabaseAvec({
    abstentionsAvant: ABSTENTIONS_AVANT_INCIDENT - 1, reprise: { fil: 'f1', page: 1 } })))
  assert.ok(pile.warn.length > 0,
    `à ${ABSTENTIONS_AVANT_INCIDENT} pile, la voix passe sur stderr`)
})

test('sAbstenir UTILISE le progrès : le compteur écrit repart à zéro', async () => {
  // ⚠ CE TEST MANQUAIT, et la contre-épreuve l'a montré : retirer
  // `progres ? 0 : …` de `sAbstenir` ne faisait rougir aucun test, parce que
  // tous regardaient la fonction pure et jamais son EFFET. Un test qui vérifie
  // le calcul sans vérifier qu'on s'en sert ne protège rien.
  const rendre = avecProviderQuiAvance({ imported: 120, reprise: { fil: 'f1', page: 4 } })
  try {
    const supabase = supabaseAvec({ abstentionsAvant: 40, reprise: { fil: 'f1', page: 3 } })
    delete require.cache[require.resolve('../lib/cron-channel-messages-sync')]
    const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')
    const vu = await capturer(() =>
      importerMessagesDuBien(supabase, bien, { echeance: Date.now() + 60000, results: {} }))

    const ecrit = supabase.ecrits.find(r => r && 'total_messages' in r)
    assert.ok(ecrit, 'un état a bien été écrit')
    assert.strictEqual(ecrit.total_messages, 0,
      '40 abstentions, mais ça a avancé : le compteur repart à zéro')
    assert.strictEqual(vu.warn.length, 0, 'et la ligne reste sur stdout')
    assert.strictEqual(vu.error.length, 0)
    assert.ok(vu.log.some(l => /AVANCE/.test(l)), 'le journal le dit en clair')
  } finally { rendre() }
})

test('sans progrès, le compteur MONTE et la voix passe sur stderr', async () => {
  // La contre-épreuve du test ci-dessus : même chemin, même budget coupé, mais
  // rien n'a bougé — ni message écrit, ni reprise déplacée.
  const rendre = avecProviderQuiAvance({ imported: 0, reprise: { fil: 'f1', page: 3 } })
  try {
    const supabase = supabaseAvec({ abstentionsAvant: 40, reprise: { fil: 'f1', page: 3 } })
    delete require.cache[require.resolve('../lib/cron-channel-messages-sync')]
    const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')
    const vu = await capturer(() =>
      importerMessagesDuBien(supabase, bien, { echeance: Date.now() + 60000, results: {} }))

    const ecrit = supabase.ecrits.find(r => r && 'total_messages' in r)
    assert.strictEqual(ecrit.total_messages, 41, 'le compteur monte')
    assert.ok(vu.warn.length > 0, 'et la voix repasse sur stderr')
  } finally { rendre() }
})

test('des messages écrits SEULS suffisent — même reprise, même page', async () => {
  // ⚠ CONTRE-ÉPREUVE DU TEST PRÉCÉDENT : il faisait avancer la reprise ET écrire
  // des messages, donc retirer `imported` de l'appel ne le faisait pas rougir.
  // Ici la reprise ne bouge PAS : `imported` est le seul signal de progrès, et
  // c'est un vrai cas — un fil très long dont une passe entière ne finit pas la
  // page (le budget coupe à l'intérieur, depuis d67c3b7).
  const rendre = avecProviderQuiAvance({ imported: 300, reprise: { fil: 'f1', page: 3 } })
  try {
    const supabase = supabaseAvec({ abstentionsAvant: 12, reprise: { fil: 'f1', page: 3 } })
    delete require.cache[require.resolve('../lib/cron-channel-messages-sync')]
    const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')
    const vu = await capturer(() =>
      importerMessagesDuBien(supabase, bien, { echeance: Date.now() + 60000, results: {} }))

    const ecrit = supabase.ecrits.find(r => r && 'total_messages' in r)
    assert.strictEqual(ecrit.total_messages, 0, '300 messages écrits : ça avance')
    assert.strictEqual(vu.warn.length, 0, 'donc rien sur stderr')
    assert.strictEqual(vu.error.length, 0)
  } finally { rendre() }
})

// ─── Le risque INVERSE : un faux progrès qui étouffe une vraie panne ────────

test('un RECUL n\'est jamais un progrès — c\'est la signature du blocage', async () => {
  // ⚠ LE DÉFAUT QUE LA REVIEW A TROUVÉ. « Différent » n'est pas « avancé » :
  // `a.page !== b.page` rendait vrai pour un recul. Or `reprise ecartee` jette
  // le point de reprise et le fil repart de sa page 1 — donc le cycle suivant
  // coupe plus BAS. La page oscillait, chaque oscillation passait pour un
  // progrès, le compteur restait à zéro, et le journal affichait « ça AVANCE »
  // pendant que rien n'entrait. Une alarme qui ne crie jamais est pire que celle
  // qui crie au loup.
  const { aProgresse } = require('../lib/cron-channel-messages-sync')
  const etat = { abstentions: 2, reprise: { fil: 'f1', page: 5 } }
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 3 }, 0), false, 'page 5 → 3')
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 1 }, 0), false, 'retour page 1')
  assert.strictEqual(aProgresse(etat, { fil: 'f1', page: 3 }, 999), false,
    'et même avec des écritures ailleurs sur le bien : un recul reste un recul')
})

test('un fil qui DÉRIVE sans rien écrire n\'est pas un progrès', async () => {
  // ⚠ Sur un bien à 22 fils et `depuis === null`, le fil où le budget coupe
  // dérive d'un cycle à l'autre. Compter cette dérive comme un progrès rendait
  // l'alarme impossible à déclencher — exactement le cas Colomiers.
  const { aProgresse } = require('../lib/cron-channel-messages-sync')
  const etat = { abstentions: 7, reprise: { fil: 'f1', page: 2 } }
  assert.strictEqual(aProgresse(etat, { fil: 'f2', page: 1 }, 0), false, 'f1 → f2, rien écrit')
  assert.strictEqual(aProgresse({ abstentions: 8, reprise: { fil: 'f2', page: 1 } },
    { fil: 'f1', page: 2 }, 0), false, 'et f2 → f1, l\'oscillation')
})

test('un état ILLISIBLE ne se déclare pas « en progrès »', async () => {
  // ⚠ `ecrireEtat` avale son échec : si l'upsert est refusé, `etat.reprise` est
  // nul à CHAQUE lecture. Un `!a → true` rendait le bien « en progrès » pour
  // toujours, en affirmant l'inverse de la vérité dans le journal censé la dire.
  const { aProgresse } = require('../lib/cron-channel-messages-sync')
  assert.strictEqual(aProgresse({ abstentions: 30, reprise: null }, { fil: 'f1', page: 4 }, 0),
    false, 'on ne sait pas d\'où on vient : ce n\'est pas un progrès')
})
