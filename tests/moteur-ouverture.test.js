// tests/moteur-ouverture.test.js — lot 4.6.3, LE MOTEUR D'OUVERTURE.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter §1, §3, §6 et « 4.6.3 livre ».
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. le moteur ne touche JAMAIS une indisponibilite de l'hote, ni une nuit
//      sur laquelle une intention existe (fermee a la main, fermee calculee) ;
//   2. il n'ouvre jamais une nuit sans prix ;
//   3. il ouvre TOUTE la fenetre a l'activation, puis la nuit qui entre ;
//   4. il ecrit par le canal, une fois par jour et par bien, et un echec sur
//      un bien n'empeche pas le suivant.
//
// ⚠ HORLOGE INJECTEE (`aujourdHui`), dates figees : regle du depot.

const test = require('node:test')
const assert = require('node:assert')
// La chaine canal -> writer -> cron-shared cree un client Supabase A L'IMPORT :
// des valeurs factices suffisent, aucun reseau n'est touche ici.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
const { nuitsAOuvrir, prixDOuverture, ouvrirLaFenetreDuBien, ouvrirFenetres, PREFIXE_MARQUEUR } = require('../lib/moteur-ouverture')
const { validerFenetre } = require('../lib/pilote-tarifaire')

const AUJ = '2026-10-01'
const ID = 'b1b1b1b1-0000-4000-8000-000000000001'
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const bien = (o = {}) => ({ id: ID, user_id: COMPTE, name: 'Loft', provider: 'channex', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 5, base_price: 90, inventory_units: 1, rate_sync_mode: 'managed', ...o })

// ─── 1. La decision, pure ───────────────────────────────────────────────────
test('LE TEST QUI COMPTE : le moteur ne touche JAMAIS une indisponibilite de l hote ni une intention existante', () => {
  const fermetures = [{ id: 'f1', property_id: ID, date_debut: '2026-10-02', date_fin: '2026-10-03', raison: 'travaux' }]
  const lignes = [
    { date: '2026-10-04', stop_sell: true, avail: 0, rate: 100 },      // fermee a la main, sans objet
    { date: '2026-10-05', stop_sell: null, avail: 0, rate: 100 },      // fermee par le stock
    { date: '2026-10-06', stop_sell: false, avail: 1, rate: 100 }      // deja ouverte
  ]
  const r = nuitsAOuvrir({ bien: bien(), aujourdHui: AUJ, lignes, fermetures })
  assert.equal(r.fin, '2026-10-06', 'fenetre : aujourd hui + 5 jours')
  assert.deepEqual(r.nuits.map(n => n.date), ['2026-10-01'], 'la seule nuit sans intention ni indisponibilite')
  assert.deepEqual(r.comptes, { a_ouvrir: 1, deja_ouvertes: 1, fermees_par_l_hote: 2, intention_existante: 2, sans_prix: 0 })
  assert.ok(r.nuits.every(n => n.ouvrir === true), 'une demande d ouverture, rien d autre')
})

test('LE TEST QUI COMPTE : une nuit ne s ouvre JAMAIS sans prix — memoire, sinon prix de base, sinon comptee', () => {
  // Une date sans prix part fermee vers les plateformes (8 septembre 2026) :
  // l'ouvrir sans tarif la ferait refermer, ou vendre au prix par defaut.
  const lignes = [{ date: '2026-10-02', stop_sell: null, avail: null, rate: 120 }]
  const avecBase = nuitsAOuvrir({ bien: bien(), aujourdHui: AUJ, lignes, fermetures: [] })
  assert.equal(avecBase.nuits.find(n => n.date === '2026-10-02').prix_centimes, 12000, 'la memoire d abord')
  assert.equal(avecBase.nuits.find(n => n.date === '2026-10-01').prix_centimes, 9000, 'sinon le prix de base')
  const sansBase = nuitsAOuvrir({ bien: bien({ base_price: null }), aujourdHui: AUJ, lignes, fermetures: [] })
  assert.deepEqual(sansBase.nuits.map(n => n.date), ['2026-10-02'], 'sans prix de base, seule la nuit qui porte un prix s ouvre')
  assert.equal(sansBase.comptes.sans_prix, 5, 'et les autres sont COMPTEES, pas oubliees')
  assert.equal(prixDOuverture(bien({ base_price: 0 }), { rate: null }), null)
  assert.equal(prixDOuverture(bien(), { rate: '85.5' }), 8550)
})

test('la premiere activation ouvre TOUTE la fenetre ; le lendemain, seule la nuit qui entre', () => {
  const j1 = nuitsAOuvrir({ bien: bien(), aujourdHui: AUJ, lignes: [], fermetures: [] })
  assert.equal(j1.nuits.length, 6, 'du 1er au 6 inclus')
  // Le lendemain : les six sont ouvertes en memoire, la fenetre atteint le 7.
  const ouvertes = j1.nuits.map(n => ({ date: n.date, stop_sell: false, avail: 1, rate: 90 }))
  const j2 = nuitsAOuvrir({ bien: bien(), aujourdHui: '2026-10-02', lignes: ouvertes, fermetures: [] })
  assert.deepEqual(j2.nuits.map(n => n.date), ['2026-10-07'], 'la fenetre a glisse d un jour')
  assert.equal(j2.comptes.deja_ouvertes, 5, 'le 1er est passe, les cinq autres restent ouvertes')
})

test('N mois glissants : la fenetre se compte avec la regle du pilote (borne au dernier jour du mois)', () => {
  const r = nuitsAOuvrir({ bien: bien({ pilote_fenetre_type: 'mois', pilote_fenetre_valeur: 1 }), aujourdHui: '2026-01-31', lignes: [], fermetures: [] })
  assert.equal(r.fin, '2026-02-28')
  assert.equal(r.nuits.length, 29)
})

test('un bien non pilote, ou sans fenetre, ne s ouvre pas — rien n est calcule', () => {
  assert.deepEqual(nuitsAOuvrir({ bien: bien({ pilote_tarifaire: 'calendrier' }), aujourdHui: AUJ, lignes: [], fermetures: [] }).nuits, [])
  assert.deepEqual(nuitsAOuvrir({ bien: bien({ pilote_fenetre_type: null, pilote_fenetre_valeur: null }), aujourdHui: AUJ, lignes: [], fermetures: [] }).nuits, [])
})

// ─── 2. Un bien : lecture, decision, canal ───────────────────────────────────
function fausseBase ({ lignes = [], fermetures = [], marqueurs = {}, biens = [], erreurs = {} } = {}) {
  const journal = []
  return {
    journal, marqueurs,
    from (table) {
      const q = { f: {}, op: 'select', ligne: null }
      const ch = () => q
      q.select = ch; q.order = ch; q.not = ch; q.limit = ch
      q.eq = (c, v) => { q.f[c] = v; return q }
      q.gte = (c, v) => { q.gte_ = v; return q }; q.lte = (c, v) => { q.lte_ = v; return q }
      q.upsert = (row) => { q.op = 'upsert'; q.ligne = row; return q }
      q.delete = () => { q.op = 'delete'; return q }
      q.maybeSingle = () => { q.un = true; return q }
      const exec = () => {
        journal.push({ table, op: q.op, f: { ...q.f }, ligne: q.ligne })
        if (erreurs[table]) return { data: null, error: { message: erreurs[table] } }
        if (table === 'fermetures') return { data: fermetures.filter(f => f.property_id === q.f.property_id && f.date_debut <= q.lte_ && f.date_fin >= q.gte_), error: null }
        if (table === 'calendar_inventory') return { data: lignes.filter(l => l.date >= q.gte_ && l.date <= q.lte_), error: null }
        if (table === 'properties') return { data: biens, error: null }
        if (table === 'cron_logs') {
          if (q.op === 'upsert') { marqueurs[q.ligne.id] = q.ligne.last_run; return { data: null, error: null } }
          if (q.op === 'delete') { delete marqueurs[q.f.id]; return { data: null, error: null } }
          return { data: marqueurs[q.f.id] ? { last_run: marqueurs[q.f.id] } : null, error: null }
        }
        return { data: [], error: null }
      }
      q.then = (res, rej) => Promise.resolve(exec()).then(res, rej)
      return q
    }
  }
}
const fauxCanal = (reponse) => { const appels = []; const fn = async (sb, b, demande, deps) => { appels.push({ bien: b.id, demande, deps }); return reponse || { ok: true, ecrit: { saved: demande.nuits.length }, ignorees: { passees: [], hors_fenetre: [], fermees_par_l_hote: [], deja_fermees: [], invalides: [] } } }; fn.appels = appels; return fn }

test('LE TEST QUI COMPTE : le moteur ecrit PAR LE CANAL, jamais lui-meme, et lui passe le client canal', async () => {
  const sb = fausseBase({ lignes: [], fermetures: [{ id: 'f1', property_id: ID, date_debut: '2026-10-03', date_fin: '2026-10-03', raison: 'x' }] })
  const canal = fauxCanal()
  const appel = async () => ({ ok: true })
  const r = await ouvrirLaFenetreDuBien(sb, bien(), { aujourdHui: AUJ, appel, demander: canal })
  assert.equal(r.ok, true); assert.equal(r.ouvertes, 5, 'six nuits moins l indisponibilite')
  assert.equal(canal.appels.length, 1)
  assert.equal(canal.appels[0].deps.appel, appel, 'le client canal est transmis, le writer en a besoin pour pousser')
  assert.ok(!canal.appels[0].demande.nuits.some(n => n.date === '2026-10-03'), 'la nuit indisponible n est meme pas demandee')
  assert.ok(sb.journal.every(j => j.op === 'select'), 'AUCUNE ecriture directe : ni calendar_inventory, ni fermetures')
})

test('une lecture des indisponibilites en echec REFUSE — rien n est demande au canal', async () => {
  const sb = fausseBase({ erreurs: { fermetures: 'timeout' } })
  const canal = fauxCanal()
  const r = await ouvrirLaFenetreDuBien(sb, bien(), { aujourdHui: AUJ, demander: canal })
  assert.equal(r.ok, false); assert.equal(r.refus, 'fermetures_illisibles')
  assert.equal(canal.appels.length, 0)
})

test('un refus du canal est rendu tel quel, avec son message', async () => {
  const sb = fausseBase()
  const canal = fauxCanal({ ok: false, refus: 'prix_plancher', message: 'sous le plancher', ignorees: null })
  const r = await ouvrirLaFenetreDuBien(sb, bien(), { aujourdHui: AUJ, demander: canal })
  assert.equal(r.ok, false); assert.equal(r.refus, 'prix_plancher'); assert.match(r.message, /plancher/)
})

// ─── 3. Tous les biens, une fois par jour ────────────────────────────────────
test('LE TEST QUI COMPTE : une fois par jour et par bien — le marqueur est pose APRES le succes, et un echec se retente', async () => {
  const B2 = 'b2b2b2b2-0000-4000-8000-000000000002'
  const sb = fausseBase({ biens: [bien(), bien({ id: B2, name: 'Studio' })] })
  let n = 0
  const canal = async (s, b, demande) => { n++; if (b.id === B2) return { ok: false, refus: 'writer', message: 'panne' }; return { ok: true, ecrit: {}, ignorees: null } }
  const t = Date.parse('2026-10-01T10:00:00Z')
  const b1 = await ouvrirFenetres(sb, { aujourdHui: AUJ, maintenant: () => t, demander: canal })
  assert.equal(b1.biens, 2); assert.equal(b1.traites, 1); assert.equal(b1.erreurs.length, 1, 'le Studio a echoue, le Loft est passe')
  assert.ok(sb.marqueurs[PREFIXE_MARQUEUR + ID], 'marqueur pose pour le Loft')
  assert.ok(!sb.marqueurs[PREFIXE_MARQUEUR + B2], 'PAS pour le Studio : il se retentera')
  // Second passage le meme jour : le Loft est saute, le Studio retente.
  const b2 = await ouvrirFenetres(sb, { aujourdHui: AUJ, maintenant: () => t + 300000, demander: canal })
  assert.equal(b2.sautes, 1); assert.equal(n, 3, 'un appel de plus, pour le Studio seul')
  // Le lendemain : le Loft repart (la fenetre a glisse).
  const b3 = await ouvrirFenetres(sb, { aujourdHui: '2026-10-02', maintenant: () => t + 86400000, demander: canal })
  assert.equal(b3.sautes, 0)
})

test('le budget mur reporte les biens restants au tick suivant, sans erreur', async () => {
  const sb = fausseBase({ biens: [bien(), bien({ id: 'b2b2b2b2-0000-4000-8000-000000000002' })] })
  let t = 0
  const canal = async () => { t += 30000; return { ok: true, ecrit: {}, ignorees: null } }
  const b = await ouvrirFenetres(sb, { aujourdHui: AUJ, maintenant: () => t, budgetMs: 25000, demander: canal })
  assert.equal(b.traites, 1); assert.equal(b.reportes, 1); assert.equal(b.erreurs.length, 0)
})

// ─── 4. La fenetre demandee a l activation ───────────────────────────────────
test('validerFenetre : jours ou mois, entier > 0, bornes ; une case cochee n est pas une fenetre d un jour', () => {
  assert.deepEqual(validerFenetre({ type: 'jours', valeur: 120 }), { ok: true, fenetre: { type: 'jours', valeur: 120 } })
  assert.deepEqual(validerFenetre({ type: 'mois', valeur: '6' }).fenetre, { type: 'mois', valeur: 6 }, 'une chaine de formulaire passe')
  assert.equal(validerFenetre(null).code, 'fenetre_requise')
  assert.equal(validerFenetre({ type: 'semaines', valeur: 2 }).code, 'fenetre_type_inconnu')
  assert.equal(validerFenetre({ type: 'jours', valeur: true }).code, 'fenetre_valeur_invalide')
  assert.equal(validerFenetre({ type: 'jours', valeur: 0 }).code, 'fenetre_valeur_invalide')
  assert.equal(validerFenetre({ type: 'jours', valeur: 1.5 }).code, 'fenetre_valeur_invalide')
  assert.equal(validerFenetre({ type: 'jours', valeur: 731 }).code, 'fenetre_trop_longue')
  assert.equal(validerFenetre({ type: 'mois', valeur: 25 }).code, 'fenetre_trop_longue')
  for (const r of [validerFenetre(null), validerFenetre({ type: 'jours', valeur: 731 })]) assert.match(r.error, /[àâéèêçùô]/, 'le refus parle francais a l hote')
})
