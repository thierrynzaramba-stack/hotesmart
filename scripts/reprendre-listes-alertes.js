#!/usr/bin/env node
// scripts/reprendre-listes-alertes.js — PWA lot 2c-3, étape 2.
// Reprend les listes d'`agent_alert_config` en contacts libres et en réglages
// (lib/notifications/reprise-listes.js), compte par compte, et VÉRIFIE que
// personne ne perd un destinataire. Spec §16.3, Q25 et Q29 · KB : docs/kb/pwa.md §12.2.
//
// Usage :
//   node --env-file=.env.staging scripts/reprendre-listes-alertes.js              (à blanc)
//   node --env-file=.env.staging scripts/reprendre-listes-alertes.js --go         (écrit)
//   ... --compte=<uuid>   (un seul compte)
//
// ⚠ À BLANC PAR DÉFAUT : il dit, par compte, ce qu'il créerait et cocherait,
// sans afficher une adresse en clair (« j***@exemple.fr », « +336****5678 »).
// ⚠ `--go` EST REFUSÉ TANT QUE LES ANCIENNES LISTES ENVOIENT ENCORE (review de
// l'étape 1, constat 4) : chaque adresse reprise recevrait tout en double, une
// fois par sa liste et une fois par son contact. Les listes se coupent à
// l'étape 4 (`LISTES_COUPEES`, lib/alert-notify.js) ; la reprise et la coupure
// partent dans le même déploiement.
// ⚠ UNE PERTE BLOQUE LE COMPTE : si la vérification trouve un (canal, adresse,
// bien, événement) que la liste délivrait et que la reprise ne délivrerait
// plus, rien n'est écrit pour ce compte, et la sortie est 1.
// ⚠ REJOUABLE : un contact identique déjà en base n'est pas recréé, et un canal
// déjà coché reste coché. Les listes, elles, ne sont pas touchées.

const { nomDeLaBase } = require('../lib/empreinte-base')
const reprise = require('../lib/notifications/reprise-listes')
const reglagesMod = require('../lib/notifications/reglages')

const PAGE = 100

async function lireConfigs (db, compteVoulu) {
  const lignes = []
  let apres = null
  for (;;) {
    let q = db.from('agent_alert_config').select('user_id, config').order('user_id', { ascending: true }).limit(PAGE)
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

// Le nombre d'appareils abonnés d'une personne : le SMS d'une personne ne part
// que sans appareil (Q11, lib/notifications/envoi.js).
async function compterAppareilsParDefaut ({ userId, db }) {
  const r = await require('../lib/push/abonnements').pourEnvoi({ userId, db })
  return r.ok ? { ok: true, n: r.abonnements.length } : { ok: false }
}

async function repriseDuCompte ({ compte, config, db, go, destinataires, ecrire, planifier, compterAppareils = compterAppareilsParDefaut }) {
  const lignes = reprise.lignesDeLaConfig(config)
  if (!lignes.length) return { ok: true, vide: true }
  const refs = [...new Set(lignes.map(l => l.ref))]
  const { data: props, error: eP } = await db.from('properties').select('id, provider_property_id, archive_le')
    .eq('user_id', compte).in('provider_property_id', refs)
  if (eP) return { ok: false, motif: 'biens_illisibles' }
  const biensParRef = new Map()
  for (const ref of refs) {
    const l = (props || []).filter(p => String(p.provider_property_id) === ref)
    const choisi = l.find(p => !p.archive_le) || l[0]
    if (choisi) biensParRef.set(ref, String(choisi.id))
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
  }
  // Les droits de chacun, par la règle du point d'envoi (destinataires.js).
  const memo = new Map()
  let pannes = 0
  for (const code of Object.values(require('../lib/notifications/contacts').ALERTES).flat()) {
    for (const bienId of new Set(biensParRef.values())) {
      const r = await destinataires({ compte, code, bien: { id: bienId }, db })
      if (!r.ok) { pannes++; continue }
      memo.set(`${code}|${bienId}`, new Set(r.personnes.map(p => p.userId)))
    }
  }
  if (pannes) return { ok: false, motif: 'droits_illisibles' }
  const destinataire = (userId, code, bienId) => (memo.get(`${code}|${bienId}`) || new Set()).has(userId)
  const ids = personnes.map(p => p.userId)
  const lus = await reglagesMod.lirePlusieurs({ userIds: ids, db })
  if (!lus.ok) return { ok: false, motif: 'reglages_illisibles' }
  const { data: bruts, error: eR } = await db.from('notifications_reglages').select('user_id, evenements, plages').in('user_id', ids)
  if (eR) return { ok: false, motif: 'reglages_illisibles' }
  const { data: existants, error: eC } = await db.from('notifications_contacts')
    .select('email, telephone, biens, alertes, desinscrit_le').eq('compte_id', compte)
  if (eC) return { ok: false, motif: 'contacts_illisibles' }

  const plan = planifier({ lignes, biensParRef, personnes, destinataire, reglages: lus.parPersonne, existants: existants || [] })
  const titulaireOuMembre = (u) => (u === compte ? 'titulaire' : 'membre')
  ecrire(`Compte ${String(compte).slice(0, 8)}… : ${lignes.length} adresse(s) de liste, ${plan.contacts.length} contact(s) à créer, `
    + `${plan.dejaPresents} déjà présent(s), réglages cochés pour ${plan.cocher.size} personne(s)`
    + `${plan.cocher.size ? ` (${[...plan.cocher.keys()].map(titulaireOuMembre).join(', ')})` : ''}`
    + `${plan.inconnus.length ? `, bien(s) introuvable(s) : ${plan.inconnus.join(', ')}` : ''}.`)
  for (const c of plan.contacts) {
    ecrire(`  + ${c.email ? reprise.masquer('email', c.email) : reprise.masquer('sms', c.telephone)} — ${c.alertes.join(' + ')}, ${c.biens.length} bien(s)`)
  }
  // Ce qui change de forme sans se perdre se dit aussi : un SMS de liste vers
  // une personne qui a un appareil devient sa notification (Q11).
  if (plan.parNotification) ecrire(`  · ${plan.parNotification} envoi(s) SMS de liste deviennent une notification sur l'appareil de la personne (Q11).`)
  if (plan.ecartes || plan.desinscrits) ecrire(`  · adresse(s) désinscrite(s) : ${plan.ecartes} contact(s) non recréé(s), ${plan.desinscrits} envoi(s) qui ne partiront plus (leur choix).`)
  if (plan.pertes.length) {
    ecrire(`  ⚠ ${plan.pertes.length} perte(s) : rien n'est écrit pour ce compte.`)
    for (const p of plan.pertes.slice(0, 10)) ecrire(`    - ${reprise.masquer(p.canal, p.valeur)} ${p.canal}, ${p.code} : ${p.motif}`)
    return { ok: false, motif: 'pertes', pertes: plan.pertes.length }
  }
  if (!go) return { ok: true, plan }

  // Les réglages d'abord : un canal coché ne se perd pas si la création des
  // contacts échoue, et un second passage reprend là où on s'est arrêté.
  const brutsParId = new Map((bruts || []).map(b => [b.user_id, b]))
  for (const [userId, cles] of plan.cocher) {
    const brut = brutsParId.get(userId) || {}
    const evenements = { ...((brut.evenements && typeof brut.evenements === 'object') ? brut.evenements : {}) }
    const effectif = lus.parPersonne.get(userId) || reglagesMod.effectifs(null)
    for (const cle of cles) {
      const [code, canal] = cle.split('|')
      // L'effectif de l'événement (sa ligne par-dessus les défauts), canal coché.
      evenements[code] = { ...effectif.evenements[code], [canal]: true }
    }
    const r = await reglagesMod.enregistrer({ userId, evenements, plages: Array.isArray(brut.plages) ? brut.plages : [], db })
    if (!r.ok) return { ok: false, motif: `reglages_non_ecrits (${r.motif})` }
  }
  if (plan.contacts.length) {
    const lignesContacts = plan.contacts.map(c => ({ compte_id: compte, nom: c.nom, email: c.email, telephone: c.telephone, biens: c.biens, alertes: c.alertes }))
    const { error } = await db.from('notifications_contacts').insert(lignesContacts)
    if (error) return { ok: false, motif: 'contacts_non_ecrits' }
  }
  return { ok: true, plan, ecrit: true }
}

async function executer ({ argv = [], db, base = 'INCONNUE', listesCoupees, destinataires, ecrire = console.log, planifier = reprise.planifier, compterAppareils = compterAppareilsParDefaut }) {
  const go = argv.includes('--go')
  const compteVoulu = (argv.find(a => a.startsWith('--compte=')) || '').slice(9) || null
  if (go && listesCoupees !== true) {
    ecrire('Refusé : les anciennes listes envoient encore (lib/alert-notify.js, LISTES_COUPEES). '
      + 'Les reprendre maintenant ferait tout recevoir en double : la reprise part avec la coupure (étape 4).')
    return 2
  }
  ecrire(`Base : ${base}. ${go ? 'ÉCRITURE.' : 'À blanc : rien ne sera écrit.'}`)
  const c = await lireConfigs(db, compteVoulu)
  if (!c.ok) { ecrire(`Lecture des listes impossible : ${c.motif}`); return 1 }
  let code = 0
  let comptes = 0
  for (const row of c.lignes) {
    const r = await repriseDuCompte({ compte: row.user_id, config: row.config, db, go, destinataires, ecrire, planifier, compterAppareils })
    if (r.vide) continue
    comptes++
    if (!r.ok) { code = 1; if (r.motif !== 'pertes') ecrire(`Compte ${String(row.user_id).slice(0, 8)}… : arrêt (${r.motif}).`) }
  }
  ecrire(`${comptes} compte(s) avec des listes actives.${code ? ' ⚠ Au moins un compte n\'a pas été repris.' : ''}`)
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
    listesCoupees: require('../lib/alert-notify').LISTES_COUPEES,
    destinataires: require('../lib/notifications/destinataires').destinataires
  }).then(c => process.exit(c)).catch(e => { console.error(e.message); process.exit(1) })
}

module.exports = { executer, repriseDuCompte }
