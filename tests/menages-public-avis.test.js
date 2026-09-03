// tests/menages-public-avis.test.js
// Vue « Avis » de la PWA prestataire — les trois limites du §6.
//
// ⚠ POURQUOI CES TESTS EXISTENT ET CE QU'ILS GARDENT.
// `api/menages-public.js` s'ouvre avec un simple token en query string, sans
// session. Ce qui en sort est lu par une femme de ménage, sur son téléphone.
// Le §6 de docs/specs/spec-prestataires-menage.md pose trois limites non
// négociables : l'extrait SEUL, jamais le nom du voyageur, et une étiquette
// « retour privé » quand l'extrait vient d'un message que le voyageur n'avait
// pas rendu public. Rien de tout cela n'était vérifié par un test.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'regina-x6w01q', PROFIL = 'profil-regina'

const MODULES = ['../api/menages-public', '../lib/stats-avis',
                 '../lib/attribution-prestataire', '../lib/extrait-verifie',
                 '../lib/cron-property-status', '../lib/bookings-snapshot']

// Un avis complet, tel qu'il est EN BASE — avec tout ce qui ne doit pas sortir.
const AVIS_BASE = {
  id: 'avis-1', user_id: U, statut: 'confirme', property_id_ref: 'COL',
  ai_clean_verdict: 'remarque',
  ai_clean_excerpt: 'la bouilloire n\'était pas propre',
  content: 'Séjour parfait.\nla bouilloire n\'était pas propre',
  content_public: 'Séjour parfait.',
  content_private: 'la bouilloire n\'était pas propre',
  guest_name: 'Fanny Démollière',
  raw: { attributes: { reviewer: { name: 'Fanny Démollière' } } },
  received_at: '2026-08-30T00:00:00Z', stay_end: '2026-08-28',
  menage_event_id: null
}

function preparer ({ avis = [AVIS_BASE], droits = { self_view_reviews: true },
                     erreurDroits = null, erreurListe = null,
                     profil = { id: PROFIL, first_name: 'Régina', active: true },
                     periodes = [{ user_id: U, provider_id: PROFIL, property_id_ref: 'COL', debut: null, fin: null }],
                     biens = [{ user_id: U, provider_property_id: 'COL', name: 'Colomiers' }],
                     erreurBiens = null,
                     ratioPeriode = null,     // ce que porte public_tokens
                     erreurToken = null,      // panne de lecture du token
                     periodesDemandees = [],
                     journal = [] } = {}) {
  const client = {
    from (table) {
      const a = { table, f: {}, ins: [], colonnes: null }
      journal.push(a)
      const chain = {
        select (c, opts) { a.colonnes = c; a.head = !!(opts && opts.head); a.count = opts && opts.count; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        gte (c, v) { a.gte = [c, v]; if (table === 'ota_reviews') periodesDemandees.push(v); return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        not () { return chain }, order () { return chain },
        // ⚠ Chainable, comme le vrai builder : `.limit()` est suivi d'un `.gte()`
        // quand une periode est reglee. Un double qui rendait une Promise ici
        // faisait echouer le test, pas le code.
        limit () { return chain },
        maybeSingle () {
          if (table === 'public_tokens') {
            if (erreurToken) return Promise.resolve({ data: null, error: erreurToken })
            if (a.f.token !== TOKEN) return Promise.resolve({ data: null, error: null })
            // ⚠ Ne rend QUE les colonnes demandees, comme PostgREST : un double
            // qui sert `ratio_periode` sans qu'on l'ait selectionnee est plus
            // permissif que la base, et couvrirait un select incomplet.
            const ligne = { user_id: U, ratio_periode: ratioPeriode }
            const out = {}
            for (const c of String(a.colonnes || '').split(',').map(x => x.trim())) {
              if (c && Object.prototype.hasOwnProperty.call(ligne, c)) out[c] = ligne[c]
            }
            return Promise.resolve({ data: out, error: null })
          }
          if (table === 'profiles') return Promise.resolve({ data: profil, error: null })
          if (table === 'profile_permissions') return Promise.resolve({ data: droits, error: erreurDroits })
          const r = rep(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error })
        },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      function rep () {
        if (table === 'prestataire_periodes') return { data: periodes.filter(p =>
          (a.f.user_id == null || p.user_id === a.f.user_id) &&
          (a.f.provider_id == null || p.provider_id === a.f.provider_id)), error: null }
        if (table === 'menage_events') return { data: [], error: null }
        if (table === 'properties') {
          if (erreurBiens) return { data: null, error: erreurBiens }
          return { data: biens.filter(b =>
            (a.f.user_id == null || b.user_id === a.f.user_id) &&
            a.ins.every(f => f.v.includes(String(b[f.c])))), error: null }
        }
        if (table === 'ota_reviews') {
          if (erreurListe && !a.head) return { data: null, count: null, error: erreurListe }
          const d = avis.filter(v =>
            (a.f.user_id == null || v.user_id === a.f.user_id) &&
            (a.f.statut == null || (v.statut || 'confirme') === a.f.statut) &&
            (a.f.ai_clean_verdict == null || v.ai_clean_verdict === a.f.ai_clean_verdict) &&
            (a.f.property_id_ref == null || v.property_id_ref === a.f.property_id_ref) &&
            a.ins.every(f => f.v.includes(String(v[f.c]))))
          return { data: a.head ? null : d, count: d.length, error: null }
        }
        return { data: [], count: 0, error: null }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  journal.periodesDemandees = periodesDemandees
  return journal
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const req = (q = {}) => ({ method: 'GET', query: { token: TOKEN, action: 'avis', ...q }, headers: {} })

// ─── Le périmètre des colonnes, DANS LES DEUX SENS ─────────────────────────
const INTERDITS = ['guest_name', 'content', 'content_public', 'raw', 'ota_reservation_id', 'booking_uid']

test('la réponse ne contient AUCUN champ interdit — sérialisée en entier', async () => {
  // Test sur le JSON complet, pas champ par champ : un champ ajouté demain à un
  // niveau imprévu serait attrapé.
  preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('Fanny'), 'le nom du voyageur ne doit JAMAIS sortir')
  assert.ok(!brut.includes('Séjour parfait'), 'le texte public de l\'avis ne sort pas non plus')
  for (const champ of INTERDITS) {
    assert.ok(!brut.includes(`"${champ}"`), `${champ} ne doit pas être dans la réponse`)
  }
})

test('la réponse contient bien ce qu\'elle DOIT contenir', async () => {
  // Le sens inverse : un test qui ne vérifie que des absences reste vert sur une
  // réponse vide.
  preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.prenom, 'Régina')
  assert.strictEqual(res.body.autorise, true)
  assert.strictEqual(res.body.avis.length, 1)
  assert.deepStrictEqual(Object.keys(res.body.avis[0]).sort(),
    ['bien', 'bienNom', 'extrait', 'id', 'prive', 'recuLe', 'sejourDebut', 'sejourFin', 'verdict'])
  assert.strictEqual(res.body.avis[0].extrait, 'la bouilloire n\'était pas propre')
  assert.strictEqual(res.body.avis[0].bienNom, 'Colomiers')
  assert.ok(res.body.ratio, 'le ratio doit être présent')
})

test('le nom du bien est résolu POUR CE COMPTE seulement', async () => {
  // Un bien d'un autre compte portant le même identifiant provider (Beds24
  // n'est pas globalement unique entre comptes) ne doit pas prêter son nom.
  preparer({ biens: [{ user_id: 'autre-compte', provider_property_id: 'COL', name: 'Villa du voisin' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis[0].bienNom, null)
})

test('une panne sur les noms de biens ne coupe PAS la liste', async () => {
  // Le nom est un confort ; l'avis, lui, doit s'afficher. On rend la liste sans
  // le nom plutôt qu'un 503 — l'affichage n'y substitue pas l'identifiant
  // provider, qui n'apprendrait rien à une femme de ménage.
  preparer({ erreurBiens: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.avis.length, 1)
  assert.strictEqual(res.body.avis[0].bienNom, null)
  assert.strictEqual(res.body.avis[0].bien, 'COL')
})

test('la requête ne SÉLECTIONNE pas les colonnes interdites', async () => {
  // Une donnée non demandée à la base ne peut pas fuiter par accident plus tard.
  const journal = preparer({})
  const handler = require('../api/menages-public')
  await handler(req({ detail: '1' }), reponse())
  const lecture = journal.filter(j => j.table === 'ota_reviews' && j.colonnes && !j.head).pop()
  assert.ok(lecture, 'la liste doit être lue')
  for (const champ of ['guest_name', 'raw', 'ota_reservation_id']) {
    assert.ok(!lecture.colonnes.includes(champ), `${champ} ne doit pas être sélectionné`)
  }
  // `content_public` EST sélectionné — il sert à décider de l'étiquette côté
  // serveur — mais il ne sort pas (test précédent).
  assert.ok(lecture.colonnes.includes('content_public'))
})

// ─── L'étiquette « retour privé », les trois cas ───────────────────────────
test('extrait venant du PUBLIC : prive = false', async () => {
  preparer({ avis: [{ ...AVIS_BASE,
    ai_clean_excerpt: 'Séjour parfait',
    content_public: 'Séjour parfait, tout était nickel.',
    content_private: 'Rien à signaler.' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis[0].prive, false)
})

test('extrait venant du PRIVÉ : prive = true', async () => {
  preparer({})   // AVIS_BASE : l'extrait est exactement le content_private
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis[0].prive, true)
})

test('extrait À CHEVAL public/privé : prive = true', async () => {
  // ⚠ Le cas qui a motivé le correctif. La classification analyse la
  // CONCATÉNATION public + privé avec des espaces souples : un extrait qui
  // commence dans l'un et finit dans l'autre n'est une sous-chaîne exacte NI de
  // l'un NI de l'autre. Il sortait avec prive:false, et la prestataire lisait un
  // reproche venu d'un message que le voyageur n'avait pas rendu public, sans
  // le savoir — donc libre de le citer ailleurs.
  preparer({ avis: [{ ...AVIS_BASE,
    content_public: 'Super séjour, tout était nickel.',
    content_private: 'Juste la bouilloire, pas du tout propre.',
    ai_clean_excerpt: 'nickel. Juste la bouilloire' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis[0].prive, true, 'dans le doute, on étiquette')
})

test('aucun retour privé sur l\'avis : prive = false', async () => {
  preparer({ avis: [{ ...AVIS_BASE, content_private: null,
                      ai_clean_excerpt: 'Séjour parfait', content_public: 'Séjour parfait.' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis[0].prive, false)
})

// ─── self_view_reviews ─────────────────────────────────────────────────────
test('self_view_reviews = true : la vue s\'affiche', async () => {
  preparer({ droits: { self_view_reviews: true } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.autorise, true)
  assert.strictEqual(res.body.avis.length, 1)
})

test('self_view_reviews = false : rien ne sort', async () => {
  preparer({ droits: { self_view_reviews: false } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.autorise, false)
  assert.deepStrictEqual(res.body.avis, [])
  assert.strictEqual(res.body.ratio, null)
  assert.ok(!JSON.stringify(res.body).includes('bouilloire'), 'aucun extrait ne doit sortir')
})

test('PANNE de lecture des droits : la vue est COUPÉE, pas ouverte', async () => {
  // ⚠ Sur un drapeau de confidentialité, la panne coupe. L'erreur n'était pas
  // lue : un timeout rendait `droits` null et la vue s'affichait ENTIÈREMENT,
  // y compris pour un hôte ayant explicitement coupé le partage.
  preparer({ erreurDroits: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 503)
  assert.ok(!JSON.stringify(res.body).includes('bouilloire'))
})

test('PANNE de lecture de la liste : 503, pas une liste vide silencieuse', async () => {
  // Une liste vide par erreur est indiscernable de « aucun avis » — alors que le
  // ratio affiché à côté annoncerait un nombre non nul.
  preparer({ erreurListe: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 503)
})

// ─── Les gardes d'accès ────────────────────────────────────────────────────
test('un token inconnu est refusé', async () => {
  preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler({ method: 'GET', query: { token: 'inconnu', action: 'avis' }, headers: {} }, res)
  assert.strictEqual(res.code, 401)
})

test('un profil désactivé ne voit rien', async () => {
  preparer({ profil: { id: PROFIL, first_name: 'Régina', active: false } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.actif, false)
  assert.deepStrictEqual(res.body.avis, [])
})

test('sans detail=1, le ratio sort mais pas la liste', async () => {
  // La vue par défaut n'affiche que le ratio à côté du prénom.
  preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.avis, [])
  assert.ok(res.body.ratio)
  assert.ok(!JSON.stringify(res.body).includes('bouilloire'))
})

test('la prestataire ne voit QUE les avis qui lui sont attribués', async () => {
  // L'invariant central : sans le `.in('id', …)`, elle verrait ceux de l'hôte.
  preparer({ avis: [
    AVIS_BASE,
    { ...AVIS_BASE, id: 'pas-a-elle', property_id_ref: 'AUTRE-BIEN',
      ai_clean_excerpt: 'ceci ne la concerne pas' }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.avis.length, 1)
  assert.strictEqual(res.body.avis[0].id, 'avis-1')
  assert.ok(!JSON.stringify(res.body).includes('ne la concerne pas'))
})

test('PANNE d\'ATTRIBUTION : 503, pas une liste vide silencieuse', async () => {
  // ⚠ Défaut trouvé en écrivant ces tests. `avisDuPrestataire` renvoie
  // { erreur: true } sur cinq chemins de panne ; la condition
  // `if (!att.erreur && att.ids.length)` sautait alors silencieusement et
  // laissait partir un 200 avec une liste vide — indiscernable de « aucun
  // avis », alors que la base en contient 98 pour Régina. Elle en aurait tiré
  // une conclusion fausse et l'aurait gardée.
  //
  // L'incohérence était visible dans le même bloc : panne de la LISTE → 503,
  // panne de l'ATTRIBUTION → 200 vide, à cinq lignes d'écart.
  const journal = []
  preparer({ journal })
  // On fait échouer la lecture des périodes, l'un des cinq chemins.
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const vrai = require.cache[abs].exports.createClient
  require.cache[abs].exports = { createClient: () => {
    const c = vrai()
    const orig = c.from.bind(c)
    c.from = (t) => {
      const chain = orig(t)
      if (t === 'prestataire_periodes') {
        chain.then = (r) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(r)
      }
      return chain
    }
    return c
  } }
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }

  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 503, 'une panne d\'attribution ne doit pas passer pour « aucun avis »')
})

// ─── La période du ratio vient de l'hôte, pas du porteur du lien ───────────

test('la période appliquée est celle réglée sur public_tokens', async () => {
  const journal = preparer({ ratioPeriode: '15j' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.periode, '15j')
  assert.ok(journal.periodesDemandees.length, 'une borne temporelle doit être posée sur ota_reviews')
})

test('la query string ne déplace PAS l\'objectif de l\'en-tête', async () => {
  // Deux périodes, deux fonctions : `periode` est l'objectif réglé par l'hôte,
  // et rien venu du client ne doit l'atteindre. La consultation, elle, est
  // libre — c'est `periodeVue`, testée juste en dessous.
  preparer({ ratioPeriode: '15j' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1', periode: 'toujours' }), res)
  assert.strictEqual(res.body.periode, '15j', 'l\'objectif ne bouge pas')
  assert.strictEqual(res.body.periodeVue, 'toujours', 'la consultation suit la demande')
  assert.ok(res.body.ratio, 'le compteur de l\'objectif est toujours là')
  assert.ok(res.body.ratioVue, 'et celui du dossier à côté')
})

test('sans période demandée, le dossier suit l\'objectif', async () => {
  // Défaut sûr : un écran ouvert sans choix montre ce que l'hôte a réglé.
  preparer({ ratioPeriode: '15j' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.periodeVue, '15j')
})

test('une période bricolée dans l\'URL retombe sur « toujours »', async () => {
  // `periodeNormalisee` retomberait sur '30j' : un compteur rétréci que personne
  // n'a demandé. La validation est explicite des deux côtés.
  preparer({ ratioPeriode: 'toujours' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1', periode: '__proto__' }), res)
  assert.strictEqual(res.body.periodeVue, 'toujours')
})

test('la LISTE suit la période consultée, pas l\'objectif', async () => {
  // Un compteur qui annonce 15 jours au-dessus d'une liste qui en montre 183 est
  // un écran qui se contredit tout seul.
  //
  // ⚠ L'assertion vise la requête de LISTE précisément — reconnaissable à ses
  // colonnes. Compter les bornes de tout le journal ne discriminait rien : le
  // compteur de consultation en pose aussi, si bien que la mutation « la liste
  // suit l'objectif » restait verte.
  const journal = preparer({ ratioPeriode: 'toujours' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1', periode: '15j' }), res)
  assert.strictEqual(res.body.periodeVue, '15j')
  const liste = journal.find(a => a.table === 'ota_reviews' && !a.head &&
    String(a.colonnes || '').includes('ai_clean_excerpt'))
  assert.ok(liste, 'la requête de liste doit exister')
  assert.ok(liste.gte, 'elle doit porter une borne : l\'objectif « toujours » n\'en pose aucune')
  assert.strictEqual(liste.gte[0], 'received_at')
})

test('la liste ne pose AUCUNE borne quand la consultation est « depuis le début »', async () => {
  // Contre-épreuve : poser une borne systématiquement passerait aussi le test
  // précédent, en amputant silencieusement le dossier.
  const journal = preparer({ ratioPeriode: '15j' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1', periode: 'toujours' }), res)
  const liste = journal.find(a => a.table === 'ota_reviews' && !a.head &&
    String(a.colonnes || '').includes('ai_clean_excerpt'))
  assert.ok(liste && !liste.gte, 'aucune borne ne doit être posée')
})

test('sans detail=1, aucun compteur de consultation n\'est calculé', async () => {
  // La sonde d'ouverture ne sert qu'à l'en-tête : lui faire calculer un second
  // ratio serait payer deux fois pour un écran qui n'est pas ouvert.
  preparer({ ratioPeriode: '15j' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ periode: 'toujours' }), res)
  assert.strictEqual(res.body.ratioVue, undefined)
  assert.strictEqual(res.body.periode, '15j')
})

test('sans réglage, le défaut est « toujours » — pas 30 jours', async () => {
  // `periodeNormalisee` retombe sur '30j' sur une valeur inconnue : appliqué tel
  // quel, il aurait rétréci le ratio de tout le monde sans décision d'un hôte.
  const journal = preparer({ ratioPeriode: null })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.periode, 'toujours')
  assert.strictEqual(journal.periodesDemandees.length, 0, 'aucune borne ne doit être posée')
})

test('valeur inconnue en base : « toujours », jamais un rétrécissement muet', async () => {
  const journal = preparer({ ratioPeriode: 'trimestre' })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.body.periode, 'toujours')
  assert.strictEqual(journal.periodesDemandees.length, 0)
})

test('PANNE de lecture du token : 503, jamais « Token invalide »', async () => {
  // Un `select` en panne rend `data` null, indiscernable d'un token inconnu :
  // la PWA annonçait un lien invalide à une prestataire dont le lien est bon.
  preparer({ erreurToken: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 503)
})

test('PANNE de lecture du token : la coupure est EFFECTIVE', async () => {
  // ⚠ L'assertion précédente (`!res.body.ratio`) était satisfaite par n'importe
  // quel corps d'erreur, 401 compris : elle ne distinguait pas le correctif du
  // défaut. Ce qui prouve la coupure, c'est qu'aucun comptage n'a lieu — le
  // repli précédent, lui, recalculait le ratio sur tout l'historique au lieu de
  // la période réglée par l'hôte.
  const journal = preparer({ erreurToken: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(journal.filter(a => a.table === 'ota_reviews').length, 0,
    'aucun avis ne doit être lu ni compté après une panne de lecture du token')
  assert.strictEqual(journal.filter(a => a.table === 'profile_permissions').length, 0)
})

// ─── Les trois dates, jamais fondues en une ────────────────────────────────

test('le séjour et la réception sortent SÉPARÉMENT', async () => {
  preparer({ avis: [{ ...AVIS_BASE, stay_start: '2026-08-25', stay_end: '2026-08-28',
                      received_at: '2026-08-30T00:00:00Z' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  const a = res.body.avis[0]
  assert.strictEqual(a.sejourDebut, '2026-08-25')
  assert.strictEqual(a.sejourFin, '2026-08-28')
  assert.strictEqual(a.recuLe, '2026-08-30T00:00:00Z')
})

test('un avis SANS séjour ne se voit pas attribuer une date inventée', async () => {
  // L'ancien `stay_end || received_at` présentait la date de réception comme
  // une date de séjour : la prestataire aurait cherché le mauvais ménage.
  preparer({ avis: [{ ...AVIS_BASE, stay_start: null, stay_end: null,
                      received_at: '2026-08-30T00:00:00Z' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req({ detail: '1' }), res)
  const a = res.body.avis[0]
  assert.strictEqual(a.sejourDebut, null)
  assert.strictEqual(a.sejourFin, null)
  assert.strictEqual(a.recuLe, '2026-08-30T00:00:00Z')
})

// ─── Une panne ne doit jamais se faire passer pour un lien invalide ────────
// ⚠ Sur les deux chemins d'ÉCRITURE, la différence détruit du travail : le
// front supprime l'action de sa file d'attente sur tout 4xx (le serveur a
// tranché, inutile de rejouer). Un timeout PostgREST pendant la resynchro
// effaçait donc silencieusement un « ménage fait ».

const CHEMINS = [
  { nom: 'planning (GET)',   req: () => ({ method: 'GET', query: { token: TOKEN }, headers: {} }) },
  { nom: 'markDone (POST)',  req: () => ({ method: 'POST', query: { token: TOKEN },
      body: { action: 'markDone', booking_id: 'b1', property_id: 'COL', departure_date: '2026-08-01' }, headers: {} }) },
  { nom: 'markUndone (POST)', req: () => ({ method: 'POST', query: { token: TOKEN },
      body: { action: 'markUndone', booking_id: 'b1', property_id: 'COL', departure_date: '2026-08-01' }, headers: {} }) }
]

for (const c of CHEMINS) {
  test(`${c.nom} : une panne de lecture du token rend 503, pas 401`, async () => {
    preparer({ erreurToken: { message: 'timeout' } })
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(c.req(), res)
    assert.notStrictEqual(res.code, 401, 'un 4xx fait purger la file d\'attente du front')
    assert.strictEqual(res.code, 503)
  })
}

test('un token réellement inconnu rend toujours 401', async () => {
  // Contre-épreuve : répondre 503 à tout le monde masquerait un lien révoqué.
  preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler({ method: 'GET', query: { token: 'lien-revoque' }, headers: {} }, res)
  assert.strictEqual(res.code, 401)
})
