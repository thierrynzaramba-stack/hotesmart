// tests/guestflow-appliquer-delai.test.js
// « Mon dernier reglage gouverne toujours » : les brouillons DEJA en attente
// suivent le reglage qu'on vient d'enregistrer (lib/guestflow/appliquer-delai.js).
// Decision de Thierry du 28 octobre 2026, nee de sa recette staging.
//
// ⚠ L'HORLOGE EST INJECTEE (`maintenant`), donc les dates sont FIGEES — regle
// du depot. Aucun test de ce fichier ne lit l'heure reelle.
//
// ⚠ LE DOUBLE APPLIQUE VRAIMENT LES CONDITIONS, et c'est le point le plus
// important de ce banc. Deux faux verts qu'un double permissif aurait laisses
// passer :
//   · un update conditionne sur `.eq('status', 'pending_validation')` qui
//     toucherait une tache deja `sending` — le claim ne fermerait plus la course
//     cron/clic, et rien ne le dirait ;
//   · une lecture `.limit(PAGE)` sans curseur, qui rendrait toujours la premiere
//     page — la pagination semblerait marcher sur 1200 lignes alors qu'elle
//     boucle sur les 500 memes.
// Le double refuse donc ce que PostgREST refuse, il rend `{ error }` au lieu de
// lever, et il COMPTE ses lectures pour qu'un curseur immobile se voie.

const test = require('node:test')
const assert = require('node:assert')
const { appliquerDelaiAuxBrouillons, PAGE, MAX_PAGES } =
  require('../lib/guestflow/appliquer-delai')

const T0 = Date.parse('2026-11-11T11:00:00Z')
const NE_A = '2026-11-11T10:30:00Z'          // le brouillon est ne 30 min avant T0
const COMPTE = 'compte-1'
const AUTRE_COMPTE = 'compte-2'
const REF = '0544fd9a'
const AUTRE_REF = '0544fd9b'

const MINUTE = 60 * 1000

function tache (p = {}) {
  return {
    id: p.id || 'tache-1',
    user_id: COMPTE,
    property_id: REF,
    status: 'pending_validation',
    created_at: NE_A,
    // ⚠ 45 min, ET PAS 30 : a 30 min, `creation + 60 min` tombait exactement sur
    // l echeance deja posee, donc le cas NOMINAL etait un no-op idempotent et
    // deux tests passaient pour la mauvaise raison. Une fixture qui rend le
    // resultat attendu par hasard ne mesure rien.
    send_after: new Date(T0 + 45 * MINUTE).toISOString(),
    suspendu_le: null,
    updated_at: new Date(T0 - 10 * MINUTE).toISOString(),
    ...p
  }
}

// ─── Le double ──────────────────────────────────────────────────────────────
function banc ({ taches = [], panneLecture = false, panneEcriture = false } = {}) {
  const etat = {
    taches: taches.map(t => ({ ...t })),
    lectures: [],            // les filtres de chaque SELECT, dans l'ordre
    updates: []              // { id, patch }
  }

  const client = {
    from (table) {
      assert.equal(table, 'agent_tasks', 'ce module ne lit et n ecrit que agent_tasks')
      const f = { eq: {}, gt: {} }
      let maj = null
      let estUpdate = false
      const q = {
        select () { return q },
        eq (c, v) { f.eq[c] = v; return q },
        gt (c, v) { f.gt[c] = v; return q },
        order (c, o) { f.ordre = { c, o }; return q },
        limit (n) { f.limite = n; return q },
        update (patch) { estUpdate = true; maj = patch; return q },
        then (res, rej) {
          const correspond = (t) => {
            for (const [c, v] of Object.entries(f.eq)) {
              if (v === null) { if (t[c] !== null && t[c] !== undefined) return false; continue }
              if (String(t[c]) !== String(v)) return false
            }
            // ⚠ LE CURSEUR MORD VRAIMENT : sans ce `>`, la pagination tournerait
            // en rond sur la premiere page et le test ne le verrait pas.
            for (const [c, v] of Object.entries(f.gt)) if (!(String(t[c]) > String(v))) return false
            return true
          }
          if (estUpdate) {
            if (panneEcriture) {
              return Promise.resolve({ data: null, error: { message: 'panne ecriture' } }).then(res, rej)
            }
            const touchees = etat.taches.filter(correspond)
            for (const l of touchees) {
              Object.assign(l, maj)
              etat.updates.push({ id: l.id, patch: { ...maj } })
            }
            return Promise.resolve({ data: touchees.map(l => ({ id: l.id })), error: null }).then(res, rej)
          }
          if (panneLecture) {
            // PostgREST rend `{ error }`, il ne leve pas.
            return Promise.resolve({ data: null, error: { message: 'panne lecture' } }).then(res, rej)
          }
          etat.lectures.push({ eq: { ...f.eq }, gt: { ...f.gt }, ordre: f.ordre, limite: f.limite })
          assert.ok(f.ordre && f.ordre.c === 'id',
            'une lecture paginee SANS ordre stable est une troncature silencieuse')
          assert.ok(f.limite, 'une lecture non bornee se tronque a 1000 sans erreur')
          let lignes = etat.taches.filter(correspond)
            .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)
          lignes = lignes.slice(0, f.limite)
          return Promise.resolve({ data: lignes.map(l => ({ ...l })), error: null }).then(res, rej)
        }
      }
      return q
    }
  }
  return { etat, client }
}

test('⚠ `echues` COMPTE les taches suspendues : une suspension differe un depart', async () => {
  // ⚠ CE TEST DISAIT L'INVERSE, ET IL FIGEAIT LE DEFAUT. C'est la regle 17 de
  // REVIEW.md en acte — « un test peut figer un bug » —, et c'est Thierry qui
  // l'a trouve en recette, pas la suite : « une proposition qui finira par
  // partir seule compte, suspendue ou non ».
  //
  // Mon raisonnement d'alors : `lireLesDues` ecarte les suspendues
  // (`.is('suspendu_le', null)`), donc les compter annoncerait un envoi
  // impossible. Vrai pour CE lecteur, faux pour la passe : dans le meme
  // fichier, `reprendreSuspensionsDormantes` efface `suspendu_le` apres
  // 30 minutes sans geste de l'hote et repose l'echeance au plancher de 5 min.
  // J'avais lu la moitie du chemin.
  const vieux = '2026-11-11T08:00:00Z'   // +60 min -> 9 h, donc echu a T0 (11 h)
  const b = banc({ taches: [
    tache({ id: 'libre', created_at: vieux, send_after: null }),
    tache({ id: 'sus', created_at: vieux, send_after: null,
      suspendu_le: new Date(T0 - 5 * MINUTE).toISOString() })
  ] })
  const r = await lancer(b, DANS_60, { apercu: true })
  assert.equal(r.rearmes, 2, 'les deux seraient rearmees')
  assert.equal(r.echues, 2, 'et les DEUX partiront seules : la suspendue aussi')
})

test('bilanVide rend les SIX compteurs, et c est le contrat du module', () => {
  const { bilanVide } = require('../lib/guestflow/appliquer-delai')
  const v = bilanVide()
  for (const c of ['desarmes', 'rearmes', 'inchanges', 'deja_prises', 'echues', 'sans_creation']) {
    assert.equal(v[c], 0, `${c} est present et a zero`)
  }
  assert.equal(v.ok, false, 'et il refuse par defaut')
  assert.equal(bilanVide({ ok: true, motif: 'x' }).motif, 'x', 'les champs se surchargent')
  // ⚠ IL EXISTE PARCE QUE DEUX COPIES ONT DIVERGE : le chemin d exception de
  // l endpoint listait QUATRE compteurs a la main, et les deux ajoutes ensuite
  // (`deja_prises`, `echues`) y manquaient, alors que le JSDoc les promettait.
  const src = sansComm(lire('api/agent-config.js'))
  assert.ok(!/desarmes: 0, rearmes: 0, inchanges: 0, sans_creation: 0/.test(src),
    'l endpoint ne recopie plus la liste des compteurs')
  assert.equal((src.match(/bilanVide\(/g) || []).length, 3,
    'il passe par bilanVide aux trois endroits qui en fabriquent un')
})

const lancer = (b, delais, opts = {}) => appliquerDelaiAuxBrouillons(b.client, {
  userId: COMPTE, propertyRef: REF, delais, maintenant: T0, ...opts
})

const MANUEL = { reponse_ia: null, alerte_info: 0 }
const DANS_60 = { reponse_ia: 60, alerte_info: 0 }
const TOUT_DE_SUITE = { reponse_ia: 0, alerte_info: 0 }

const par = (b, id) => b.etat.taches.find(t => t.id === id)

// ════════════════════════════════════════════════════════════════════════════
// Validation manuelle : les brouillons sont DESARMES
// ════════════════════════════════════════════════════════════════════════════

test('validation manuelle : l echeance tombe, et le compte a rebours avec', async () => {
  const b = banc({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, true)
  assert.equal(r.motif, 'validation_manuelle')
  assert.equal(r.desarmes, 2)
  assert.equal(r.rearmes, 0)
  for (const id of ['a', 'b']) {
    assert.equal(par(b, id).send_after, null, `${id} est desarmee`)
    assert.equal(par(b, id).status, 'pending_validation', `${id} reste a valider`)
  }
})

test('⚠ et la SUSPENSION s efface avec l echeance, sinon l etat est sans issue', async () => {
  // Constat 5 de la seconde revue du lot 2, rejoue ici : desarmer en laissant
  // `suspendu_le` donne « En attente : vous modifiez » pour toujours — le pied
  // n'offre pas de reprise sans echeance, et `reprendreSuspensionsDormantes`
  // exige `send_after` non nul pour reprendre.
  const b = banc({ taches: [tache({ id: 'a', suspendu_le: new Date(T0 - 2 * MINUTE).toISOString() })] })
  const r = await lancer(b, MANUEL)
  assert.equal(r.desarmes, 1)
  assert.equal(par(b, 'a').send_after, null)
  assert.equal(par(b, 'a').suspendu_le, null, 'la suspension ne survit pas au desarmement')
})

test('une tache deja desarmee et non suspendue n est pas reecrite', async () => {
  // `updated_at` est lu par la passe : le toucher pour rien n'est pas neutre.
  const b = banc({ taches: [tache({ id: 'a', send_after: null })] })
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, true)
  assert.equal(r.desarmes, 0)
  assert.equal(r.inchanges, 1)
  assert.equal(b.etat.updates.length, 0, 'aucune ecriture')
})

// ════════════════════════════════════════════════════════════════════════════
// Un autre delai : l echeance est recalculee DEPUIS LA CREATION
// ════════════════════════════════════════════════════════════════════════════

test('⚠ l echeance se recalcule depuis la CREATION du brouillon, pas depuis le clic', async () => {
  // La decision de Thierry : un brouillon ne a 10 h 30 avec 60 min de delai
  // part a 11 h 30, que l hote ait regle a 10 h 31 ou a 10 h 59.
  const b = banc({ taches: [tache({ id: 'a' })] })
  const r = await lancer(b, DANS_60)
  assert.equal(r.ok, true)
  assert.equal(r.motif, 'differe')
  assert.equal(r.rearmes, 1)
  assert.equal(par(b, 'a').send_after, '2026-11-11T11:30:00.000Z',
    'creation + 60 min, et non maintenant + 60 min')
  assert.notEqual(par(b, 'a').send_after, new Date(T0 + 60 * MINUTE).toISOString(),
    'le clic sur Enregistrer ne remet pas le compteur a zero')
})

test('⚠ une echeance DEJA PASSEE est posee telle quelle : le brouillon part au prochain passage', async () => {
  // « Si elle est deja passee, il part au prochain passage, c est ce que l hote
  // a demande. » Donc aucun plancher, aucun report a maintenant.
  const b = banc({ taches: [tache({ id: 'a', created_at: '2026-11-11T09:00:00Z' })] })
  const r = await lancer(b, DANS_60)
  assert.equal(r.rearmes, 1)
  const pose = par(b, 'a').send_after
  assert.equal(pose, '2026-11-11T10:00:00.000Z')
  assert.ok(Date.parse(pose) < T0, 'l echeance est dans le passe, donc echue')
})

test('« Tout de suite » : l echeance est la creation, donc echue d emblee', async () => {
  const b = banc({ taches: [tache({ id: 'a' })] })
  const r = await lancer(b, TOUT_DE_SUITE)
  assert.equal(r.ok, true)
  assert.equal(r.motif, 'immediat')
  assert.equal(r.rearmes, 1)
  assert.equal(par(b, 'a').send_after, '2026-11-11T10:30:00.000Z')
})

test('⚠ au REARMEMENT la suspension est GARDEE : rien ne part sous les doigts de l hote', async () => {
  // La suspension protege le brouillon OUVERT dans la saisie. L effacer armerait
  // un compte a rebours sur un texte en train d etre ecrit.
  const suspendu = new Date(T0 - 2 * MINUTE).toISOString()
  const b = banc({ taches: [tache({ id: 'a', suspendu_le: suspendu })] })
  const r = await lancer(b, DANS_60)
  assert.equal(r.rearmes, 1)
  assert.equal(par(b, 'a').suspendu_le, suspendu, 'la suspension survit au rearmement')
  assert.equal(par(b, 'a').send_after, '2026-11-11T11:30:00.000Z',
    'mais le reglage gouverne bien l echeance')
})

test('une echeance deja juste n est pas reecrite (le geste est idempotent)', async () => {
  const b = banc({ taches: [tache({ id: 'a' })] })
  await lancer(b, DANS_60)
  const avant = b.etat.updates.length
  const r = await lancer(b, DANS_60)
  assert.equal(r.ok, true)
  assert.equal(r.rearmes, 0)
  assert.equal(r.inchanges, 1)
  assert.equal(b.etat.updates.length, avant, 'relancer n ecrit rien')
})

test('created_at illisible : repli sur MAINTENANT, et il est COMPTE', async () => {
  // `agent_tasks.created_at` est nullable en base. Le repli le plus tardif est
  // le seul acceptable : il ne fait jamais partir un message plus tot que dit.
  for (const mauvais of [null, undefined, 'pas-une-date']) {
    const b = banc({ taches: [tache({ id: 'a', created_at: mauvais })] })
    const r = await lancer(b, DANS_60)
    assert.equal(r.rearmes, 1)
    assert.equal(r.sans_creation, 1, `${mauvais} est compte`)
    assert.equal(par(b, 'a').send_after, new Date(T0 + 60 * MINUTE).toISOString(),
      'depuis maintenant, donc au plus tard')
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Le perimetre : ce bien, ce compte, ces statuts — et rien d autre
// ════════════════════════════════════════════════════════════════════════════

test('⚠ le perimetre est le BIEN, le COMPTE et le statut « a valider »', async () => {
  const b = banc({ taches: [
    tache({ id: 'a' }),                                   // la cible
    tache({ id: 'b', property_id: AUTRE_REF }),           // un autre bien
    tache({ id: 'c', user_id: AUTRE_COMPTE }),            // un autre compte
    tache({ id: 'd', status: 'sending' }),                // prise par le cron
    tache({ id: 'e', status: 'done' }),                   // deja partie
    tache({ id: 'f', status: 'ignored' })                 // abandonnee
  ] })
  const r = await lancer(b, MANUEL)
  assert.equal(r.desarmes, 1, 'une seule tache touchee')
  assert.deepEqual(b.etat.updates.map(u => u.id), ['a'])
  for (const id of ['b', 'c', 'd', 'e', 'f']) {
    assert.notEqual(par(b, id).send_after, null, `${id} est intacte`)
  }
  // Le filtre de compte est explicite dans la requete, pas un effet de bord.
  assert.equal(b.etat.lectures[0].eq.user_id, COMPTE)
  assert.equal(b.etat.lectures[0].eq.property_id, REF)
  assert.equal(b.etat.lectures[0].eq.status, 'pending_validation')
})

test('⚠ une tache prise par le cron ENTRE la lecture et l ecriture n est pas ressuscitee', async () => {
  // La course est reelle : le cron claime en `sending` pendant qu on boucle.
  const b = banc({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
  const vraiFrom = b.client.from.bind(b.client)
  let lu = false
  b.client.from = (table) => {
    const q = vraiFrom(table)
    const vraiThen = q.then.bind(q)
    q.then = (res, rej) => {
      if (!lu) { lu = true; return vraiThen(res, rej) }
      // apres la lecture, le cron prend `a`
      const a = b.etat.taches.find(t => t.id === 'a')
      if (a && a.status === 'pending_validation') a.status = 'sending'
      return vraiThen(res, rej)
    }
    return q
  }
  const r = await lancer(b, MANUEL)
  assert.equal(r.desarmes, 1, 'seule `b` a ete desarmee')
  // ⚠ UN COMPTEUR SEPARE, ET C'EST UN CONSTAT DE REVUE. La premiere version de
  // ce test figeait `inchanges: 1` : il rangeait sous le meme nombre deux faits
  // opposes — « il n'y avait rien a faire » et « le cron m'a pris la tache sous
  // le nez ». Le second veut dire qu'un message PART peut-etre, avec le reglage
  // d'AVANT : le cron lit la config une fois par lot, hors de sa boucle, donc
  // `encoreLegitime` peut relire un blob perime pendant une vingtaine de
  // secondes. L'hote qui vient de demander « plus rien sans ma validation »
  // doit l'apprendre, pas lire « Enregistre ».
  assert.equal(r.deja_prises, 1, '`a` est comptee DEJA PRISE, pas inchangee')
  assert.equal(r.inchanges, 0, 'et le compteur du « rien a faire » reste a zero')
  assert.equal(par(b, 'a').status, 'sending')
  assert.notEqual(par(b, 'a').send_after, null, 'la tache claimee garde son echeance')
})

// ════════════════════════════════════════════════════════════════════════════
// Les pannes et les bornes : jamais un faux « c est fait »
// ════════════════════════════════════════════════════════════════════════════

test('⚠ une panne de LECTURE ne vaut pas « aucun brouillon »', async () => {
  const b = banc({ taches: [tache()], panneLecture: true })
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'lecture_impossible')
  assert.equal(r.erreur, 'panne lecture')
  assert.equal(r.desarmes, 0)
})

test('⚠ une panne d ECRITURE se dit, et le bilan partiel est rendu', async () => {
  const b = banc({ taches: [tache({ id: 'a' })], panneEcriture: true })
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'ecriture_impossible')
  assert.equal(r.erreur, 'panne ecriture')
  assert.notEqual(par(b, 'a').send_after, null, 'rien n a change en base')
})

test('⚠ une `data` qui n est pas un TABLEAU se refuse : c est une forme impossible', async () => {
  // Constat 8 de la revue, MESURE : `data || []` lisait `undefined` comme
  // « aucune ligne » et rendait `ok: true`. PostgREST rend TOUJOURS un tableau
  // sur un select — donc cette forme ne vient pas du vrai client, elle vient
  // d'un double. Et elle a rendu VERT, sur toute la suite, la mutation de la
  // reference du bien ou du compte passes par l'endpoint. Sur le chemin de
  // l'envoi au voyageur.
  for (const forme of [undefined, null, {}, 'des lignes', 0]) {
    const client = { from: () => {
      const q = { select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q,
        update: () => q, then: (ok) => Promise.resolve({ data: forme, error: null }).then(ok) }
      return q
    } }
    const r = await appliquerDelaiAuxBrouillons(client, {
      userId: COMPTE, propertyRef: REF, delais: MANUEL, maintenant: T0
    })
    assert.equal(r.ok, false, `forme ${JSON.stringify(forme)}`)
    assert.equal(r.motif, 'lecture_illisible')
    assert.equal(r.desarmes, 0)
  }
  // Un tableau VIDE, lui, est une reponse legitime : aucun brouillon.
  const vide = { from: () => {
    const q = { select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q,
      update: () => q, then: (ok) => Promise.resolve({ data: [], error: null }).then(ok) }
    return q
  } }
  const r = await appliquerDelaiAuxBrouillons(vide, {
    userId: COMPTE, propertyRef: REF, delais: MANUEL, maintenant: T0
  })
  assert.equal(r.ok, true)
  assert.equal(r.desarmes, 0)
})

test('⚠ l APERCU compte sans rien ecrire, et il compte ce qui PARTIRA', async () => {
  // Constat 1 de la revue : sous « Je valide chaque reponse » les brouillons
  // s'accumulent sans echeance. En sortir les rearme a `created_at + N`, donc
  // tout ce qui a plus de N d'age part dans les cinq minutes. Le nombre doit
  // etre connu AVANT le geste.
  const b = banc({ taches: [
    tache({ id: 'a', created_at: '2026-11-11T09:00:00Z', send_after: null }),  // +60 min -> 10 h, echu
    tache({ id: 'b', created_at: '2026-11-11T10:50:00Z', send_after: null }),  // +60 min -> 11 h 50, a venir
    tache({ id: 'c', created_at: '2026-11-11T08:00:00Z', send_after: null })   // +60 min -> 9 h, echu
  ] })
  const r = await lancer(b, DANS_60, { apercu: true })
  assert.equal(r.ok, true)
  assert.equal(r.rearmes, 3, 'les trois bougeraient')
  assert.equal(r.echues, 2, 'et DEUX partiraient au prochain passage')
  assert.equal(b.etat.updates.length, 0, 'un apercu n ecrit RIEN')
  for (const id of ['a', 'b', 'c']) {
    assert.equal(par(b, id).send_after, null, `${id} est intacte`)
  }
  // Le meme banc, sans apercu : les ecritures partent, et le compte est le meme.
  const b2 = banc({ taches: [
    tache({ id: 'a', created_at: '2026-11-11T09:00:00Z', send_after: null }),
    tache({ id: 'b', created_at: '2026-11-11T10:50:00Z', send_after: null }),
    tache({ id: 'c', created_at: '2026-11-11T08:00:00Z', send_after: null })
  ] })
  const r2 = await lancer(b2, DANS_60)
  assert.equal(r2.rearmes, 3)
  assert.equal(r2.echues, 2, 'l apercu et le vrai geste comptent pareil')
  assert.equal(b2.etat.updates.length, 3)
})

test('desarmer ne compte aucune echeance : rien ne part', async () => {
  const b = banc({ taches: [tache({ id: 'a' }), tache({ id: 'b' })] })
  const r = await lancer(b, MANUEL)
  assert.equal(r.echues, 0, 'la validation manuelle ne fait partir personne')
})

test('⚠ au rearmement d une tache SUSPENDUE, `updated_at` n est pas touche', async () => {
  // Constat 3 de la revue. `reprendreSuspensionsDormantes` lit `updated_at`
  // comme une mesure d INACTIVITE DE L HOTE SUR CE BROUILLON — son parachute de
  // 30 minutes, decision 4 de Thierry. Or enregistrer le panneau est un geste
  // sur le BIEN : le reecrire repoussait le parachute de 30 min a chaque
  // sauvegarde, et rendait `send_after - suspendu_le` arbitraire.
  const vieux = new Date(T0 - 20 * MINUTE).toISOString()
  const b = banc({ taches: [
    tache({ id: 'sus', suspendu_le: new Date(T0 - 25 * MINUTE).toISOString(), updated_at: vieux }),
    tache({ id: 'libre', updated_at: vieux })
  ] })
  const r = await lancer(b, DANS_60)
  assert.equal(r.rearmes, 2)
  assert.equal(par(b, 'sus').updated_at, vieux,
    'le parachute de la tache suspendue n est pas repousse')
  assert.equal(par(b, 'libre').updated_at, new Date(T0).toISOString(),
    'mais une tache non suspendue est bien horodatee')
  // Au DESARMEMENT, `suspendu_le` tombe, donc le parachute n a plus d objet :
  // l horodatage reprend ses droits.
  const b2 = banc({ taches: [
    tache({ id: 'sus', suspendu_le: new Date(T0 - 25 * MINUTE).toISOString(), updated_at: vieux })
  ] })
  await lancer(b2, MANUEL)
  assert.equal(par(b2, 'sus').suspendu_le, null)
  assert.equal(par(b2, 'sus').updated_at, new Date(T0).toISOString())
})

test('un appel incomplet refuse au lieu de ne rien faire en silence', async () => {
  const b = banc({ taches: [tache()] })
  for (const manque of [
    { userId: null }, { propertyRef: '' }, { propertyRef: null }, { maintenant: NaN }
  ]) {
    const r = await appliquerDelaiAuxBrouillons(b.client, {
      userId: COMPTE, propertyRef: REF, delais: MANUEL, maintenant: T0, ...manque
    })
    assert.equal(r.ok, false, JSON.stringify(manque))
    assert.equal(r.motif, 'appel_incomplet')
  }
  const sansClient = await appliquerDelaiAuxBrouillons(null, {
    userId: COMPTE, propertyRef: REF, delais: MANUEL, maintenant: T0
  })
  assert.equal(sansClient.motif, 'appel_incomplet')
  assert.equal(b.etat.updates.length, 0)
})

test('⚠ au-dela de 1000 lignes : le curseur avance, et rien n est tronque en silence', async () => {
  // PostgREST rend 1000 lignes SANS erreur. On en met plus d une page et on
  // verifie que la seconde lecture repart APRES la derniere lue.
  const n = PAGE + 120
  const taches = Array.from({ length: n }, (_, i) =>
    tache({ id: 't' + String(i).padStart(5, '0') }))
  const b = banc({ taches })
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, true)
  assert.equal(r.desarmes, n, 'TOUS les brouillons sont desarmes')
  assert.equal(b.etat.lectures.length, 2, 'deux pages, pas une')
  assert.equal(b.etat.lectures[0].gt.id, undefined, 'la premiere page n a pas de curseur')
  assert.equal(b.etat.lectures[1].gt.id, 't00499', 'la seconde repart apres la derniere lue')
  assert.equal(b.etat.taches.filter(t => t.send_after !== null).length, 0)
})

test('⚠ et si meme la pagination ne suffit pas, ca se DIT au lieu de se tronquer', async () => {
  // On simule une base qui rend toujours une page pleine : le curseur ne peut
  // pas progresser, donc la boucle doit s arreter en l annoncant.
  const b = banc({ taches: [tache({ id: 'a' })] })
  const vraiFrom = b.client.from.bind(b.client)
  let lectures = 0
  b.client.from = (table) => {
    const q = vraiFrom(table)
    const vraiThen = q.then.bind(q)
    let estUpdate = false
    const vraiUpdate = q.update.bind(q)
    q.update = (p) => { estUpdate = true; return vraiUpdate(p) }
    q.then = (res, rej) => {
      if (estUpdate) return vraiThen(res, rej)
      lectures++
      const page = Array.from({ length: PAGE }, (_, i) => ({
        id: 'p' + lectures + '-' + i, created_at: NE_A,
        send_after: new Date(T0 + 45 * MINUTE).toISOString(), suspendu_le: null
      }))
      return Promise.resolve({ data: page, error: null }).then(res, rej)
    }
    return q
  }
  const r = await lancer(b, MANUEL)
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'trop_de_brouillons')
  assert.equal(lectures, MAX_PAGES, 'la boucle est bornee, elle ne tourne pas sans fin')
})

// ════════════════════════════════════════════════════════════════════════════
// Le contrat : un blob hors contrat ne gouverne pas
// ════════════════════════════════════════════════════════════════════════════

test('⚠ un reglage HORS CONTRAT retombe sur le binaire, il n invente pas de delai', async () => {
  // Le blob est un JSONB qu aucune contrainte de base ne borne : c est la raison
  // d etre de `delaiDeReponse`, et ce module passe par lui plutot que de lire
  // `reponse_ia` a la main.
  for (const horsContrat of [
    { reponse_ia: 'quinze' }, { reponse_ia: 12.5 }, { reponse_ia: -3 },
    { reponse_ia: 5000 }, { alerte_info: 0 }, null, 'pas-un-objet'
  ]) {
    const b = banc({ taches: [tache({ id: 'a' })] })
    const r = await lancer(b, horsContrat)
    assert.equal(r.ok, true, JSON.stringify(horsContrat))
    assert.equal(r.desarmes, 1, `${JSON.stringify(horsContrat)} desarme (repli validation manuelle)`)
    assert.equal(par(b, 'a').send_after, null)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Le cablage : l endpoint appelle ce writer, et l ecran dit ce qu il rend
// ════════════════════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const sansComm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

test('⚠ /api/agent-config appelle le writer APRES l upsert, et jamais pour une autre cible', async () => {
  const src = sansComm(lire('api/agent-config.js'))
  assert.ok(/require\('\.\.\/lib\/guestflow\/appliquer-delai'\)/.test(src),
    'l endpoint passe par le writer unique, il n ecrit pas agent_tasks lui-meme')
  // Un endpoint de REGLAGES qui ecrirait les taches en ligne serait un
  // quatrieme ecrivain de `send_after`.
  assert.ok(!/from\('agent_tasks'\)/.test(src),
    'api/agent-config.js ne touche jamais agent_tasks directement')
  // ⚠ DES ANCRES EXPLICITES, PARCE QUE LE FICHIER PORTE DEUX APPELS AU WRITER
  // (l apercu, puis la propagation) et quatre `.from('agent_alert_config')`
  // (dont le GET, tout en haut). Ma premiere version prenait le PREMIER de
  // chaque, donc elle mesurait l apercu contre le GET : un ordre juste par
  // accident, et un faux rouge des que l apercu est arrive.
  const iUpsert = src.indexOf('const { error: eW } = await supabase')
  const iAppel = src.indexOf('brouillons = await appliquerDelaiAuxBrouillons(supabase')
  const iApercu = src.indexOf('apercu = await appliquerDelaiAuxBrouillons(supabase')
  assert.ok(iUpsert > 0 && iAppel > 0 && iApercu > 0, 'les trois reperes existent')
  assert.ok(iAppel > iUpsert,
    'le reglage est enregistre AVANT d etre propage : sinon il n y a rien a propager')
  // ⚠ CES ASSERTIONS DE FORME NE SUFFISENT PAS, ET LA REVUE L A MESURE : muter
  // `propertyRef: ref` ou `userId` restait vert. Ce qui le ferme vraiment, ce
  // sont les tests qui EXECUTENT l'endpoint et regardent les taches, dans
  // `tests/delai-reponse-ia-lot1.test.js` (section « L'ENDPOINT PROPAGE »). Ici
  // on ne garde que ce qu'une execution ne montre pas : la PLACE de l'appel.
  assert.ok(/cible === 'delais'/.test(src.slice(iAppel - 400, iAppel)),
    'uniquement sur la cible delais')
  // Le 500 de l'upsert est AVANT l'appel ; ce qu'on verifie, c'est qu'il n'en
  // apparait pas un APRES, entre la propagation et le 200.
  const i200 = src.indexOf('delais_ref: ref, delais: delaisValides')
  assert.ok(i200 > iAppel, 'la reponse vient apres la propagation')
  assert.ok(!/status\(500\)/.test(src.slice(iAppel, i200)),
    'une propagation en echec ne fait pas mentir le 200 du reglage')
  assert.ok(/brouillons\b/.test(src.slice(i200)), 'le bilan redescend a l ecran')
  // Et l apercu est en LECTURE SEULE : il repond AVANT l upsert du blob.
  assert.ok(iApercu < iUpsert, 'l apercu repond avant l upsert, donc il n ecrit rien')
  assert.ok(/apercu === true/.test(src), 'et il faut le demander explicitement')
  // ⚠ UN APERCU EN ECHEC BLOQUE LA PROPAGATION, DONC IL LAISSE UNE TRACE COTE
  // SERVEUR (constat 3). `logger.error` de l ecran n ecrit que la console du
  // NAVIGATEUR : les motifs qui bloquent n existaient dans aucun log Vercel.
  assert.ok(/\[agent-config\] delais -> apercu:/.test(src),
    'l echec de l apercu est journalise cote serveur')
  assert.ok(/\[agent-config\] delais -> brouillons:/.test(src),
    'comme celui du chemin reel')
  // Et la propagation peut etre refusee sans perdre le blob.
  assert.ok(/\.propager === false/.test(src), 'le drapeau de propagation est lu')
  const iPropag = src.indexOf('.propager === false')
  assert.ok(iPropag > iUpsert,
    'le refus de propager saute la reprise, PAS l enregistrement du blob')
  // Il sort par un `return`, il ne retombe pas dans le chemin d ecriture.
  assert.ok(/return res\.status\(200\)\.json\(\{ ok: true, delais_ref: ref, apercu \}\)/.test(src),
    'l apercu rend sa reponse et s arrete la')
})

test('⚠ l ecran DIT quand les propositions en attente n ont pas suivi', async () => {
  const page = sansComm(lire('pages/messages.html'))
  assert.ok(/b\.ok !== true/.test(page) || /!b \|\| b\.ok !== true/.test(page),
    'l ecran lit le bilan au lieu de supposer qu il est bon')
  assert.ok(/echoues\.push\(t\('messages\.partie_brouillons'\)\)/.test(page),
    'et il en fait une PARTIE non enregistree, distincte des delais')
  // ⚠ LE NOMBRE AVANT LE GESTE (constat 1) : l ecran demande l apercu, et sans
  // lui il N ENREGISTRE PAS — ne pas savoir combien partiraient n autorise pas
  // a le faire (discipline de 4.6.6).
  assert.ok(/apercu: true/.test(page), 'l ecran demande l apercu avant d enregistrer')
  assert.ok(/messages\.delai_arriere_confirm/.test(page), 'et il annonce le NOMBRE')
  // ⚠ REFUSER NE COUTE PAS LE RESTE DU PANNEAU (constat 2 de la derniere
  // revue). `delais` porte TROIS reglages : un refus doit enregistrer la
  // sourdine et l echeance d alerte, et seulement SAUTER la propagation.
  const iProp = page.indexOf('let propager = true')
  assert.ok(iProp > 0, 'le drapeau de propagation existe')
  const bloc = page.slice(iProp, page.indexOf('const r = await appel', iProp))
  assert.equal((bloc.match(/propager = false/g) || []).length, 3,
    'trois raisons de ne pas propager : reponse illisible, apercu en echec, refus de l hote')
  assert.ok(!/feuVert/.test(page),
    'et plus aucun chemin ne saute l enregistrement entier')
  assert.ok(/delais: chargeDelais, propager \}/.test(page),
    'le POST part toujours, avec son drapeau')
  // Sur un bien qu on SAIT en pause, aucune question : rien ne peut partir.
  assert.ok(/const enPauseSure = pausesFiables\(\) && etat\.pauses\[String\(ref\)\] === true/
    .test(page), 'un bien connu en pause ne declenche pas la question')
  assert.ok(/reponse_ia !== null && !enPauseSure/.test(page),
    'et la question ne se pose que si un envoi est possible')
  // ⚠ UN MARQUEUR POSITIF, PAS UNE ABSENCE (constat 5) : `appel()` rend `{}` sur
  // tout 200 non-JSON, et ce cas passait pour « endpoint plus ancien », donc
  // feu vert sans garde-fou.
  assert.ok(/'apercu' in a/.test(page), 'la presence du champ est testee, pas sa valeur')
  assert.ok(/a\.delais_ref === ref/.test(page),
    'et un endpoint plus ancien se reconnait a sa propre reponse, pas a un silence')
  // Et `deja_prises` se dit : c est le seul cas ou un message peut partir avec
  // le reglage d avant.
  assert.ok(/messages\.partie_deja_prises/.test(page),
    'une tache deja prise par l envoi est annoncee a l hote')
  // Un bilan ABSENT compte comme un echec : un endpoint plus vieux que l ecran
  // ne doit pas faire croire que les brouillons ont suivi.
  const i = page.indexOf('const b = r && r.brouillons')
  assert.ok(i > 0, 'le bilan est lu depuis la reponse')
  assert.ok(/!b \|\|/.test(page.slice(i, i + 200)), 'bilan absent = echec, pas succes')
  // Et le fil se relit quand des echeances ont bouge, sinon il garde a l ecran
  // le compte a rebours d avant.
  assert.ok(/if \(brouillonsRepris > 0\) \{\s*try \{\s*await rechargerTaches\(\)/.test(page),
    'le fil relit les taches quand des echeances ont change, dans son propre try')
  // ⚠ ET LE VERROU SE REND APRES (constat 8) : un lever dans `renderFil`
  // sautait `renderTiroir()` et `noteReglage()`, donc la note disparaissait et
  // le panneau restait FIGE — `geler` ne se defait que par un re-rendu.
  const iRech = page.indexOf('if (brouillonsRepris > 0)')
  const iVerrou = page.indexOf('etat.modeEnCours = false', iRech)
  assert.ok(iVerrou > iRech, 'modeEnCours ne tombe qu apres le rechargement')
  const iNote = page.indexOf('noteReglage(', iVerrou)
  assert.ok(iNote > iVerrou, 'mais avant le re-rendu et la note')
  assert.ok(page.indexOf('renderTiroir()', iVerrou) < iNote,
    'et le re-rendu precede la note : `geler` ne se defait que par un re-rendu')
  // ⚠ ET LE SECOND DRAPEAU TOMBE AVEC LE PREMIER (recette du 28 octobre 2026).
  // `panneauEnCours` gele ce qui n edite que `etat.delaisEdit` ; `modeEnCours`
  // garde ce qui ecrit. S ils divergeaient, le panneau resterait desarme apres
  // un enregistrement — exactement le defaut que ce lot ferme, a l envers.
  // ⚠ L INVARIANT SE MESURE DANS LES DEUX SENS, ET C ETAIT LE CONSTAT 4 DE LA
  // REVUE : ma premiere version ecrivait `A - B < 60` au lieu de
  // `Math.abs(A - B) < 60`, donc toute pose PLUS HAUT dans le fichier passait.
  // La revue l a mesure en deplacant la pose AVANT le `if (etat.modeEnCours)
  // return` : un appel reentrant sortait par ce return et laissait le drapeau
  // colle a vrai — pilules, sourdine et « Je valide chaque reponse » desarmes
  // pour le reste de la session — et 80 tests restaient verts.
  const poses = [...page.matchAll(/etat\.panneauEnCours = (true|false)/g)].map(m => m[1])
  assert.equal(poses.filter(x => x === 'true').length, 1,
    'panneauEnCours se pose une seule fois')
  // Deux retraits : celui du corps (chemin heureux) et celui du filet
  // `try/finally` de l enveloppe (constat 5). Chacun doit etre COLLE a un
  // retrait de modeEnCours, sinon les deux drapeaux divergent.
  assert.ok(poses.filter(x => x === 'false').length >= 1, 'et il se retire')
  const voisin = (motif, cible) => {
    for (const m of page.matchAll(motif)) {
      const proches = [...page.matchAll(cible)].some(c => Math.abs(c.index - m.index) < 80)
      if (!proches) return false
    }
    return true
  }
  assert.ok(voisin(/etat\.panneauEnCours = true/g, /etat\.modeEnCours = true/g),
    'chaque pose de panneauEnCours est collee a une pose de modeEnCours')
  assert.ok(voisin(/etat\.panneauEnCours = false/g, /etat\.modeEnCours = false/g),
    'chaque retrait de panneauEnCours est colle a un retrait de modeEnCours')
  // Et la pose vient APRES la garde de reentrance : posee avant, un appel
  // reentrant sortirait par le `return` en laissant le drapeau colle.
  const iEnv = page.indexOf('async function enregistrerPanneau (corps, ref) {')
  assert.ok(iEnv > 0)
  // ⚠ L'ANCRE SUIT LE CODE : la garde ne fait plus un `return` nu, elle POSE UNE
  // NOTE avant de sortir (recette du 29 octobre 2026 : un geste qui ne fait
  // rien doit le dire).
  const iGarde = page.indexOf('if (etat.modeEnCours) {', iEnv)
  assert.ok(iGarde > iEnv && page.indexOf('etat.panneauEnCours = true', iEnv) > iGarde,
    'la pose suit la garde de reentrance')
  // ⚠ ET LE FILET EXISTE (constat 5) : un lever n importe ou doit rendre les
  // deux drapeaux. Mesure du comportement : tests/messages-panneau-ia-dom.test.js.
  assert.match(page.slice(iEnv, iGarde + 1200), /\} finally \{/,
    'l enveloppe tient les drapeaux par un finally, pas par le chemin heureux')
  for (const f of ['fr', 'en', 'es']) {
    const dict = JSON.parse(lire(`shared/i18n/${f}.json`))
    const phrase = dict['messages.partie_brouillons']
    assert.ok(typeof phrase === 'string' && phrase.trim().length > 5, `${f} traduit la partie`)
    assert.ok(!/\{/.test(phrase), `${f} : aucun parametre`)
    // Les deux phrases a NOMBRE doivent porter leur `{n}` dans les trois
    // langues : une traduction qui le perd annoncerait un geste de masse sans
    // dire combien.
    for (const cle of ['messages.delai_arriere_confirm', 'messages.partie_deja_prises']) {
      assert.ok(typeof dict[cle] === 'string' && dict[cle].includes('{n}'),
        `${f} : ${cle} porte son nombre`)
    }
  }
})

// ── La recette du 29 octobre 2026 : une suspension DIFFERE un depart ───────

// Une proposition vieille de 22 h, SUSPENDUE : la FORME de celle lue en base
// staging au diagnostic, pas son etat exact — l'echeance y est volontairement
// decalee, voir le ⚠ ci-dessous. L'etat exact, lui, a son propre test
// (« deja a la bonne echeance ET deja echue »). Dates relatives a T0, qui est
// INJECTE — donc figees, selon la regle du depot.
// ⚠ `send_after` NE DOIT PAS EGALER `created_at + 60 min`, sinon le module rend
// `inchanges` et n'ecrit RIEN : mon premier jet posait exactement l'echeance
// recalculee, donc le test « un seul update » mesurait un no-op. Meme piege que
// celui note sur `tache()` plus haut — une fixture qui rend le resultat attendu
// par hasard ne mesure rien.
const SUSPENDUE_VIEILLE = {
  id: 'tache-suspendue',
  created_at: new Date(T0 - 22 * 60 * MINUTE).toISOString(),
  send_after: new Date(T0 - 20 * 60 * MINUTE).toISOString(),
  suspendu_le: new Date(T0 - 21 * 60 * MINUTE).toISOString(),
  updated_at: new Date(T0 - 21 * 60 * MINUTE).toISOString()
}

test('LE TEST QUI COMPTE : une tache SUSPENDUE et echue compte dans `echues`', async () => {
  // ⚠ DECISION DE THIERRY EN RECETTE DU 29 OCTOBRE 2026 : « une proposition qui
  // finira par partir seule compte, suspendue ou non ». Mon exclusion des
  // suspendues etait fausse, et elle a coute le defaut exact de la recette : une
  // proposition vieille de 22 h, suspendue, INVISIBLE du compteur — donc
  // « Enregistré » sans un mot — alors que `reprendreSuspensionsDormantes`
  // allait effacer sa suspension et la poster au voyageur.
  //
  // La suspension n'est pas un filtre, c'est un DELAI : la reprise est
  // AUTOMATIQUE (30 min sans geste de l'hote, a chaque passage) et repose
  // l'echeance au plancher de 5 min. C'est litteralement le « Envoyer dans
  // 5 min » que Thierry a lu a l'ecran.
  const b = banc({ taches: [tache(SUSPENDUE_VIEILLE)] })
  const bilan = await lancer(b, DANS_60, { apercu: true })
  assert.equal(bilan.ok, true, bilan.motif)
  assert.equal(bilan.echues, 1,
    'une suspendue dont l echeance recalculee est passee partira seule : elle compte')
})

test('LE TEST QUI COMPTE : deja a la bonne echeance ET deja echue compte quand meme', async () => {
  // ⚠ C'EST L'ETAT EXACT DE LA RECETTE DU 29 OCTOBRE, et AUCUN test ne le
  // couvrait — constat 5 de la revue, qui l'a mesure : deplacer `echues++`
  // APRES le `if (t.send_after === nouvelle) { inchanges++; continue }` laissait
  // les 28 tests verts.
  //
  // En base : `send_after` = 12:07 = `created_at + 60 min`, et le delai choisi
  // est 60 min. Donc `nouvelle === send_after` : le module n'a RIEN a reecrire,
  // il rend `inchanges` — et il doit compter la tache quand meme, parce qu'elle
  // partira seule. Le compteur est evalue AVANT le `continue`, et c'est cet
  // ordre que ce test garde.
  const b = banc({
    taches: [tache({
      id: 'tache-recette',
      created_at: new Date(T0 - 22 * 60 * MINUTE).toISOString(),
      send_after: new Date(T0 - 21 * 60 * MINUTE).toISOString(),   // = created_at + 60 min
      suspendu_le: new Date(T0 - 30 * MINUTE).toISOString()
    })]
  })
  const r = await lancer(b, DANS_60, { apercu: true })
  assert.equal(r.ok, true, r.motif)
  assert.equal(r.inchanges, 1, 'rien a reecrire : l echeance est deja la bonne')
  assert.equal(r.echues, 1, 'et elle partira seule : elle compte')
})

test('une suspendue dont l echeance recalculee est A VENIR ne compte pas', async () => {
  // La borne de l'autre cote : ce qui compte, c'est que l'echeance SOIT passee,
  // pas que la tache soit suspendue. Sans ce test, poser `echues++` sans
  // condition passerait au vert.
  // ⚠ `send_after` NE VAUT PAS `created_at + 60 min` : a T0+50 min il tombait
  // pile dessus, donc le module rendait `inchanges` et le chemin d'ecriture
  // n'etait jamais exerce (constat 5 de la revue — le piege que le voisin
  // documente, dans lequel ce test tombait a son tour).
  const b = banc({
    taches: [tache({
      id: 'tache-suspendue-recente',
      created_at: new Date(T0 - 10 * MINUTE).toISOString(),
      send_after: new Date(T0 + 20 * MINUTE).toISOString(),
      suspendu_le: new Date(T0 - 5 * MINUTE).toISOString()
    })]
  })
  const bilan = await lancer(b, DANS_60, { apercu: true })
  assert.equal(bilan.ok, true, bilan.motif)
  assert.equal(bilan.echues, 0, 'creation + 60 min est encore a venir')
  assert.equal(bilan.rearmes, 1, 'et le chemin de rearmement est bien exerce')
})

test('et la suspension n est toujours PAS effacee par ce writer', async () => {
  // La contrepartie, et elle ne bouge pas : COMPTER n'est pas ARMER. Effacer
  // `suspendu_le` ici armerait un compte a rebours sur un texte que l'hote est
  // en train d'ecrire, et le message pourrait partir sous ses doigts.
  const b = banc({ taches: [tache(SUSPENDUE_VIEILLE)] })
  await lancer(b, DANS_60)
  assert.equal(b.etat.updates.length, 1, 'un seul update')
  const patch = b.etat.updates[0].patch
  assert.ok(!('suspendu_le' in patch), 'le writer ne touche pas a suspendu_le au rearmement')
  assert.ok(!('updated_at' in patch),
    'ni a updated_at sur une suspendue : c est le parachute de 30 min de l hote')
  assert.equal(par(b, 'tache-suspendue').suspendu_le, SUSPENDUE_VIEILLE.suspendu_le,
    'elle reste suspendue en base')
})
