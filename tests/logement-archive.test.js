// tests/logement-archive.test.js — ARCHIVER UN BIEN.
//
// Lot « archiver un bien », etapes 0 a 4. Go de Thierry du 31 octobre 2026,
// avec ses deux decisions : les revenus d'un bien archive restent COMPTES (sa
// ligne est marquee « archive »), et la facturation s'arrete a la date
// d'archivage — `active_at` n'est PAS remis a `null`, on ajoute une FIN.
//
// ⚠ LE DOUBLE REFUSE CE QUE LE VRAI REFUSE. C'est la lecon payee deux fois dans
// ce depot : un double plus permissif VALIDE du code qui ne peut pas tourner, et
// la mutation ne le voit pas puisqu'elle tourne contre le meme double. Celui-ci
// leve sur une methode qu'il ne connait pas, et il EXIGE le cloisonnement :
// toute ecriture sans `user_id` leve, comme la RLS le ferait.

const test = require('node:test')
const assert = require('node:assert/strict')
const A = require('../lib/logement/archive.js')

const T = '2026-10-31T10:00:00.000Z'

// ─── Le double ─────────────────────────────────────────────────────────────

function banc (etat = {}) {
  const base = {
    properties: etat.properties || [],
    agent_tasks: etat.agent_tasks || [],
    cron_logs: etat.cron_logs || []
  }
  const journal = []
  const pannes = etat.pannes || {}

  const client = {
    from (table) {
      if (!(table in base)) throw new Error(`double : table inconnue « ${table} »`)
      const ctx = { table, filtres: [], op: null, champs: null, colonnes: null }
      const appliquer = () => base[table].filter(l => ctx.filtres.every(f => f(l)))
      const chaine = {
        select (cols) { ctx.colonnes = cols; if (ctx.op === null) ctx.op = 'select'; return chaine },
        eq (col, val) { ctx.filtres.push(l => String(l[col]) === String(val)); ctx.vus = (ctx.vus || []).concat(col); return chaine },
        in (col, vals) { ctx.filtres.push(l => vals.map(String).includes(String(l[col]))); return chaine },
        update (champs) { ctx.op = 'update'; ctx.champs = champs; return chaine },
        delete () { ctx.op = 'delete'; return chaine },
        async maybeSingle () {
          if (pannes[table + ':select']) return { data: null, error: { message: pannes[table + ':select'] } }
          const r = appliquer()
          if (r.length > 1) throw new Error(`double : maybeSingle sur ${r.length} lignes`)
          // ⚠ LE DOUBLE REND LES COLONNES DEMANDEES, PAS TOUTE LA LIGNE. Sans
          // cela, un `select` qui OMET une colonne dont le code juge ensuite
          // passerait ici et echouerait en production : c'est la « garde
          // ouverte » que ce depot nomme explicitement.
          const l = r[0]
          if (!l) return { data: null, error: null }
          const voulues = String(ctx.colonnes || '').split(',').map(s => s.trim()).filter(Boolean)
          const sortie = {}
          for (const c of voulues) sortie[c] = l[c]
          return { data: sortie, error: null }
        },
        then (resoudre) { return chaine.executer().then(resoudre) },
        async executer () {
          const quoi = ctx.table + ':' + ctx.op
          if (pannes[quoi]) return { data: null, error: { message: pannes[quoi] } }
          // ⚠ TOUTE ECRITURE EST CLOISONNEE. La cle de service contourne la
          // RLS par conception : c'est au code de filtrer, et c'est donc au
          // double de l'exiger. Sans ce refus, une ecriture qui oublierait
          // `user_id` toucherait les biens d'un autre compte et resterait verte.
          if ((ctx.op === 'update' || ctx.op === 'delete') && ctx.table !== 'cron_logs') {
            if (!(ctx.vus || []).includes('user_id')) {
              throw new Error(`double : ${quoi} sans filtre user_id — la RLS le refuserait`)
            }
          }
          const touchees = appliquer()
          if (ctx.op === 'update') {
            for (const l of touchees) Object.assign(l, ctx.champs)
            journal.push({ op: 'update', table: ctx.table, n: touchees.length, champs: ctx.champs })
          } else if (ctx.op === 'delete') {
            base[ctx.table] = base[ctx.table].filter(l => !touchees.includes(l))
            journal.push({ op: 'delete', table: ctx.table, n: touchees.length })
          }
          return { data: touchees.map(l => ({ id: l.id })), error: null }
        }
      }
      return chaine
    }
  }
  return { client, base, journal }
}

const unBien = (o = {}) => ({
  id: 'uuid-bien', user_id: 'compte-1', name: 'Colomiers',
  provider_property_id: 'cle-channex', active_at: '2026-07-19T00:00:00Z',
  archive_le: null, archive_par: null, archive_motif: null, facturable_jusqu_au: null, ...o
})

// ─── Les tests ─────────────────────────────────────────────────────────────

test("LE TEST QUI COMPTE : `active_at` n est JAMAIS efface, une FIN est posee", async () => {
  // ⚠ LA DECISION DE THIERRY, ET LA RAISON TECHNIQUE QUI LA SOUTIENT. C'est ce
  // que fait `transferer_bien` (`active_at = null`), et ca EFFACE le fait que
  // le bien a ete actif : le trial du compte demarre au PREMIER `active_at`,
  // donc l'effacer reecrit une date de debut de periode d'essai.
  const b = banc({ properties: [unBien()] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', parQui: 'moi', maintenant: T })
  assert.strictEqual(r.ok, true, `archivage refuse : ${JSON.stringify(r)}`)
  const bien = b.base.properties[0]
  assert.strictEqual(bien.active_at, '2026-07-19T00:00:00Z',
    '`active_at` a ete touche : l historique de facturation est reecrit')
  assert.strictEqual(bien.facturable_jusqu_au, T, 'la fin de facturation n est pas posee')
  assert.strictEqual(r.facturation_arretee_le, T, 'le compte rendu ne dit pas la fin de facturation')
  assert.strictEqual(r.etait_facture, true, 'le compte rendu ne dit pas que le bien etait facture')
})

test("LE TEST QUI COMPTE : un bien JAMAIS facture ne recoit pas de fin de facturation", async () => {
  // `active_at = null` est le cas des deux premiers biens reels (mesure du
  // 30 octobre 2026). Poser une fin sur un bien jamais actif inventerait une
  // periode de facturation qui n'a pas existe.
  const b = banc({ properties: [unBien({ active_at: null })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(b.base.properties[0].facturable_jusqu_au, null,
    'une fin de facturation est posee sur un bien qui n a jamais ete facture')
  assert.strictEqual(r.etait_facture, false)
  assert.strictEqual(r.facturation_arretee_le, null)
})

test("LE TEST QUI COMPTE : l archivage ETEINT le pilote tarifaire", async () => {
  // ⚠ DECISION DE THIERRY DU 1er NOVEMBRE 2026, LES DEUX COTES. Sans cela,
  // YieldFlow continuerait de pousser des prix chez le provider pour une
  // annonce retiree. Le filtre de `scripts/piloter-yieldflow.js` est la seconde
  // ligne de defense ; celle-ci dit l'INTENTION dans la donnee.
  const b = banc({ properties: [unBien({ pilote_tarifaire: 'yieldflow' })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(b.base.properties[0].pilote_tarifaire, 'calendrier',
    'le pilote reste sur `yieldflow` : il pousserait des prix pour une annonce retiree')
  assert.strictEqual(r.pilote_eteint, true, 'le compte rendu ne dit pas que le pilote a ete eteint')
})

test("LE TEST QUI COMPTE : reactiver NE RALLUME PAS YieldFlow", async () => {
  // Remettre un bien en vente est un geste ; remettre un moteur de prix en
  // marche en est un autre. Les confondre rouvrirait des nuits a des prix
  // calcules pendant l'archivage.
  const b = banc({ properties: [unBien({
    archive_le: '2026-10-01T00:00:00Z', pilote_tarifaire: 'calendrier'
  })] })
  await A.reactiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(b.base.properties[0].pilote_tarifaire, 'calendrier',
    'la reactivation a rallume YieldFlow toute seule')
})

test("un bien deja sur `calendrier` ne voit pas son pilote touche", async () => {
  const b = banc({ properties: [unBien({ pilote_tarifaire: 'calendrier' })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.pilote_eteint, false,
    'le compte rendu annonce une extinction qui n a pas eu lieu')
})

test("LE TEST QUI COMPTE : les taches IA EN VOL sont closes, et SEULES celles-la", async () => {
  // ⚠ 35 TACHES OUVERTES SUR LE PREMIER CAS REEL (17 `pending`, 18
  // `pending_validation`, mesure du 30 octobre). Sans cette coupure, elles
  // resteraient dans « A valider » pour un bien qui n'existe plus chez le
  // provider. Et l'etat choisi n'est PAS `ignored` : « ignore » dirait que
  // l'hote a ecarte la proposition.
  const taches = [
    { id: 't1', user_id: 'compte-1', property_id: 'cle-channex', status: 'pending' },
    { id: 't2', user_id: 'compte-1', property_id: 'cle-channex', status: 'pending_validation' },
    { id: 't3', user_id: 'compte-1', property_id: 'cle-channex', status: 'done' },
    { id: 't4', user_id: 'compte-1', property_id: 'cle-channex', status: 'ignored' },
    { id: 't5', user_id: 'compte-1', property_id: 'autre-bien', status: 'pending' },
    { id: 't6', user_id: 'compte-2', property_id: 'cle-channex', status: 'pending' }
  ]
  const b = banc({ properties: [unBien()], agent_tasks: taches })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.taches_closes, 2, `${r.taches_closes} tache(s) closes au lieu de 2`)
  const etat = Object.fromEntries(b.base.agent_tasks.map(t => [t.id, t.status]))
  assert.strictEqual(etat.t1, 'archived', 'une tache `pending` n est pas close')
  assert.strictEqual(etat.t2, 'archived', 'une tache `pending_validation` n est pas close')
  assert.strictEqual(etat.t3, 'done', 'une tache DEJA terminee a ete rouverte ou reecrite')
  assert.strictEqual(etat.t4, 'ignored', 'une tache ignoree a ete reecrite')
  assert.strictEqual(etat.t5, 'pending', 'une tache d un AUTRE bien a ete close')
  assert.strictEqual(etat.t6, 'pending', 'une tache d un AUTRE COMPTE a ete close : fuite entre comptes')
})

test("LE TEST QUI COMPTE : le marqueur d import est retire de la file", async () => {
  // ⚠ LE DEFAUT MESURE LE 30 OCTOBRE 2026 : `ordonnerPourImport` met « jamais
  // importe (`null`) d'abord », donc un bien dont le marqueur reste a `null`
  // passe EN TETE a chaque cycle, avant les biens vivants. Deux biens etaient
  // dans ce cas sur le compte reel.
  const b = banc({
    properties: [unBien()],
    cron_logs: [
      { id: 'messages_import:compte-1:cle-channex', last_run: null },
      { id: 'messages_import:compte-1:autre-bien', last_run: '2026-10-30T19:00:00Z' }
    ]
  })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.marqueur_retire, true, 'le marqueur n a pas ete retire')
  const restants = b.base.cron_logs.map(l => l.id)
  assert.ok(!restants.includes('messages_import:compte-1:cle-channex'),
    'le marqueur du bien archive est encore dans la file : il repassera en tete')
  assert.ok(restants.includes('messages_import:compte-1:autre-bien'),
    'le marqueur d un AUTRE bien a ete retire')
})

test("LE TEST QUI COMPTE : un echec partiel ne se tait pas", async () => {
  // Le bien EST archive — donc hors des boucles —, mais ce qui n a pas ete
  // nettoye doit se lire. Un `ok: true` muet serait le faux vert habituel.
  const b = banc({
    properties: [unBien()],
    agent_tasks: [{ id: 't1', user_id: 'compte-1', property_id: 'cle-channex', status: 'pending' }],
    pannes: { 'agent_tasks:update': 'colonne status absente' }
  })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, true, 'un echec de nettoyage a annule l archivage')
  assert.strictEqual(b.base.properties[0].archive_le, T, 'le bien n est pas archive')
  assert.ok(Array.isArray(r.rates) && r.rates.length === 1, `les rates ne sont pas remontes : ${JSON.stringify(r.rates)}`)
  assert.strictEqual(r.rates[0].quoi, 'taches_ia')
  assert.strictEqual(r.taches_closes, null, 'un nombre de taches closes est annonce alors que l ecriture a echoue')
})

test("LE TEST QUI COMPTE : rearchiver ne REDATE pas", async () => {
  const b = banc({ properties: [unBien({ archive_le: '2026-10-01T00:00:00Z' })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.deja_archive, true, 'le rearchivage n est pas signale comme tel')
  assert.strictEqual(b.base.properties[0].archive_le, '2026-10-01T00:00:00Z',
    'la date d archivage a ete REECRITE : la fin de facturation bougerait avec elle')
})

test("LE TEST QUI COMPTE : le bien d un AUTRE compte est introuvable", async () => {
  const b = banc({ properties: [unBien({ user_id: 'compte-2' })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.motif_refus, 'bien_introuvable', 'un bien d un autre compte a ete atteint')
  assert.strictEqual(b.base.properties[0].archive_le, null, 'le bien d un autre compte a ete archive')
})

test("un bien SANS cle provider s archive quand meme, et le dit", async () => {
  // Le cas du bien jamais provisionne (« colomier », mesure du 30 octobre) :
  // rien a nettoyer dans les tables enfant, mais le bien doit sortir des
  // boucles et des ecrans.
  const b = banc({ properties: [unBien({ provider_property_id: null })] })
  const r = await A.archiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(b.base.properties[0].archive_le, T)
  assert.strictEqual(r.taches_closes, null, 'un nettoyage est annonce sans cle provider')
  assert.strictEqual(r.marqueur_retire, null)
})

test("LE TEST QUI COMPTE : reactiver rend le bien, mais NE ROUVRE PAS le passe", async () => {
  // ⚠ LES TACHES CLOSES RESTENT CLOSES. Elles portaient des messages voyageurs
  // d'il y a des mois : les rendre a « A valider » demanderait a l'hote de
  // repondre a des conversations terminees.
  const b = banc({
    properties: [unBien({ archive_le: '2026-10-01T00:00:00Z', archive_par: 'moi',
      archive_motif: 'supprime chez le provider', facturable_jusqu_au: '2026-10-01T00:00:00Z' })],
    agent_tasks: [{ id: 't1', user_id: 'compte-1', property_id: 'cle-channex', status: 'archived' }]
  })
  const r = await A.reactiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, true, `reactivation refusee : ${JSON.stringify(r)}`)
  const bien = b.base.properties[0]
  assert.strictEqual(bien.archive_le, null, 'le bien reste archive')
  assert.strictEqual(bien.archive_par, null)
  assert.strictEqual(bien.archive_motif, null)
  assert.strictEqual(bien.facturable_jusqu_au, null,
    'la fin de facturation subsiste : le bien serait exploite sans etre facture')
  assert.strictEqual(r.etait_archive_depuis, '2026-10-01T00:00:00Z', 'le compte rendu perd la date d archivage')
  assert.strictEqual(b.base.agent_tasks[0].status, 'archived',
    'une tache close par l archivage a ete rouverte')
})

// ─── La confirmation (option 2 de Thierry) ─────────────────────────────────

test("LE TEST QUI COMPTE : la confirmation compte les sejours A VENIR, annules exclus", async () => {
  // ⚠ DECISION DE THIERRY DU 1er NOVEMBRE 2026 : l'archivage est AUTORISE avec
  // des sejours a venir, et il l'annonce. Le compte doit etre JUSTE : sur le
  // premier cas reel, 15 sejours sont `confirmed` et tous dans le passe, 11 sont
  // annules — le compte juste est ZERO. Un compte qui aurait dit « 26 » aurait
  // fait hesiter l'hote devant un archivage sans consequence.
  const b = banc({ properties: [unBien()] })
  // Le double ne modelise pas `count`, donc on verifie la FORME de la question :
  // c'est elle qui decide si le compte sera juste.
  const vu = []
  const client = {
    from (t) {
      if (t === 'properties') return b.client.from(t)
      const q = { table: t, filtres: {} }
      vu.push(q)
      const ch = {
        select (c, o) { q.select = c; q.options = o; return ch },
        eq (c, v) { q.filtres[c] = v; return ch },
        neq (c, v) { q.filtres[c + '_neq'] = v; return ch },
        gte (c, v) { q.filtres[c + '_gte'] = v; return ch },
        in (c, v) { q.filtres[c + '_in'] = v; return ch },
        limit (n) { q.borne = n; return ch },
        // Le double rend des LIGNES : c'est ce que le code lit desormais.
        then (ok) { return Promise.resolve({ data: [], count: 0, error: null }).then(ok) }
      }
      return ch
    }
  }
  const r = await A.compterAvantArchivage(client, {
    bienId: 'uuid-bien', compte: 'compte-1', aujourdHui: '2026-11-01'
  })
  const sejours = vu.find(q => q.table === 'bookings_snapshot')
  assert.ok(sejours, 'la confirmation ne compte pas les sejours')
  // ⚠ NI `property_uuid` NI `statut_canonique` — constat 3 de la revue de
  // 320aa4f8. Ces deux colonnes sont DERIVEES par le cron de 04:00 : tant
  // qu'une ligne n'est pas derivee elles valent NULL, et les deux filtres
  // l'ecartent (`NULL <> 'cancelled'` rend NULL). Un sejour reserve le jour
  // meme serait invisible, donc la confirmation ne dirait rien des codes
  // d'acces. On lit la cle PROVIDER et le statut DANS le snapshot.
  assert.strictEqual(sejours.filtres.property_uuid, undefined,
    'le compte filtre sur une colonne DERIVEE : un sejour non derive est invisible')
  assert.strictEqual(sejours.filtres.statut_canonique_neq, undefined,
    'le compte filtre sur `statut_canonique`, qui vaut NULL avant derivation')
  assert.strictEqual(sejours.filtres.property_id, 'cle-channex',
    'le compte ne porte pas sur la cle provider du bien')
  assert.strictEqual(sejours.filtres.user_id, 'compte-1',
    'le compte n est pas cloisonne : les sejours d un autre compte entreraient')
  assert.strictEqual(sejours.filtres['snapshot->>departure_gte'], '2026-11-01',
    'le compte ne porte pas sur le DEPART : un sejour en cours serait oublie')
  assert.match(String(sejours.select), /snapshot/,
    'le compte ne lit pas le snapshot, donc il ne peut pas juger du statut')
  // ⚠ CHAQUE COLONNE DEMANDEE EXISTE, ET C'EST LE TEST QUI MANQUAIT. Defaut
  // BLOQUANT trouve par Thierry en recette de staging le 2 novembre 2026 :
  // `sejours_a_venir` valait `null` sur TOUS les biens, y compris un bien sans
  // aucune reservation. La cause : `select('snapshot, provider')`, alors que
  // `bookings_snapshot.provider` N'EXISTE PAS — la table porte `canal`.
  // PostgREST refuse la requete ENTIERE pour une colonne inconnue (42703).
  // ⚠ LA LISTE EST MESUREE CONTRE LA PRODUCTION le 2 novembre 2026, par
  // l'OpenAPI de PostgREST. Elle n'a pas a etre exhaustive pour servir : elle
  // doit contenir ce que ce code demande, et rien de plus large.
  const COLONNES_SNAPSHOT = new Set(['id', 'created_at', 'updated_at', 'user_id',
    'booking_id', 'property_id', 'snapshot', 'raw', 'raw_hash', 'property_uuid',
    'canal', 'statut_canonique', 'montant_net_cents', 'montant_est_brut',
    'commission_cents', 'date_versement', 'motif_non_calculable', 'derive_le',
    'derive_version', 'est_blocage', 'derive_raw_hash', 'date_vente',
    'date_vente_fiable', 'date_vente_motif', 'date_annulation',
    'date_annulation_source'])
  for (const c of String(sejours.select).split(',').map(x => x.trim()).filter(Boolean)) {
    assert.ok(COLONNES_SNAPSHOT.has(c),
      `le compte demande « bookings_snapshot.${c} », qui n existe pas : PostgREST refusera la requete `
      + 'ENTIERE en 42703, et le compte restera `null` sur TOUS les biens')
  }
  const taches = vu.find(q => q.table === 'agent_tasks')
  assert.ok(taches, 'la confirmation ne compte pas les taches en vol')
  assert.deepStrictEqual(taches.filtres.status_in, A.TACHES_EN_VOL)
  assert.strictEqual(r.pilote_actif, false)
  assert.strictEqual(r.etait_facture, true, 'la confirmation ne dit pas que le bien est facture')
})

test("LE TEST QUI COMPTE : un sejour NON DERIVE est compte quand meme", async () => {
  // ⚠ CONSTAT 3 DE LA REVUE DE 320aa4f8, joue comme l'hote le vit : un voyageur
  // reserve aujourd'hui, le cron de derivation (04:00) n'a pas encore tourne,
  // l'hote archive le bien dans la journee. Avec un filtre sur les colonnes
  // derivees, la confirmation ne mentionnait AUCUN sejour a venir — donc aucun
  // mot sur les codes d'acces, sur le seul chiffre qui en engage.
  const brut = { statut_canonique: null, property_uuid: null }
  const lignes = [
    // Deux sejours a venir, VIVANTS, et non derives.
    { snapshot: { status: 'confirmed', departure: '2026-12-01' }, ...brut },
    { snapshot: { status: 'confirmed', departure: '2026-12-15' }, ...brut },
    // Un annule : il ne compte pas, et c'est le SNAPSHOT qui le dit.
    { snapshot: { status: 'cancelled', departure: '2026-12-20' }, ...brut }
  ]
  const client = {
    from (t) {
      const ch = {
        select () { return ch }, eq () { return ch }, neq () { return ch },
        gte () { return ch }, in () { return ch }, limit () { return ch },
        maybeSingle: async () => ({
          data: { id: 'uuid-bien', provider_property_id: 'cle-channex',
                  active_at: null, pilote_tarifaire: 'calendrier', archive_le: null },
          error: null
        }),
        then (ok) {
          return Promise.resolve(t === 'bookings_snapshot'
            ? { data: lignes, error: null }
            : { data: [], count: 0, error: null }).then(ok)
        }
      }
      return ch
    }
  }
  const r = await A.compterAvantArchivage(client, {
    bienId: 'uuid-bien', compte: 'compte-1', aujourdHui: '2026-11-01'
  })
  assert.strictEqual(r.sejours_a_venir, 2,
    `${r.sejours_a_venir} sejour(s) compte(s) au lieu de 2 : le statut n est pas lu dans le snapshot`)
})

test("LE TEST QUI COMPTE : un BLOCAGE PROPRIETAIRE n est pas un sejour a venir", async () => {
  // ⚠ CONSTAT 2 DE LA REVUE DE 26339835. `isActiveStatus(snapshot, null)` ne
  // trouve aucune table de statuts pour une ligne anterieure a l'unification —
  // celles qui n'ont pas de `snapshot.provider` —, avertit, et retombe sur
  // `confirmed`. Un `black` Beds24 (blocage proprietaire), un `request` ou une
  // `inquiry` etaient donc comptes comme sejours a venir : la confirmation
  // promettait des codes d'acces pour des nuits que personne n'a reservees.
  // `lib/cleaning/sync-menages-entite.js` passe le provider pour cette raison,
  // et son commentaire le grave : « le provider manquant faisait retomber
  // 'black' sur 'confirmed' ».
  const lignes = [
    { snapshot: { status: 'confirmed', departure: '2026-12-01' }, provider: 'beds24' },
    // Un blocage proprietaire : le bien est ferme, personne ne vient.
    { snapshot: { status: 'black', departure: '2026-12-05' }, provider: 'beds24' },
    // Une demande non confirmee.
    { snapshot: { status: 'request', departure: '2026-12-10' }, provider: 'beds24' }
  ]
  const client = {
    from (t) {
      const ch = {
        select () { return ch }, eq () { return ch }, neq () { return ch },
        gte () { return ch }, in () { return ch }, limit () { return ch },
        maybeSingle: async () => ({
          // ⚠ LE BIEN PORTE SON PROVIDER, parce que c'est de LA que le lecteur
          // de statut le prend desormais (defaut du 2 novembre 2026 :
          // `bookings_snapshot.provider` n'existe pas).
          data: { id: 'uuid-bien', provider: 'beds24', provider_property_id: 'cle-beds24',
                  active_at: null, pilote_tarifaire: 'calendrier', archive_le: null },
          error: null
        }),
        then (ok) {
          return Promise.resolve(t === 'bookings_snapshot'
            ? { data: lignes, error: null }
            : { data: [], count: 0, error: null }).then(ok)
        }
      }
      return ch
    }
  }
  const r = await A.compterAvantArchivage(client, {
    bienId: 'uuid-bien', compte: 'compte-1', aujourdHui: '2026-11-01'
  })
  assert.strictEqual(r.sejours_a_venir, 1,
    `${r.sejours_a_venir} sejour(s) compte(s) au lieu d un : le provider n est pas passe au lecteur de statut`)
})

test("LE TEST QUI COMPTE : un bien SANS reservation rend 0, jamais `null`", async () => {
  // ⚠ L'ATTENDU DE THIERRY, MOT POUR MOT (recette de staging du 2 novembre
  // 2026) : « Attendu : 0, ou le vrai nombre. » Un `null` fait dire a l'ecran
  // « nous n'avons pas pu compter » — ce qui est faux quand la reponse est
  // simplement « aucun ». La difference est celle que ce depot nomme partout :
  // un `null` n'est pas un zero, et l'inverse est vrai aussi.
  const b = banc({ properties: [unBien()] })
  const client = {
    from (t) {
      if (t === 'properties') return b.client.from(t)
      const ch = {
        select () { return ch }, eq () { return ch }, neq () { return ch },
        gte () { return ch }, in () { return ch }, limit () { return ch },
        // Aucune reservation, et la lecture REUSSIT.
        then (ok) { return Promise.resolve({ data: [], count: 0, error: null }).then(ok) }
      }
      return ch
    }
  }
  const r = await A.compterAvantArchivage(client, {
    bienId: 'uuid-bien', compte: 'compte-1', aujourdHui: '2026-11-02'
  })
  assert.strictEqual(r.sejours_a_venir, 0,
    `un bien sans reservation rend ${JSON.stringify(r.sejours_a_venir)} : l ecran dira « pas pu compter »`)
  assert.strictEqual(r.taches_en_vol, 0, 'le compte des taches en vol a le meme defaut')
})

test("une lecture qui ECHOUE, elle, rend bien `null`", async () => {
  // Le contre-cas, sans lequel « rendre 0 partout » passerait le test
  // precedent — et une panne se lirait « aucun sejour a venir », sur le seul
  // chiffre de cette fenetre qui engage un code d acces.
  const b = banc({ properties: [unBien()] })
  const client = {
    from (t) {
      if (t === 'properties') return b.client.from(t)
      const ch = {
        select () { return ch }, eq () { return ch }, neq () { return ch },
        gte () { return ch }, in () { return ch }, limit () { return ch },
        then (ok) { return Promise.resolve({ data: null, error: { message: 'panne' } }).then(ok) }
      }
      return ch
    }
  }
  const r = await A.compterAvantArchivage(client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.strictEqual(r.sejours_a_venir, null,
    'une panne de lecture passe pour « aucun sejour a venir »')
})

test("LE TEST QUI COMPTE : la lecture du bien DEMANDE `provider`", async () => {
  // ⚠ C'EST LA CAUSE DU DEFAUT DU 2 NOVEMBRE 2026. La revue avait affirme que
  // `bookings_snapshot` porte une colonne `provider` ; je l'ai applique sans le
  // verifier, et la table ne la porte pas — elle porte `canal`. Le provider du
  // bien vit dans `properties.provider`, et c'est de la que
  // `sync-menages-entite` le lit (`providerParBien`).
  // ⚠ ET UNE COLONNE DONT ON JUGE SANS L'AVOIR SELECTIONNEE EST UNE GARDE
  // OUVERTE : `isActiveStatus(snapshot, undefined)` retombe sur `confirmed` et
  // compte les blocages proprietaire. Ce depot nomme ce defaut explicitement.
  // ⚠ Ma premiere version de ce test contenait un `assert.ok(true)` — donc
  // rien. Un test qui ne peut pas echouer est pire qu'un test absent : il
  // occupe la place de celui qui aurait mordu.
  let vu = null
  const client = {
    from (t) {
      const ch = {
        select (c) { if (t === 'properties') vu = c; return ch },
        eq () { return ch }, neq () { return ch }, gte () { return ch },
        in () { return ch }, limit () { return ch },
        maybeSingle: async () => ({
          data: { id: 'uuid-bien', provider: 'channex', provider_property_id: 'cle',
                  active_at: null, pilote_tarifaire: 'calendrier', archive_le: null },
          error: null
        }),
        then (ok) { return Promise.resolve({ data: [], count: 0, error: null }).then(ok) }
      }
      return ch
    }
  }
  await A.compterAvantArchivage(client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.ok(vu, 'la lecture du bien n a pas eu lieu')
  const colonnes = String(vu).split(',').map(x => x.trim())
  assert.ok(colonnes.includes('provider'),
    `la lecture du bien ne demande pas \`provider\` : ${JSON.stringify(colonnes)}`)
})

test("LE TEST QUI COMPTE : le signal « annonce en ligne » est `channel_ready`", async () => {
  // ⚠ ET C'EST UNE MESURE QUI L'A CHOISI, pas une preference. Lecture seule en
  // production le 1er novembre 2026 : `ota_listing_urls` est `null` sur les CINQ
  // biens et `ota_connect_status` vaut `draft` partout. Un avertissement fonde
  // sur eux aurait ete MUET sur les deux biens a archiver. `channel_ready` est
  // vrai sur trois biens, dont ces deux-la.
  const b = banc({ properties: [unBien({ channel_ready: true, ota_listing_urls: null })] })
  const r = await A.compterAvantArchivage(b.client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.strictEqual(r.annonce_en_ligne, true,
    '`channel_ready` ne declenche pas l avertissement : il serait muet sur tout le parc reel')
  assert.deepStrictEqual(r.canaux, [], 'des canaux sont inventes alors qu aucun n est connu')
})

test("les canaux CONNUS sont rendus, en cles brutes", async () => {
  // L'ecran les nomme (`libelleDuCanal`), le serveur ne fait que les rendre :
  // c'est la regle du depot, et c'est elle qui empeche le nom du partenaire
  // technique de sortir.
  const b = banc({ properties: [unBien({
    channel_ready: false,
    ota_listing_urls: { airbnb: 'https://airbnb.fr/rooms/1', booking: null }
  })] })
  const r = await A.compterAvantArchivage(b.client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.strictEqual(r.annonce_en_ligne, true, 'une URL d annonce ne declenche pas l avertissement')
  assert.deepStrictEqual(r.canaux, ['airbnb'],
    `un canal sans URL est rendu quand meme : ${JSON.stringify(r.canaux)}`)
})

test("un bien hors ligne ne declenche AUCUN avertissement", async () => {
  const b = banc({ properties: [unBien({ channel_ready: false, ota_listing_urls: null })] })
  const r = await A.compterAvantArchivage(b.client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.strictEqual(r.annonce_en_ligne, false)
})

test("la confirmation dit qu un bien est DEJA archive", async () => {
  const b = banc({ properties: [unBien({ archive_le: '2026-10-01T00:00:00Z', provider_property_id: null })] })
  const r = await A.compterAvantArchivage(b.client, { bienId: 'uuid-bien', compte: 'compte-1' })
  assert.strictEqual(r.deja_archive, true)
})

test("reactiver un bien vivant est sans effet, et le dit", async () => {
  const b = banc({ properties: [unBien()] })
  const r = await A.reactiver(b.client, { bienId: 'uuid-bien', compte: 'compte-1', maintenant: T })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.deja_vivant, true)
})
