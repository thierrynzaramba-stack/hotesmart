const test = require('node:test')
const assert = require('node:assert/strict')
const { creerClient } = require('../lib/airroi/client')

// ─── L'OPTION DE FRAICHEUR (28 octobre 2026) ───────────────────────────────
// ⚠ POURQUOI ELLE EXISTE : le cache AirROI dure 90 jours par point d'appel, et
// le releve mensuel des comparables a besoin d'une capture NEUVE a chaque
// passage — sinon les « photos a date » se repetent trois mois de suite et la
// comparaison « a delai egal » n'a que quatre points par an.
//
// ⚠ POURQUOI ELLE EST SURE : elle ne peut que RACCOURCIR le cache, jamais
// l'allonger. C'est la condition posee par Thierry — « sans changer le
// comportement par defaut utilise par YieldFlow ».

const JOUR = 86400000

// Un depot en memoire : un cache d'age reglable, un journal d'appels.
function faireDepot ({ ageJours = null } = {}) {
  const vu = { reseau: 0, caches: 0 }
  return {
    vu,
    depot: {
      async lireCache () {
        vu.caches++
        if (ageJours === null) return null
        return {
          reponse: JSON.stringify({ results: [{ date: '2026-09', revenue: 100 }] }),
          recupere_le: new Date(Date.now() - ageJours * JOUR).toISOString()
        }
      },
      async ecrireCache () {},
      async appelsDepuis () { return [] },
      // ⚠ LE DOUBLE PORTE TOUT CE QUE LE VRAI CLIENT APPELLE : `reserver` et
      // `terminer` encadrent chaque appel paye. Un double incomplet leve au
      // milieu, et le test echoue pour une raison qui n'est pas la sienne —
      // j'ai d'abord cru que l'option ne marchait pas.
      async reserver () { return { ok: true } },
      async terminer () {}
    }
  }
}

// Un `fetch` qui compte les departs reseau et rend une reponse valide.
function faireFetch (vu) {
  return async () => {
    vu.reseau++
    return {
      ok: true, status: 200,
      json: async () => ({ results: [{ date: '2026-09', revenue: 200 }] }),
      text: async () => JSON.stringify({ results: [{ date: '2026-09', revenue: 200 }] })
    }
  }
}

// ⚠ LA CLE D'API VIT DANS L'ENVIRONNEMENT, PAS DANS UNE OPTION : le client la
// lit au moment de l'appel reseau (lib/airroi/client.js), et sans elle il leve
// AVANT de partir. On en pose une FACTICE le temps du fichier — sans quoi les
// tests qui verifient qu'un appel PART echoueraient sur l'absence de cle, ce
// qui les ferait passer pour la mauvaise raison.
// ⚠ Et on remet l'environnement en etat a la fin : un test qui laisse une
// variable derriere lui contamine les suivants.
const CLE_AVANT = process.env.AIRROI_API_KEY
test.before(() => { process.env.AIRROI_API_KEY = 'cle-de-test' })
test.after(() => {
  if (CLE_AVANT === undefined) delete process.env.AIRROI_API_KEY
  else process.env.AIRROI_API_KEY = CLE_AVANT
})

const monter = (ageJours) => {
  const { vu, depot } = faireDepot({ ageJours })
  const client = creerClient({ depot, fetch: faireFetch(vu), alerter: null })
  return { vu, client }
}

test("LE TEST QUI COMPTE : SANS option, le cache de 90 jours sert — rien ne change", () => {
  // ⚠ C'EST LA CONDITION DE THIERRY, et c'est le test qui la garde : YieldFlow
  // n'appelle jamais avec l'option, donc son comportement doit etre EXACTEMENT
  // celui d'avant. Une capture de 40 jours est servie par le cache.
  const { vu, client } = monter(40)
  return client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1' }).then(r => {
    assert.equal(vu.reseau, 0, 'un appel est parti sur le reseau alors que le cache est frais')
    assert.equal(r.depuisCache, true)
  })
})

test("LE TEST QUI COMPTE : AVEC l option, une capture trop vieille repart", () => {
  // 40 jours est frais pour le defaut (90) et perime pour un releve mensuel.
  const { vu, client } = monter(40)
  return client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1', fraicheurMaxJours: 28 }).then(() => {
    assert.equal(vu.reseau, 1, 'le cache a ete servi alors que la fraicheur demandee est de 28 jours')
  })
})

test("LE TEST QUI COMPTE : une capture RECENTE est servie meme avec l option", () => {
  // L'option raccourcit, elle ne desactive pas : une capture de 3 jours reste
  // bonne pour un releve mensuel, et la repayer serait du gaspillage.
  const { vu, client } = monter(3)
  return client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1', fraicheurMaxJours: 28 }).then(() => {
    assert.equal(vu.reseau, 0, 'une capture de 3 jours a ete repayee pour une fraicheur de 28')
  })
})

test("LE TEST QUI COMPTE (SECURITE) : l option NE PEUT PAS ALLONGER le cache", () => {
  // ⚠ LA GARANTIE QUI REND L OPTION SURE. Un appelant distrait qui passerait
  // 9999 jours n obtient PAS une donnee perimee servie pour fraiche : il
  // obtient le comportement par defaut. Sans `Math.min`, cette option serait un
  // moyen de contourner la fraicheur que ces chiffres protegent.
  const { vu, client } = monter(120) // au-dela des 90 jours du defaut
  return client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1', fraicheurMaxJours: 9999 }).then(() => {
    assert.equal(vu.reseau, 1,
      'une capture de 120 jours a ete servie comme fraiche : l option a ALLONGE le cache')
  })
})

test("LE TEST QUI COMPTE : une fraicheur en CHAINE est lue comme un nombre", () => {
  // ⚠ LE CAS REEL : une valeur venue d'une variable d'environnement ou d'un
  // reglage arrive en CHAINE. Sans la conversion, `Number.isFinite('28')` est
  // faux, l'option retombe silencieusement sur le defaut de 90 jours — et le
  // releve mensuel redeviendrait trimestriel sans que rien ne le dise.
  // C'est la mutation qui ne mordait pas quand ce test n'existait pas.
  const { vu, client } = monter(40)
  return client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1', fraicheurMaxJours: '28' }).then(() => {
    assert.equal(vu.reseau, 1,
      'une fraicheur passee en chaine a ete ignoree : le cache de 90 jours a servi')
  })
})

test("LE TEST QUI COMPTE : une option ABSURDE retombe sur le defaut, elle ne casse pas", () => {
  for (const mauvais of [null, undefined, NaN, 'trente', -5, {}]) {
    const { vu, client } = monter(40)
    client.metriquesAnnonce('111', { userId: 'u1', propertyId: 'b1', fraicheurMaxJours: mauvais })
    assert.equal(vu.reseau, 0,
      `fraicheurMaxJours = ${String(mauvais)} a fait partir un appel : une valeur illisible doit retomber sur le defaut`)
  }
})

test("LE TEST QUI COMPTE : l ESTIMATION suit la meme borne que l appel", () => {
  // ⚠ SINON LE BUDGET MENT. Une estimation qui juge « servi par le cache, donc
  // gratuit » un appel que la fraicheur va faire partir sous-estime la
  // depense, et le plafond tombe au MILIEU du travail — exactement le defaut
  // que `estimer` existe pour eviter.
  const { client } = monter(40)
  const appels = [{ endpoint: 'GET /listings/metrics/all', params: { listing_id: '111', num_months: 60, currency: 'native' } }]
  return Promise.all([client.estimer(appels), client.estimer(appels, { fraicheurMaxJours: 28 })]).then(([sans, avec]) => {
    assert.equal(sans, 0, 'le defaut estime un cout alors que le cache est frais')
    assert.ok(avec > 0,
      `l estimation avec fraicheur rend ${avec} $ : elle croit l appel gratuit alors qu il va partir`)
  })
})
