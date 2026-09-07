// tests/moteur-creation.test.js
// Spec : docs/specs/spec-moteur-reservation.md §6.1, §6.2, §6.7
//
// CE QUE CES TESTS DEFENDENT : les trois issues de la creation, et le fait
// qu'elles NE SE CONFONDENT JAMAIS.
//   succes            -> booked, nuits rendues
//   refus CERTAIN     -> remboursement automatique
//   issue INCERTAINE  -> NI remboursement NI rejeu, et une alarme qui REVEILLE
//
// La derniere est la moins intuitive et la plus importante : rembourser un
// sejour peut-etre cree, c'est offrir un sejour ; le rejouer, c'est en creer
// deux.

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.BOOKING_SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')

// ─── Harnais ────────────────────────────────────────────────────────────────
const etat = {
  reponseCRS: null, installOk: true, appelsCRS: [], installs: 0,
  remboursements: [], erreurRemboursement: null,
  incidents: [], alarmes: [], emails: [],
  liberations: [], verrous: new Set(), majEchoue: false
}

class FauxStripe {
  get refunds () {
    return { create: async (opts, o2) => {
      if (etat.erreurRemboursement) throw new Error(etat.erreurRemboursement)
      etat.remboursements.push({ ...opts, cle: o2 && o2.idempotencyKey })
      return { id: 're_1' }
    } }
  }
}

const origine = Module._load
Module._load = function (d) {
  if (d === 'stripe') return FauxStripe
  if (d === './channels') return {
    getProvider: () => ({
      createBooking: async (propId, resa) => {
        etat.appelsCRS.push({ propId, resa })
        return etat.reponseCRS
      },
      installerCRS: async () => { etat.installs++; return { ok: etat.installOk } }
    })
  }
  if (d === './founder-notify') return {
    reportIncident: async (type, o) => { etat.incidents.push({ type, ...o }) },
    envoyerAlerteBrute: async (type, o) => { etat.alarmes.push({ type, ...o }) }
  }
  if (d === './email-voyageur') return {
    envoyerConfirmation: async r => { etat.emails.push({ sorte: 'confirmation', ...r }); return { ok: true } },
    envoyerRemboursement: async r => { etat.emails.push({ sorte: 'remboursement', ...r }); return { ok: true } }
  }
  if (d === './stripe-hote') return {
    API_VERSION: '2025-07-30.basil',
    cleDeLHote: async () => ({ ok: true, cle: 'rk_test_x', mode: 'test' })
  }
  return origine.apply(this, arguments)
}
const C = require('../lib/moteur-creation')
const { libererIntentions } = require('../lib/reservation-directe')
Module._load = origine

const TENTATIVE = {
  id: 'uuid-tentative', user_id: 'uuid-hote', property_id: 'uuid-bien', link_id: 'uuid-lien',
  arrival: '2026-10-01', departure: '2026-10-04', guests: 2,
  guest_first_name: 'Ana', guest_last_name: 'Lopez',
  guest_email: 'ana@exemple.com', guest_phone: '0600000000', lang: 'es',
  amount_cents: 24000, currency: 'EUR', cancellation_policy: 'j7',
  price_detail: [
    { date: '2026-10-01', prix: 80, supplement: 0, total: 80 },
    { date: '2026-10-02', prix: 80, supplement: 0, total: 80 },
    { date: '2026-10-03', prix: 80, supplement: 0, total: 80 }
  ],
  status: 'paid', payment_intent_id: 'pi_1', paid_at: '2026-09-08T22:14:01.000Z'
}
const BIEN = {
  id: 'uuid-bien', name: 'Le Nid', address: '1 rue X', user_id: 'uuid-hote',
  checkin_time: '16:00', checkout_time: '10:00',
  provider: 'channex', provider_property_id: 'prop-123',
  provider_room_type_id: 'rt-1', provider_rate_plan_id: 'rp-1'
}

let base
function table (nom) {
  const q = { table: nom, filtres: {}, maj: null, suppr: false }
  base.requetes.push(q)
  const chaine = {
    select () { return chaine },
    eq (c, v) { q.filtres[c] = v; return chaine },
    in (c, v) { q.filtres[c + '@in'] = v; return chaine },
    lt (c, v) { q.filtres[c + '<'] = v; return chaine },
    update (m) { q.maj = m; return chaine },
    insert (r) {
      if (nom === 'write_locks') {
        if (etat.verrous.has(r.key)) return Promise.resolve({ error: { code: '23505' } })
        etat.verrous.add(r.key)
        return Promise.resolve({ error: null })
      }
      return Promise.resolve({ error: null })
    },
    delete () { q.suppr = true; return chaine },
    async maybeSingle () {
      if (nom === 'booking_attempts') return { data: base.tentative, error: null }
      if (nom === 'properties') return { data: base.bien, error: null }
      if (nom === 'booking_links') return { data: { label: 'Site vitrine' }, error: null }
      if (nom === 'knowledge') return { data: { value: '0666465290' }, error: null }
      return { data: null, error: null }
    },
    then (res) {
      if (q.suppr) {
        if (nom === 'write_locks') {
          if (q.filtres.key) etat.verrous.delete(q.filtres.key)
          if (q.filtres['key@in']) etat.liberations.push({ cles: q.filtres['key@in'], token: q.filtres.token })
        }
        return res({ error: null })
      }
      if (q.maj && nom === 'booking_attempts') {
        if (etat.majEchoue) return res({ data: null, error: { message: 'panne' } })
        // ⚠ L'update HONORE ses filtres et rend les lignes TOUCHEES. Le harnais
        // appliquait la maj sans regarder `.eq('status', ...)` et rendait un
        // tableau vide : il ne pouvait donc pas distinguer « mis a jour » de
        // « aucune ligne ne correspondait », et laissait passer le constat de
        // review sur la mise a jour perdue.
        const correspond = Object.entries(q.filtres)
          .filter(([c]) => !c.includes('@') && !c.includes('<'))
          .every(([c, v]) => base.tentative[c] === v)
        if (!correspond) return res({ data: [], error: null })
        base.tentative = { ...base.tentative, ...q.maj }
        return res({ data: [{ id: base.tentative.id }], error: null })
      }
      return res({ data: [], error: null })
    }
  }
  return chaine
}
const supabase = { from: table }

function reinit (surT, surB) {
  base = { tentative: { ...TENTATIVE, ...(surT || {}) }, bien: surB === null ? null : { ...BIEN, ...(surB || {}) }, requetes: [] }
  etat.reponseCRS = { ok: true, id: 'bk-999', status: 200 }
  etat.installOk = true; etat.appelsCRS = []; etat.installs = 0
  etat.remboursements = []; etat.erreurRemboursement = null
  etat.incidents = []; etat.alarmes = []; etat.emails = []
  etat.liberations = []; etat.verrous = new Set(); etat.majEchoue = false
}

// ─── Le succes ──────────────────────────────────────────────────────────────
test('succes : la reservation est creee, la tentative passe a booked', async () => {
  reinit()
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.ok, true)
  assert.equal(r.bookingId, 'bk-999')
  assert.equal(base.tentative.status, 'booked')
  assert.equal(base.tentative.provider_booking_id, 'bk-999')
  assert.equal(etat.remboursements.length, 0, 'aucun remboursement sur un succes')
})

test('le payload CRS vient de la TENTATIVE, jamais d un recalcul', async () => {
  // Ce qui a ete montre au voyageur et encaisse chez Stripe est ce qui part chez
  // le provider : un recalcul pourrait diverger d un centime.
  reinit()
  await C.creerDepuisTentative(supabase, TENTATIVE.id)
  const { resa, propId } = etat.appelsCRS[0]
  assert.equal(propId, 'prop-123')
  assert.equal(resa.amount, 240, 'amount = amount_cents / 100')
  assert.deepEqual(resa.days, { '2026-10-01': 80, '2026-10-02': 80, '2026-10-03': 80 })
  assert.equal(resa.customer.mail, 'ana@exemple.com')
  assert.equal(resa.customer.language, 'es')
  assert.equal(resa.occupancy.adults, 2)
})

test('la PROVENANCE voyage jusqu au provider (§3 ter, ajout 4)', async () => {
  reinit()
  await C.creerDepuisTentative(supabase, TENTATIVE.id)
  const meta = etat.appelsCRS[0].resa.meta
  assert.equal(meta.source, 'hotesmart-engine')
  assert.equal(meta.link_label, 'Site vitrine')
  assert.equal(meta.attempt_id, TENTATIVE.id)
})

test('l e-mail part dans la langue FIGEE sur la tentative', async () => {
  reinit()
  await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(etat.emails.length, 1)
  assert.equal(etat.emails[0].sorte, 'confirmation')
  assert.equal(etat.emails[0].lang, 'es', 'la langue du voyageur, pas celle du serveur')
  assert.equal(etat.emails[0].politique, 'j7')
  assert.equal(etat.emails[0].telephone_hote, '0666465290', 'lu dans knowledge')
})

// ─── Le claim : jamais deux reservations pour un paiement ───────────────────
test('CLAIM : deux traitements simultanes ne creent qu UNE reservation', async () => {
  // Stripe rejoue ses webhooks. Sans claim, deux livraisons de `completed`
  // creeraient deux reservations pour un seul paiement.
  reinit()
  const [a, b] = await Promise.all([
    C.creerDepuisTentative(supabase, TENTATIVE.id),
    C.creerDepuisTentative(supabase, TENTATIVE.id)
  ])
  const aboutis = [a, b].filter(x => x.ok).length
  const refuses = [a, b].filter(x => x.raison === 'deja_en_cours' || x.raison === 'statut_inattendu').length
  assert.equal(aboutis + refuses, 2)
  assert.ok(etat.appelsCRS.length <= 1, 'un seul POST CRS, jamais deux')
})

test('une tentative qui n est plus `paid` n est pas rejouee', async () => {
  reinit({ status: 'booked' })
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'statut_inattendu')
  assert.equal(etat.appelsCRS.length, 0, 'aucun POST sur une tentative deja traitee')
})

// ─── L echec CERTAIN : on rembourse ─────────────────────────────────────────
test('refus explicite du provider -> REMBOURSEMENT automatique', async () => {
  reinit()
  etat.reponseCRS = { ok: false, status: 422, erreurs: { detail: 'dates invalides' } }
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.ok, false)
  assert.equal(r.rembourse, true)
  assert.equal(etat.remboursements.length, 1)
  assert.equal(etat.remboursements[0].payment_intent, 'pi_1')
  assert.equal(etat.remboursements[0].cle, `bkrf_${TENTATIVE.id}`, 'idempotent')
  assert.equal(base.tentative.status, 'refunded')
  assert.equal(etat.emails[0].sorte, 'remboursement')
  assert.equal(etat.alarmes.length, 0, 'rembourse : rien n est en suspens, pas de reveil')
})

test('bien mal configure -> refus CERTAIN, donc remboursement', async () => {
  // Rien n a ete poste : on peut rembourser sans risque.
  reinit(null, { provider_rate_plan_id: null })
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.rembourse, true)
  assert.equal(etat.appelsCRS.length, 0, 'aucun POST n a ete tente')
  assert.equal(base.tentative.status, 'refunded')
})

test('un bien Beds24 est refuse : l ecriture CRS n existe que chez Channex', async () => {
  reinit(null, { provider: 'beds24' })
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.rembourse, true)
  assert.equal(etat.appelsCRS.length, 0)
})

// ─── L issue INCERTAINE : ni remboursement ni rejeu ─────────────────────────
test('ISSUE INCERTAINE (status 0) : NI remboursement NI rejeu, et ca REVEILLE', async () => {
  // `status: 0` est ce que rend la couche canal quand l appel n a pas abouti.
  // On ne sait PAS si Channex a cree la reservation.
  reinit()
  etat.reponseCRS = { ok: false, status: 0, erreurs: { code: 'network_error' } }
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.raison, 'issue_incertaine')
  assert.equal(etat.remboursements.length, 0, 'rembourser un sejour peut-etre cree, c est l offrir')
  assert.equal(etat.appelsCRS.length, 1, 'le POST n est JAMAIS rejoue')
  assert.equal(base.tentative.status, 'paid', 'le statut ne bouge pas : un humain tranche')

  // ⚠ L EXIGENCE DE THIERRY : une notification REELLE, pas une ligne en base.
  assert.equal(etat.alarmes.length, 1, 'l alarme qui reveille DOIT partir')
  assert.equal(etat.alarmes[0].type, 'paiement_issue_incertaine')
  assert.match(etat.alarmes[0].prefixe, /ARGENT EN SUSPENS/)
  assert.match(etat.alarmes[0].detail, /NE PAS REJOUER/)
  assert.equal(etat.incidents.length, 1, 'et la trace en base aussi')
})

test('l alarme contourne l anti-spam : incident ET envoi direct', async () => {
  // `reportIncident` se tait si une alerte du meme type et du meme bien est deja
  // partie dans l heure. Deux paiements incertains sur le meme bien sont DEUX
  // voyageurs : le second serait etouffe.
  reinit()
  etat.reponseCRS = { ok: false, status: 0 }
  await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(etat.incidents.length, 1, 'trace')
  assert.equal(etat.alarmes.length, 1, 'envoi garanti, sans seuil')
})

test('reservation CREEE mais ECRITURE en panne : incertain aussi', async () => {
  // Du point de vue de nos donnees, on ne sait plus. Surtout pas de
  // remboursement, surtout pas de rejeu.
  reinit()
  etat.majEchoue = true
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.raison, 'statut_non_enregistre')
  assert.equal(r.bookingId, 'bk-999')
  assert.equal(etat.remboursements.length, 0)
  assert.equal(etat.alarmes.length, 1)
  assert.match(etat.alarmes[0].detail, /NE PAS REJOUER/)
})

test('MISE A JOUR PERDUE : la tentative a change d etat pendant le POST', async () => {
  // ⚠ CONSTAT DE REVIEW. Sans `.select()`, un update qui ne touche AUCUNE ligne
  // rend `{ error: null }` et passe pour un succes. Scenario reel : l hote
  // rembourse a la main depuis Stripe pendant que le POST est en vol, le webhook
  // `charge.refunded` passe la tentative a `refunded`, notre update ne touche
  // rien — et on envoyait au voyageur une confirmation pour une reservation
  // remboursee.
  reinit()
  const vraiCreate = etat.reponseCRS
  Object.defineProperty(etat, 'reponseCRS', {
    configurable: true,
    get () {
      base.tentative = { ...base.tentative, status: 'refunded' }   // la course
      return vraiCreate
    }
  })
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  delete etat.reponseCRS
  etat.reponseCRS = null

  assert.equal(r.ok, false, 'ce n est PAS un succes')
  assert.equal(r.raison, 'statut_non_enregistre')
  assert.equal(etat.emails.length, 0, 'aucune confirmation pour une resa remboursee')
  assert.equal(etat.alarmes.length, 1, 'ca reveille : la reservation existe chez le provider')
})

// ─── Le pire etat : echec de creation ET de remboursement ───────────────────
test('creation ECHOUEE et remboursement ECHOUE : ca reveille', async () => {
  reinit()
  etat.reponseCRS = { ok: false, status: 422 }
  etat.erreurRemboursement = 'carte introuvable'
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.rembourse, false)
  assert.equal(base.tentative.status, 'paid', 'reste paid : rien n a ete rendu')
  assert.equal(etat.alarmes.length, 1)
  assert.match(etat.alarmes[0].detail, /REMBOURSEMENT ECHOUE/)
  assert.match(etat.alarmes[0].detail, /A LA MAIN/)
})

// ─── Le 403 : le SEUL rejeu autorise ────────────────────────────────────────
test('403 : l app CRS est installee et le POST rejoue UNE fois', async () => {
  // Un 403 signifie que RIEN n a ete cree : ce rejeu-la est sur. C est le seul.
  reinit()
  let n = 0
  Module._load = origine
  etat.reponseCRS = { ok: false, status: 403 }
  const suite = [{ ok: false, status: 403 }, { ok: true, id: 'bk-403', status: 200 }]
  Object.defineProperty(etat, 'reponseCRS', {
    configurable: true,
    get () { return suite[Math.min(n++, suite.length - 1)] }
  })
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  delete etat.reponseCRS
  etat.reponseCRS = null
  assert.equal(r.ok, true)
  assert.equal(etat.installs, 1, 'l app a ete installee')
  assert.equal(etat.appelsCRS.length, 2, 'un seul rejeu, apres installation')
})


// ─── CONSTAT DE REVIEW : le champ requis qui bloquait TOUT ─────────────────
test('BLOQUANT : le payload porte otaReservationCode, requis par payloadCRS', () => {
  // Son absence faisait LEVER la construction du payload — donc chaque paiement
  // finissait en argent encaisse, aucune reservation, aucun remboursement.
  // Les tests ne le voyaient pas : le stub de `./channels` ne valide rien.
  const REQUIS = ['roomTypeId', 'ratePlanId', 'arrival', 'departure', 'amount', 'currency', 'otaReservationCode']
  const p = C.payloadDepuisTentative(TENTATIVE, BIEN)
  const manquants = REQUIS.filter(c => p[c] === undefined || p[c] === null || p[c] === '')
  assert.deepEqual(manquants, [], 'CHAMPS_REQUIS de lib/channels/channex.js')
})

test('le code de reservation est DETERMINISTE, pas aleatoire', () => {
  // C est ce qui permettra de retrouver une reservation chez le provider a
  // partir de nos donnees, et donc de trancher une issue incertaine.
  const a = C.codeReservation(TENTATIVE.id)
  assert.equal(a, C.codeReservation(TENTATIVE.id), 'stable')
  assert.notEqual(a, C.codeReservation('autre-uuid'), 'distinct par tentative')
  // Sur un vrai UUID — la forme reelle en production.
  const vrai = C.codeReservation('11112222-3333-4444-5555-666677778888')
  assert.match(vrai, /^HSM-[0-9A-F]{16}$/)
  assert.equal(vrai.length, 20, 'assez court pour un champ provider')
})

// ─── CONSTAT DE REVIEW : les tentatives bloquees en « paye » ───────────────
test('une tentative bloquee en paye est SIGNALEE, jamais rejouee', async () => {
  // Si la fonction meurt pendant le POST, Stripe rejoue `completed` mais le
  // webhook sort aussitot (deja `paid`). Rien ne relisait la file.
  reinit()
  const vieille = { ...TENTATIVE, updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }
  const faux = {
    from: (nom) => ({
      select: () => ({
        eq: () => ({
          lt: () => ({ limit: async () => ({ data: [vieille], error: null }) }),
          maybeSingle: async () => ({ data: BIEN, error: null })
        })
      }),
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) })
    })
  }
  const r = await C.rattraperBloquees(faux)
  assert.equal(r.signalees, 1)
  assert.equal(etat.appelsCRS.length, 0, 'AUCUN rejeu du POST')
  assert.equal(etat.alarmes.length, 1)
  assert.match(etat.alarmes[0].detail, /NE PAS REJOUER/)
  assert.match(etat.alarmes[0].detail, /HSM-/, 'le code a chercher chez le provider')
})

test('une tentative DEJA signalee ne re-alerte pas a chaque cycle', async () => {
  // Une alarme qui crie en boucle finit ignoree.
  reinit()
  const dejaVue = { ...TENTATIVE, updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
                    last_error: C.MARQUE_SIGNALEE + ':2026-09-07T10:00:00Z' }
  const faux = {
    from: () => ({
      select: () => ({ eq: () => ({
        lt: () => ({ limit: async () => ({ data: [dejaVue], error: null }) }),
        maybeSingle: async () => ({ data: BIEN, error: null })
      }) }),
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) })
    })
  }
  const r = await C.rattraperBloquees(faux)
  assert.equal(r.signalees, 0)
  assert.equal(r.vues, 1)
  assert.equal(etat.alarmes.length, 0)
})


// ─── CONSTAT DE LA VALIDATION REELLE (8 septembre 2026) ────────────────────
test('un payload refuse AVANT envoi est un echec CERTAIN : on rembourse', async () => {
  // ⚠ TROUVE EN PRODUCTION, pas par un test. Un `price_detail` vide faisait
  // refuser `payloadCRS` LOCALEMENT — avant tout appel reseau — et l exception
  // tombait dans le fourre-tout « issue incertaine » : argent encaisse, aucun
  // remboursement, et une alarme qui reveille pour rien.
  // `channelCall` ATTRAPE les pannes reseau (status 0) : la seule facon dont
  // createBooking puisse LEVER est le refus du payload, donc rien n est parti.
  reinit()
  base.tentative = { ...base.tentative, price_detail: [] }
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'detail_prix_invalide')
  assert.equal(r.rembourse, true, 'l argent revient : rien n a ete envoye')
  assert.equal(etat.appelsCRS.length, 0, 'AUCUN appel au provider')
  assert.equal(etat.alarmes.length, 0, 'un echec certain ne REVEILLE PAS')
  assert.equal(base.tentative.status, 'refunded')
  assert.equal(etat.emails[0].sorte, 'remboursement')
})

test('un detail de prix qui ne couvre pas le sejour est refuse', async () => {
  reinit()
  base.tentative = { ...base.tentative, price_detail: [{ date: '2026-10-01', total: 80 }] }  // 1 jour pour 3 nuits
  const r = await C.creerDepuisTentative(supabase, TENTATIVE.id)
  assert.equal(r.raison, 'detail_prix_invalide')
  assert.equal(etat.appelsCRS.length, 0)
  assert.equal(r.rembourse, true)
})


// ─── CONSTAT DE REVIEW : la fenetre de surreservation ouverte par un correctif ─
// Ces trois controles portent sur la STRUCTURE de api/book-webhook.js, faute de
// pouvoir signer un webhook Stripe dans un test. Meme forme que
// tests/bookings-snapshot-troncature.test.js : ils figent l'invariant, pas le
// comportement — et c'est deja ce qui manquait quand le defaut est passe.
const sourceWebhook = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'api/book-webhook.js'), 'utf8')

test('la liberation des nuits est GARDEE par une creation en vol', () => {
  // ⚠ Le COMPORTEMENT de `claimActif` est eprouve par execution dans
  // tests/book-webhook-claim.test.js — un grep de source avait laisse passer du
  // code mort. Ici on ne verifie que le CABLAGE : que le garde soit bien pose
  // sur la branche de liberation.
  assert.match(sourceWebhook, /const creationEnVol = .*claimActif\(tentative\.id\)/)
  assert.match(sourceWebhook, /&& !creationEnVol\) \{/)
})

test('un remboursement PARTIEL ne rend pas la tentative terminale', () => {
  // Stripe emet `charge.refunded` pour tout remboursement. Un geste commercial
  // de 20 EUR sur 240 faisait basculer la tentative en `refunded` — etat
  // terminal, revente bloquee, et depuis peu nuits liberees par-dessus.
  assert.match(sourceWebhook, /amount_refunded/)
  assert.match(sourceWebhook, /remboursement PARTIEL ignore/)
})


// ─── EXIGENCE DE THIERRY, apres la premiere vraie alarme ───────────────────
// « Le message doit me permettre de trancher SANS OUVRIR UN ECRAN. »
test('toute alarme porte dates, montant, voyageur, heure du paiement et code', async () => {
  reinit()
  etat.reponseCRS = { ok: false, status: 0 }
  await C.creerDepuisTentative(supabase, TENTATIVE.id)
  const d = etat.alarmes[0].detail
  assert.match(d, /01\/10-04\/10/, 'les dates du sejour')
  assert.match(d, /240\.00 EUR/, 'le montant')
  assert.match(d, /ana@exemple\.com/, 'le voyageur')
  // ⚠ HEURE DE PARIS : 22:14 UTC le 8 septembre = 00:14 le 9 a Paris. C'est
  // exactement le decalage que le constat de review a releve — mauvais jour ET
  // mauvaise heure sur le seul message cense permettre de trancher.
  assert.match(d, /paye 09\/09 00:14/, 'l heure de l ENCAISSEMENT, en heure de Paris')
  assert.match(d, /HSM-/, 'le code a chercher chez le provider')
})

test('les faits tiennent dans un SMS (300 caracteres)', () => {
  // `envoyerAlerteBrute` tronque a 300 : les faits passent AVANT la cause, pour
  // qu'une troncature coute l explication et jamais de quoi agir.
  const f = C.faits(TENTATIVE)
  assert.ok(f.length < 120, `${f.length} caracteres, trop long pour laisser place a la cause`)
  assert.ok(f.indexOf('240.00') < f.indexOf('HSM-'), 'le montant avant le code')
})

test('sans heure d encaissement, l alarme le DIT au lieu d inventer', () => {
  // `updated_at` bougerait au premier rattrapage et mentirait sur l heure du
  // paiement. Mieux vaut « heure inconnue » qu une date fausse.
  assert.match(C.faits({ ...TENTATIVE, paid_at: null }), /paye heure inconnue/)
})

test('l heure d encaissement n est ecrite QUE sur le passage a paye', () => {
  // ⚠ Compter les occurrences de `paid_at` etait fragile (constat de review) :
  // toute reference legitime supplementaire cassait le test sans regression.
  // On verifie ce qui compte : la seule AFFECTATION est celle du passage a
  // `paid`. Ailleurs, `paid_at` ne doit jamais etre reecrit — sinon l alarme
  // afficherait l heure de l alarme au lieu de celle du paiement.
  assert.match(sourceWebhook, /maj\.paid_at = new Date\(\)\.toISOString\(\)/)
  // On ne compte que les ECRITURES EN BASE (`maj.paid_at`), pas les lectures ni
  // les replis en memoire : le repli `tentative.paid_at || …` du chemin
  // d'exception est legitime, il ne deplace rien en base.
  const ecritures = sourceWebhook.match(/maj\.paid_at\s*=/g) || []
  assert.equal(ecritures.length, 1,
    `${ecritures.length} ecritures de paid_at en base — l'heure du paiement ne doit jamais bouger`)
})


test('l incident de REMBOURSEMENT porte aussi les faits', () => {
  // Constat de Thierry a la reception du premier : « Reservation impossible —
  // voyageur rembourse » disait la cause et le montant, mais pas les dates, pas
  // le voyageur, pas l heure, pas le code. L exigence « trancher sans ouvrir un
  // ecran » vaut pour TOUTE notification d argent.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/moteur-creation.js'), 'utf8')
  const bloc = src.slice(src.indexOf("reportIncident('reservation_remboursee'"))
  assert.match(bloc.slice(0, 300), /faits\(t\)/,
    'l incident de remboursement doit porter dates, montant, voyageur, heure et code')
})
