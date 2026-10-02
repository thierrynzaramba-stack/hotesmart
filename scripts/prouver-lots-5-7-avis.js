#!/usr/bin/env node
// scripts/prouver-lots-5-7-avis.js — les lots 5 a 7 du chantier avis, sur la
// VRAIE base de staging, par les VRAIS handlers.
//
// Usage : node --env-file=.env.staging scripts/prouver-lots-5-7-avis.js
//
// POURQUOI. Les tests unitaires parlent a un double de base : ils ne voient ni
// une colonne mal nommee, ni une contrainte, ni une relation ambigue. C'est ce
// script-la qui avait trouve deux defauts au lot 4 (scripts/prouver-parcours-
// avis.js). Celui-ci eprouve, contre la base reelle :
//   - la PWA : naissance a l'ouverture, questions, reponses par le JETON ;
//   - la notification a l'hote (une tache, une seule) ;
//   - le refus d'une prestataire non autorisee, sans naissance ;
//   - les relances (une par palier, jamais deux) ;
//   - l'archivage manuel d'un fil (le seul writer), l'epingle respectee.
//
// ⚠ IL APPELLE LES HANDLERS EN LOCAL (require), pas le deploiement : le code de
// la nuit du 2 octobre n'etait pas deploye sur staging.
//
// ⚠ STAGING UNIQUEMENT, verifie par deux empreintes (reference du projet, 3
// biens). Il ECRIT, puis NETTOIE dans un `finally`, et le nettoyage se verifie.
//
// ⚠ RIEN NE PART : aucun appel provider (pas de publication), et les alertes
// SMS / e-mail n'ont ni configuration ni cle sur staging (verifie avant
// d'ecrire ce script). La tache, elle, est ecrite puis supprimee.

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
const EMAIL = process.env.TEST_EMAIL
const MDP = process.env.TEST_PASSWORD
const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'
for (const [n, v] of [['SUPABASE_URL', URL], ['SUPABASE_SERVICE_KEY', KEY], ['SUPABASE_ANON_KEY', ANON], ['TEST_EMAIL', EMAIL], ['TEST_PASSWORD', MDP]]) {
  if (!v) { console.error(`${n} requis.`); process.exit(1) }
}
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'inutile-ici'

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }
const abandon = (m) => { throw new Error(m) }

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
async function appeler (handler, req) { const res = reponse(); await handler(req, res); return res }

;(async () => {
  console.log(`Base : ${projet}`)
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Empreinte : ${biens} bien(s)\n`)
  if (projet !== PROJET_STAGING || biens !== 3) {
    console.error(`ECHEC : ce script ECRIT. Base STAGING attendue (${PROJET_STAGING}, 3 biens).`)
    process.exit(1)
  }

  const suffixe = Date.now()
  const BK = `PREUVE-L57-${suffixe}`
  const JETON = `preuve-l57-${suffixe}-${Math.random().toString(36).slice(2, 10)}`
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  // Une nuit au moins : un sejour de zero nuit ne se dessine pas au calendrier.
  const avantHier = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  const nettoyer = { profil: null, token: false, snapshot: false, menage: false, fait: false }
  let compte = null

  try {
    const { data: bien } = await sb.from('properties')
      .select('id, user_id, name, provider_property_id').order('created_at').limit(1).single()
    compte = bien.user_id
    const REF = String(bien.provider_property_id)
    console.log(`Compte ${String(compte).slice(0, 8)} · bien « ${bien.name} »\n`)

    // ─── Le decor ──────────────────────────────────────────────────────────
    const { data: profil, error: eP } = await sb.from('profiles').insert({
      account_user_id: compte, first_name: 'Preuve', last_name: 'Lots57',
      access_mode: 'lien', active: true, accepted_at: new Date().toISOString(),
      pwa_token: JETON, eval_scope: 'selon_grille', eval_power: 'soumettre',
    }).select().single()
    if (eP) abandon(`profil : ${eP.message}`)
    nettoyer.profil = profil.id
    const { error: eT } = await sb.from('public_tokens').insert({ user_id: compte, token: JETON, label: 'Preuve lots 5-7', property_ids: [REF] })
    if (eT) abandon(`jeton : ${eT.message}`)
    nettoyer.token = true
    const { error: eS } = await sb.from('bookings_snapshot').insert({
      user_id: compte, booking_id: BK, property_id: REF,
      snapshot: { provider: 'channex', source: 'AirBNB', arrival: avantHier, departure: hier, firstName: 'Voyageur', lastName: 'Preuve', status: 'confirmed' },
    })
    if (eS) abandon(`reservation : ${eS.message}`)
    nettoyer.snapshot = true
    const { error: eM } = await sb.from('menages').insert({
      user_id: compte, property_id: REF, booking_id: BK, departure_date: hier,
      provider_id: profil.id, status: 'accepted', assigned_by: 'manual',
    })
    if (eM) abandon(`menage : ${eM.message}`)
    nettoyer.menage = true
    const { error: eF } = await sb.from('menage_done').insert({ user_id: compte, property_id: REF, booking_id: BK, departure_date: hier, done_by_token: JETON })
    if (eF) abandon(`menage fait : ${eF.message}`)
    nettoyer.fait = true
    ok('decor : prestataire par lien, sejour Airbnb, menage a elle et fait')

    const avis = require('../api/avis')
    const MENAGE = { property_id: REF, booking_id: BK, departure_date: hier }

    // ─── LOT 5 — la PWA, par le jeton ──────────────────────────────────────
    const l1 = await appeler(avis, { method: 'GET', query: { action: 'pwa-evaluation', token: JETON, ...MENAGE }, body: null, headers: {} })
    if (l1.code !== 200) abandon(`pwa-evaluation : HTTP ${l1.code} ${JSON.stringify(l1.body)}`)
    if (l1.body.role !== 'prestataire') ko(`role ${l1.body.role}`)
    else ok('LOT 5 — la PWA ouvre ses questions par le JETON, role prestataire')
    const criteres = l1.body.criteres || []
    if (!criteres.length) ko('aucune question pour elle')
    else ok(`LOT 5 — ${criteres.length} question(s) pour elle, et seulement les siennes`)
    if (l1.body.evaluation.booking_uid !== undefined || l1.body.evaluation.public_text !== undefined) ko('elle recoit le sejour ou le texte')
    else ok('LOT 5 — ni identifiant de sejour ni texte public')

    const { data: nee } = await sb.from('guest_evaluations').select('id, status, deadline_at, ota_review_id, property_id').eq('user_id', compte).eq('booking_uid', BK).maybeSingle()
    if (!nee) ko('aucune evaluation nee en base')
    else if (nee.deadline_at || nee.ota_review_id) ko('une echeance ou un objet ont ete inventes')
    else ok('NAISSANCE (D2) — l evaluation est nee en base, a_remplir, sans echeance ni objet')

    const reponses = Object.fromEntries(criteres.map(c => [c.cle, (c.niveaux || [])[0] && c.niveaux[0].cle]))
    const r1 = await appeler(avis, { method: 'POST', query: { action: 'pwa-reponses' }, body: { action: 'pwa-reponses', token: JETON, ...MENAGE, reponses }, headers: {} })
    if (r1.code !== 200) abandon(`pwa-reponses : HTTP ${r1.code} ${JSON.stringify(r1.body)}`)
    ok(`LOT 5 — ses reponses sont enregistrees (statut ${r1.body.status})`)

    // ─── LOT 6 — l'hote est prevenu, une fois ──────────────────────────────
    const taches = async (marqueur) => {
      const { data } = await sb.from('agent_tasks').select('id, status, summary').eq('user_id', compte).eq('book_id', BK).eq('guest_message', marqueur)
      return data || []
    }
    const t1 = await taches(`[AUTO: avis rempli ${BK}]`)
    if (t1.length !== 1) ko(`taches de notification : ${t1.length} (1 attendue)`)
    else if (t1[0].status !== 'pending') ko(`la tache porte ${t1[0].status} (elle s afficherait comme une reponse au voyageur)`)
    else ok('LOT 6 — l hote a UNE tache, `pending` : « Preuve a rempli sa part… »')
    await appeler(avis, { method: 'POST', query: { action: 'pwa-reponses' }, body: { action: 'pwa-reponses', token: JETON, ...MENAGE, reponses }, headers: {} })
    if ((await taches(`[AUTO: avis rempli ${BK}]`)).length !== 1) ko('un second envoi a cree une seconde tache')
    else ok('LOT 6 — un second envoi ne cree pas de seconde tache')

    // Les relances : on rapproche l'echeance (la fenetre est de cinq jours).
    await sb.from('guest_evaluations').update({ deadline_at: new Date(Date.now() + 3 * 86400000).toISOString() }).eq('id', nee.id)
    const { relancerEvaluations } = require('../lib/avis/notifications')
    // ⚠ BORNEE AU DECOR (constat de revue) : sans `seulement`, la relance lisait
    // TOUT staging et relancait aussi les vraies evaluations de la fenetre.
    const b1 = await relancerEvaluations(sb, { seulement: [BK] })
    const b2 = await relancerEvaluations(sb, { seulement: [BK] })
    const t5 = await taches(`[AUTO: avis relance J-5 ${BK}]`)
    if (t5.length !== 1) ko(`relances J-5 : ${t5.length} (1 attendue) — bilans ${JSON.stringify(b1)} ${JSON.stringify(b2)}`)
    else ok(`LOT 6 — une relance J-5, et un second passage n en ajoute pas (bilans ${b1.relancees} puis ${b2.relancees})`)

    // ─── D1 — une prestataire non autorisee ne fait rien naitre ───────────
    await sb.from('profiles').update({ eval_scope: 'aucun' }).eq('id', profil.id)
    const BK2 = `${BK}-B`
    const n1 = await appeler(avis, { method: 'GET', query: { action: 'pwa-evaluation', token: JETON, property_id: REF, booking_id: BK2, departure_date: hier }, body: null, headers: {} })
    const { data: nee2 } = await sb.from('guest_evaluations').select('id').eq('user_id', compte).eq('booking_uid', BK2).maybeSingle()
    if (n1.code !== 403 || n1.body.motif !== 'prestataire_non_autorisee' || nee2) ko(`non autorisee : HTTP ${n1.code} ${n1.body && n1.body.motif}, nee=${Boolean(nee2)}`)
    else ok('D1 — non autorisee : 403, et rien ne nait')

    // ─── LOT 7 — l'archivage manuel, par le seul writer ────────────────────
    const anon = createClient(URL, ANON, { auth: { persistSession: false } })
    const { data: s, error: eA } = await anon.auth.signInWithPassword({ email: EMAIL, password: MDP })
    if (eA || !s.session) abandon(`session du titulaire : ${eA && eA.message}`)
    const messagesApi = require('../api/messages')
    const auth = { authorization: `Bearer ${s.session.access_token}` }
    const a1 = await appeler(messagesApi, { method: 'POST', query: {}, body: { action: 'archiver', booking_id: BK }, headers: auth })
    const { data: f1 } = await sb.from('conversation_flags').select('pinned, archived_manual, archived_reason, archive_after, property_id_ref').eq('user_id', compte).eq('book_id', BK).maybeSingle()
    if (a1.code !== 200 || !f1 || f1.archived_manual !== true || f1.pinned !== false || f1.archived_reason !== 'manuel' || f1.property_id_ref !== REF) ko(`archiver : HTTP ${a1.code} ${JSON.stringify(f1)}`)
    else ok('LOT 7 — archive : la ligne porte l etat, et n est PAS epinglee par defaut')
    const a2 = await appeler(messagesApi, { method: 'POST', query: {}, body: { action: 'desarchiver', booking_id: BK }, headers: auth })
    const { data: f2 } = await sb.from('conversation_flags').select('archived_manual, unarchived_manual_at').eq('user_id', compte).eq('book_id', BK).maybeSingle()
    if (a2.code !== 200 || f2.archived_manual !== false || !f2.unarchived_manual_at) ko(`desarchiver : HTTP ${a2.code} ${JSON.stringify(f2)}`)
    else ok('LOT 7 — desarchive : protege jusqu au prochain message')
    await sb.from('conversation_flags').update({ pinned: true }).eq('user_id', compte).eq('book_id', BK)
    const a3 = await appeler(messagesApi, { method: 'POST', query: {}, body: { action: 'archiver', booking_id: BK }, headers: auth })
    if (a3.code !== 409) ko(`un fil epingle s est archive : HTTP ${a3.code}`)
    else ok('LOT 7 — un fil epingle ne s archive pas (409)')
    const g = await appeler(messagesApi, { method: 'GET', query: {}, body: null, headers: auth })
    if (g.code !== 200 || g.body.archivage !== true) ko(`lecture : HTTP ${g.code} archivage=${g.body && g.body.archivage}`)
    else ok('LOT 7 — la lecture calcule l archivage (colonnes du 25 septembre presentes)')
    await anon.auth.signOut()
  } catch (e) {
    ko(`arret : ${e.message}`)
  } finally {
    // ─── Le nettoyage, et sa preuve ────────────────────────────────────────
    const erreurs = []
    const supprimer = async (table, filtre) => {
      let q = sb.from(table).delete()
      for (const [c, v] of Object.entries(filtre)) q = q.eq(c, v)
      const { error } = await q
      if (error) erreurs.push(`${table} : ${error.message}`)
    }
    if (compte) {
      await supprimer('agent_tasks', { user_id: compte, book_id: BK })
      await supprimer('conversation_flags', { user_id: compte, book_id: BK })
      await supprimer('guest_evaluations', { user_id: compte, booking_uid: BK })
      await supprimer('guest_evaluations', { user_id: compte, booking_uid: `${BK}-B` })
      if (nettoyer.fait) await supprimer('menage_done', { user_id: compte, booking_id: BK })
      if (nettoyer.menage) await supprimer('menages', { user_id: compte, booking_id: BK })
      if (nettoyer.snapshot) await supprimer('bookings_snapshot', { user_id: compte, booking_id: BK })
      if (nettoyer.token) await supprimer('public_tokens', { token: JETON })
      if (nettoyer.profil) await supprimer('profiles', { id: nettoyer.profil })
      const restes = []
      for (const [t, c, v] of [['agent_tasks', 'book_id', BK], ['guest_evaluations', 'booking_uid', BK], ['conversation_flags', 'book_id', BK], ['menages', 'booking_id', BK], ['menage_done', 'booking_id', BK], ['bookings_snapshot', 'booking_id', BK], ['public_tokens', 'token', JETON], ['profiles', 'pwa_token', JETON]]) {
        const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).eq(c, v)
        if (count) restes.push(`${t}: ${count}`)
      }
      console.log(`\nNettoyage : ${erreurs.length} erreur(s) · ${restes.length ? 'RESTE ' + restes.join(', ') : '0 ligne restante'}`)
      if (erreurs.length || restes.length) { echecs++; process.exitCode = 1; erreurs.forEach(e => console.error('  ' + e)) }
    }
    console.log(echecs ? `\n${echecs} ECHEC(S).` : '\nOK : les lots 5 a 7 tiennent sur la base STAGING, par les vrais handlers.')
    process.exit(echecs ? 1 : 0)
  }
})()
