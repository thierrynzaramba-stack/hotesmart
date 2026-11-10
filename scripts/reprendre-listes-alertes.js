#!/usr/bin/env node
// scripts/reprendre-listes-alertes.js — PWA lot 2c-3, étape 2.
// Reprend les listes d'`agent_alert_config` en contacts libres et en réglages
// (lib/notifications/reprise-listes.js), compte par compte, VÉRIFIE que
// personne ne perd un destinataire, puis COUPE les listes de ce compte.
// Spec §16.3, Q25, Q29 et Q30 · KB : docs/kb/pwa.md §12.2.
//
// Usage :
//   node --env-file=.env.staging scripts/reprendre-listes-alertes.js              (à blanc)
//   node --env-file=.env.staging scripts/reprendre-listes-alertes.js --go         (écrit)
//   ... --compte=<uuid>          (un seul compte)
//   ... --ignorer-bien=<ref>     (une clé de liste qu'un humain a jugée abandonnée ; répétable)
//
// ⚠ À BLANC PAR DÉFAUT : il dit, par compte, ce qu'il créerait, cocherait et
// couperait, sans adresse en clair (« j***@exemple.fr », « ****78 »), et il
// valide tout ce que le `--go` écrirait.
// ⚠ LA COUPURE SE FAIT COMPTE PAR COMPTE, PAR LA REPRISE ELLE-MÊME : les
// listes du compte sont mises de côté (`listes_reprises`) une fois ses contacts
// et ses réglages écrits. Tout émetteur, quelle que soit sa version, ne trouve
// plus de liste à servir (review de l'étape 2, constats 6 et 7). Jamais de
// trou : un compte bloqué ou arrêté en route GARDE ses listes, et elles
// envoient — au pire en double de ses contacts déjà créés, jusqu'à la relance.
// ⚠ UNE PERTE BLOQUE LE COMPTE : rien n'est écrit pour lui, sortie 1.
// ⚠ `--go` EST REFUSÉ TANT QUE `REPRISE_OUVERTE` EST FAUX
// (lib/notifications/reprise-listes.js) : il s'ouvre à l'étape 4, quand plus
// rien ne peut réécrire une liste (le tiroir Alertes de Messages, le
// préremplissage de l'onboarding). ⚠ ET IL SE LANCE APRÈS LE DÉPLOIEMENT DU LOT
// SUR LA BASE VISÉE, SHA vérifié : une liste coupée là où l'envoi aux contacts
// n'est pas encore déployé ne partirait plus nulle part.
// ⚠ REJOUABLE : un contact identique n'est pas recréé, un canal coché le reste,
// et un compte coupé n'a plus de liste à reprendre.

const { nomDeLaBase } = require('../lib/empreinte-base')
const reprise = require('../lib/notifications/reprise-listes')
const reglagesMod = require('../lib/notifications/reglages')
const contactsMod = require('../lib/notifications/contacts')
const { validerPlages } = require('../lib/notifications/plages')

const PAGE = 100
const PAGE_CONTACTS = 500
const PLAFOND_BIENS = 1000

async function lireConfigs (db, compteVoulu) {
  const lignes = []
  let apres = null
  for (;;) {
    let q = db.from('agent_alert_config').select('user_id, config, updated_at').order('user_id', { ascending: true }).limit(PAGE)
    if (compteVoulu) q = q.eq('user_id', compteVoulu)
    if (apres) q = q.gt('user_id', apres)
    const { data, error } = await q
    if (error) return { ok: false, motif: error.message }
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) break
    apres = data[data.length - 1].user_id
  }
  return { ok: true, lignes }
}

// ⚠ PAR CURSEUR (règle 6 du dépôt, constat 8) : une adresse désinscrite au-delà
// de la millième ligne serait recréée.
async function lireContacts (db, compte) {
  const lignes = []
  let apres = null
  for (;;) {
    let q = db.from('notifications_contacts').select('id, email, telephone, biens, alertes, desinscrit_le')
      .eq('compte_id', compte).order('id', { ascending: true }).limit(PAGE_CONTACTS)
    if (apres) q = q.gt('id', apres)
    const { data, error } = await q
    if (error) return { ok: false }
    lignes.push(...(data || []))
    if (!data || data.length < PAGE_CONTACTS) break
    apres = data[data.length - 1].id
  }
  return { ok: true, lignes }
}

// Le nombre d'appareils abonnés d'une personne : le SMS d'une personne ne part
// que sans appareil (Q11, lib/notifications/envoi.js).
async function compterAppareilsParDefaut ({ userId, db }) {
  const r = await require('../lib/push/abonnements').pourEnvoi({ userId, db })
  return r.ok ? { ok: true, n: r.abonnements.length } : { ok: false }
}

// La personne reçoit-elle aussi les événements d'un AUTRE compte ? Membre
// ailleurs, ou titulaire d'un compte à elle qui en produit : ses réglages
// valent là aussi.
// ⚠ SON PROPRE PROFIL DE TITULAIRE N'EST PAS « AILLEURS » (re-review, R1) :
// chaque utilisateur en a un (`account_user_id = member_user_id = lui`,
// handle_new_user). Le compter faisait de tout membre un membre de deux comptes.
// Son propre compte produit des événements s'il a des biens en table, ou une
// clé Beds24 : le cron traite ses biens depuis Beds24, sans attendre qu'ils
// soient en table. On ne lit de `api_keys` que la présence d'une clé, jamais
// la clé.
async function autresComptesDe ({ userId, compte, db }) {
  const { data: ailleurs, error } = await db.from('profiles').select('account_user_id')
    .eq('member_user_id', userId).eq('access_mode', 'compte').limit(50)
  if (error) return { ok: false }
  if ((ailleurs || []).some(p => p.account_user_id && p.account_user_id !== compte && p.account_user_id !== userId)) return { ok: true, oui: true }
  if (userId === compte) return { ok: true, oui: false }
  const { data: siens, error: e2 } = await db.from('properties').select('id').eq('user_id', userId).limit(1)
  if (e2) return { ok: false }
  if ((siens || []).length) return { ok: true, oui: true }
  const { data: cles, error: e3 } = await db.from('api_keys').select('user_id').eq('user_id', userId).not('api_key', 'is', null).limit(1)
  if (e3) return { ok: false }
  return { ok: true, oui: (cles || []).length > 0 }
}

// Une config comparable : les clés triées, à toute profondeur.
function canonique (v) {
  if (Array.isArray(v)) return `[${v.map(canonique).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonique(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

async function repriseDuCompte ({ compte, db, go, ignores, destinataires, ecrire, planifier,
  compterAppareils = compterAppareilsParDefaut, maintenant = () => new Date().toISOString() }) {
  // ⚠ RELUE ICI, pas au départ du script (re-review, R3) : les comptes passent
  // les uns après les autres, et une config lue au départ a eu le temps de
  // changer — la coupure serait alors refusée APRÈS la création des contacts.
  const { data: ligneConfig, error: eL } = await db.from('agent_alert_config').select('config, updated_at').eq('user_id', compte).maybeSingle()
  if (eL) return { ok: false, motif: 'listes_illisibles' }
  const config = ligneConfig && ligneConfig.config
  const majLe = (ligneConfig && ligneConfig.updated_at) ?? null
  const lignes = reprise.lignesDeLaConfig(config)
  if (!lignes.length) return { ok: true, vide: true }
  const refs = [...new Set(lignes.map(l => l.ref))]
  const { data: props, error: eP } = await db.from('properties').select('id, provider_property_id, archive_le')
    .eq('user_id', compte).limit(PLAFOND_BIENS)
  if (eP) return { ok: false, motif: 'biens_illisibles' }
  if ((props || []).length >= PLAFOND_BIENS) return { ok: false, motif: 'trop_de_biens' }
  const biensParRef = new Map()
  // Une clé de liste est une référence provider, ou l'id du bien quand il n'en
  // avait pas (`seedAlertConfig` : `provider_property_id || id` ; re-review, R2).
  for (const ref of refs) {
    let l = (props || []).filter(p => p.provider_property_id != null && String(p.provider_property_id) === ref)
    if (!l.length) l = (props || []).filter(p => String(p.id) === ref)
    const choisi = l.find(p => !p.archive_le) || l[0]
    if (choisi) biensParRef.set(ref, String(choisi.id))
  }
  // Les biens où un événement peut naître : les actifs, et ceux que vise une liste.
  const refDuBien = new Map()
  for (const p of props || []) {
    if (!p.archive_le || [...biensParRef.values()].includes(String(p.id))) refDuBien.set(String(p.id), p.provider_property_id == null ? null : String(p.provider_property_id))
  }

  const { data: profils, error: eF } = await db.from('profiles').select('member_user_id, is_owner, email, phone, notify_email, notify_sms')
    .eq('account_user_id', compte).eq('access_mode', 'compte')
  if (eF) return { ok: false, motif: 'profils_illisibles' }
  // Les coordonnées et les permis de chacun, lus comme le point d'envoi les lit
  // (contactsDe, destinataires.js).
  const coordonnees = (p) => ({ email: (p && p.email) || null, telephone: (p && p.phone) || null,
    emailPermis: !p || p.notify_email !== false, smsPermis: !p || p.notify_sms !== false })
  const personnes = [{ userId: compte, titulaire: true, ...coordonnees((profils || []).find(p => p.is_owner === true)) }]
  for (const p of profils || []) {
    if (p.is_owner === true) continue
    if (p.member_user_id && p.member_user_id !== compte && !personnes.some(x => x.userId === p.member_user_id)) {
      personnes.push({ userId: p.member_user_id, titulaire: false, ...coordonnees(p) })
    }
  }
  for (const p of personnes) {
    const c = await compterAppareils({ userId: p.userId, db })
    if (!c || !c.ok) return { ok: false, motif: 'appareils_illisibles' }
    p.appareils = c.n
    const a = await autresComptesDe({ userId: p.userId, compte, db })
    if (!a.ok) return { ok: false, motif: 'profils_illisibles' }
    p.autresComptes = a.oui
  }

  // Les droits de chacun, par la règle du point d'envoi (destinataires.js), avec
  // le bien tel que les émetteurs le passent : son id ET sa référence (constat 3).
  const memo = new Map()
  for (const code of Object.values(contactsMod.ALERTES).flat()) {
    for (const [bienId, ref] of refDuBien) {
      const r = await destinataires({ compte, code, bien: { id: bienId, ref }, db })
      if (!r || !r.ok) return { ok: false, motif: 'droits_illisibles' }
      memo.set(`${code}|${bienId}`, new Set(r.personnes.map(p => p.userId)))
    }
  }
  const destinataire = (userId, code, bienId) => (memo.get(`${code}|${bienId}`) || new Set()).has(userId)
  const ids = personnes.map(p => p.userId)
  const lus = await reglagesMod.lirePlusieurs({ userIds: ids, db })
  if (!lus.ok) return { ok: false, motif: 'reglages_illisibles' }
  const { data: bruts, error: eR } = await db.from('notifications_reglages').select('user_id, evenements, plages').in('user_id', ids)
  if (eR) return { ok: false, motif: 'reglages_illisibles' }
  const existants = await lireContacts(db, compte)
  if (!existants.ok) return { ok: false, motif: 'contacts_illisibles' }

  const plan = planifier({ lignes, biensParRef, biensDuCompte: [...refDuBien.keys()], ignores, personnes, destinataire,
    reglages: lus.parPersonne, existants: existants.lignes })
  const titulaireOuMembre = (u) => (u === compte ? 'titulaire' : 'membre')
  ecrire(`Compte ${String(compte).slice(0, 8)}… : ${lignes.length} adresse(s) de liste, ${plan.contacts.length} contact(s) à créer, `
    + `${plan.dejaPresents} déjà présent(s), réglages cochés pour ${plan.cocher.size} personne(s)`
    + `${plan.cocher.size ? ` (${[...plan.cocher.keys()].map(titulaireOuMembre).join(', ')})` : ''}`
    + `${plan.ignores.length ? `, bien(s) ignoré(s) sur décision : ${plan.ignores.join(', ')}` : ''}.`)
  for (const c of plan.contacts) {
    ecrire(`  + ${c.email ? reprise.masquer('email', c.email) : reprise.masquer('sms', c.telephone)} — ${c.alertes.join(' + ')}, ${c.biens.length} bien(s)`)
  }
  // Ce qui change de forme sans se perdre se dit aussi.
  if (plan.parNotification) ecrire(`  · ${plan.parNotification} envoi(s) SMS de liste deviennent une notification sur l'appareil de la personne (Q11).`)
  if (plan.enPlus) ecrire(`  · ${plan.enPlus} envoi(s) EN PLUS : un canal coché vaut pour tous les biens du compte, une liste valait pour un bien.`)
  if (plan.ecartes || plan.desinscrits) ecrire(`  · adresse(s) désinscrite(s) : ${plan.ecartes} contact(s) non recréé(s), ${plan.desinscrits} envoi(s) qui ne partiront plus (leur choix).`)
  if (plan.pertes.length) {
    ecrire(`  ⚠ ${plan.pertes.length} perte(s) : rien n'est écrit pour ce compte, ses listes restent en service.`)
    for (const p of plan.pertes.slice(0, 10)) ecrire(`    - ${reprise.masquer(p.canal, p.valeur)} ${p.canal}, ${p.code}${p.ref ? `, bien ${p.ref}` : ''} : ${p.motif}`)
    return { ok: false, motif: 'pertes', pertes: plan.pertes.length }
  }

  // ⚠ TOUT SE VALIDE AVANT LA PREMIÈRE ÉCRITURE, à blanc compris (constat 6) :
  // un `--go` qui échouerait au milieu se voit à blanc.
  const brutsParId = new Map((bruts || []).map(b => [b.user_id, b]))
  const aEcrire = []
  for (const [userId, cles] of plan.cocher) {
    const brut = brutsParId.get(userId) || {}
    const evenements = { ...((brut.evenements && typeof brut.evenements === 'object' && !Array.isArray(brut.evenements)) ? brut.evenements : {}) }
    // ⚠ L'ÉTAT D'APRÈS DU PLAN, tel quel (constat 1) : il cumule les canaux.
    for (const cle of cles) { const code = cle.split('|')[0]; evenements[code] = { ...plan.reglagesApres.get(userId)[code] } }
    const plages = Array.isArray(brut.plages) ? brut.plages : []
    if (!reglagesMod.validerEvenements(evenements).ok || !validerPlages(plages).ok) {
      ecrire(`  ⚠ réglages d'un(e) ${titulaireOuMembre(userId)} non réécrivables tels quels : rien n'est écrit pour ce compte.`)
      return { ok: false, motif: 'reglages_invalides' }
    }
    aEcrire.push({ userId, evenements, plages })
  }
  for (const c of plan.contacts) {
    const v = contactsMod.validerContact(c)
    // ⚠ L'ADRESSE QUI BLOQUE SE NOMME (masquée), avec son motif : une liste
    // peut porter une adresse que l'ancien envoi acceptait et que le contact
    // refuse (« Jean <jean@…> », un « ; » final) — c'est à corriger dans la
    // liste avant le --go (troisième review de l'étape 3, constat 1).
    if (!v.ok) {
      const adresse = c.email ? reprise.masquer('email', c.email) : reprise.masquer('sms', c.telephone)
      ecrire(`  ⚠ contact non valide (${v.motif}) : ${adresse} — à corriger dans la liste ; rien n'est écrit pour ce compte, ses listes restent en service.`)
      return { ok: false, motif: 'contact_invalide' }
    }
  }
  if (!go) { ecrire('  · listes de ce compte : seraient coupées.'); return { ok: true, plan } }

  // L'ordre : les contacts (une seule écriture), les réglages, puis la coupure.
  // Tant que la coupure n'est pas faite, les listes envoient : un arrêt en route
  // ne laisse aucun trou, et un second passage reprend où on s'est arrêté.
  // ⚠ UN ARRÊT APRÈS LA CRÉATION DES CONTACTS ET AVANT LA COUPURE fait recevoir
  // en DOUBLE (la liste et le contact) jusqu'à la relance — jamais rien de
  // perdu. Le message le dit (re-review, R3).
  const doublon = plan.contacts.length ? ' — contacts déjà créés : doubles envois jusqu\'à la relance' : ''
  if (plan.contacts.length) {
    const r = await contactsMod.creerContacts({ compte, contacts: plan.contacts, db })
    if (!r.ok) return { ok: false, motif: `contacts_non_ecrits (${r.motif}) — listes toujours en service, relancer` }
  }
  for (const w of aEcrire) {
    const r = await reglagesMod.enregistrer({ userId: w.userId, evenements: w.evenements, plages: w.plages, db })
    if (!r.ok) return { ok: false, motif: `reglages_non_ecrits (${r.motif}) — listes toujours en service, relancer${doublon}` }
  }
  // ⚠ LA COUPURE NE PASSE QUE SI LA CONFIG N'A PAS CHANGÉ depuis sa lecture :
  // sinon on couperait une liste que le plan n'a pas reprise. `updated_at` ne
  // suffit pas — aucun trigger ne le tient, et un transfert de bien réécrit la
  // config sans le toucher (re-review, R4) : le contenu se compare aussi.
  const { data: relue, error: eR2 } = await db.from('agent_alert_config').select('config, updated_at').eq('user_id', compte).maybeSingle()
  if (eR2 || !relue) return { ok: false, motif: `coupure_impossible — listes toujours en service, relancer${doublon}` }
  if (canonique(relue.config) !== canonique(config) || (relue.updated_at ?? null) !== majLe) {
    return { ok: false, motif: `config_modifiee_entre_temps — listes toujours en service, relancer${doublon}` }
  }
  const le = maintenant()
  let q = db.from('agent_alert_config').update({ config: reprise.mettreDeCote(config, le), updated_at: le }).eq('user_id', compte)
  q = majLe == null ? q.is('updated_at', null) : q.eq('updated_at', majLe)
  const { data: coupe, error: eU } = await q.select('user_id')
  if (eU) return { ok: false, motif: `coupure_impossible — listes toujours en service, relancer${doublon}` }
  if (!coupe || coupe.length !== 1) return { ok: false, motif: `config_modifiee_entre_temps — listes toujours en service, relancer${doublon}` }
  ecrire('  · listes de ce compte coupées (gardées dans listes_reprises).')
  return { ok: true, plan, ecrit: true }
}

async function executer ({ argv = [], db, base = 'INCONNUE', repriseOuverte, destinataires, ecrire = console.log,
  planifier = reprise.planifier, compterAppareils = compterAppareilsParDefaut, maintenant }) {
  const go = argv.includes('--go')
  const compteVoulu = (argv.find(a => a.startsWith('--compte=')) || '').slice(9) || null
  const ignores = new Set(argv.filter(a => a.startsWith('--ignorer-bien=')).map(a => a.slice(15)).filter(Boolean))
  if (go && repriseOuverte !== true) {
    ecrire('Refusé : la reprise n\'est pas ouverte (REPRISE_OUVERTE, lib/notifications/reprise-listes.js). '
      + 'Elle s\'ouvre à l\'étape 4, quand plus rien ne peut réécrire une liste.')
    return 2
  }
  ecrire(`Base : ${base}. ${go ? 'ÉCRITURE — après le déploiement du lot sur cette base, SHA vérifié.' : 'À blanc : rien ne sera écrit.'}`)
  const c = await lireConfigs(db, compteVoulu)
  if (!c.ok) { ecrire(`Lecture des listes impossible : ${c.motif}`); return 1 }
  let code = 0
  let comptes = 0
  for (const row of c.lignes) {
    // La ligne lue ici ne sert qu'à trouver les comptes : chacun relit la sienne.
    if (!reprise.lignesDeLaConfig(row.config).length) continue
    const r = await repriseDuCompte({ compte: row.user_id, db, go, ignores,
      destinataires, ecrire, planifier, compterAppareils, ...(maintenant ? { maintenant } : {}) })
    if (r.vide) continue
    comptes++
    if (!r.ok) { code = 1; if (r.motif !== 'pertes') ecrire(`Compte ${String(row.user_id).slice(0, 8)}… : arrêt (${r.motif}).`) }
  }
  ecrire(`${comptes} compte(s) avec des listes actives.${code ? ' ⚠ Au moins un compte n\'a pas été repris : ses listes restent en service.' : ''}`)
  return code
}

if (require.main === module) {
  const URL = process.env.SUPABASE_URL
  const KEY = process.env.SUPABASE_SERVICE_KEY
  if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
  // ⚠ UNE BASE NON RECONNUE EST REFUSÉE (lib/empreinte-base.js).
  const base = nomDeLaBase(URL)
  if (base === 'INCONNUE') { console.error('Base non reconnue : refus.'); process.exit(1) }
  const db = require('@supabase/supabase-js').createClient(URL, KEY)
  executer({
    argv: process.argv.slice(2), db, base,
    repriseOuverte: reprise.REPRISE_OUVERTE,
    destinataires: require('../lib/notifications/destinataires').destinataires
  }).then(c => process.exit(c)).catch(e => { console.error(e.message); process.exit(1) })
}

module.exports = { executer, repriseDuCompte }
