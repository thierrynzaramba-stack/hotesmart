#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// scripts/recette-charges.js — RECETTE DU SOCLE DU COMPTE DE CHARGES SUR STAGING
// Spec : docs/specs/spec-compte-de-charges.md (lot 2) ; KB : docs/kb/compte-de-charges.md
//
// Ce que la recette SQL (`recette-charges-base.sql`) ne pouvait pas toucher :
// le stockage, la lecture par l'IA, le writer `lib/charges.js` tel que
// l'endpoint l'appelle, et un passage réel de `api/cron-charges.js` — staging
// n'a pas de cron, et il n'y a pas d'écran avant le lot 3.
//
// Usage, depuis un arbre qui contient le lot (et ses node_modules) :
//   node --env-file=.env.staging scripts/recette-charges.js
//        → liste les comptes de staging, vérifie les prérequis, n'écrit rien
//   node --env-file=.env.staging scripts/recette-charges.js --compte=<uuid>
//        → à blanc pour ce compte : ce qui sera fait, rien n'est écrit
//   node --env-file=.env.staging scripts/recette-charges.js --compte=<uuid> --go
//        → la recette (2 lectures IA, une attente de 2 minutes, un passage
//          du cron), puis l'effacement de tout ce qu'elle a créé
//
// ⚠ STAGING SEULEMENT, et sans option pour passer outre : une recette écrit,
// lit par l'IA et lance un passage du cron. En production, le cron tourne déjà.
//
// ⚠ RIEN NE RESTE : chaque charge créée est supprimée par le writer (ligne et
// fichier) dans un `finally`, même si une étape échoue. Seules restent les
// traces que le système garde de toute façon : les lignes `ia_appels` des
// lectures, et la mesure du passage dans `cron_stats`.
//
// ⚠ AUCUN SECRET N'EST AFFICHÉ : des variables d'environnement, on dit
// seulement si elles sont présentes.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto')
const { nomDeLaBase } = require('../lib/empreinte-base')

const ATTENTE_CRON_MS = 125 * 1000 // la file du cron ignore ce qui a bougé il y a < 2 min
const TTC_ATTENDU = 12000

// ─── Un PDF de recette, construit à la main ─────────────────────────────────
/**
 * Un PDF d'une page, en Helvetica, avec les lignes données (ASCII). Les
 * offsets de la table `xref` sont calculés : un PDF dont la table ment est lu
 * par certains lecteurs et refusé par d'autres.
 */
function pdfDeRecette (lignes) {
  const echappe = (t) => String(t).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')
  const texte = ['BT', '/F1 12 Tf', '50 780 Td', '16 TL']
    .concat(lignes.map((l, i) => (i === 0 ? '' : 'T* ') + `(${echappe(l)}) Tj`))
    .concat(['ET']).join('\n')
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(texte, 'latin1')} >>\nstream\n${texte}\nendstream`
  ]
  let corps = '%PDF-1.4\n'
  const offsets = []
  objets.forEach((o, i) => {
    offsets.push(Buffer.byteLength(corps, 'latin1'))
    corps += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const debutXref = Buffer.byteLength(corps, 'latin1')
  corps += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`
  corps += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  corps += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${debutXref}\n%%EOF\n`
  return Buffer.from(corps, 'latin1')
}

function factureDeRecette ({ numero, ht, tva, ttc, marque }) {
  return pdfDeRecette([
    'FACTURE',
    'Fournisseur : Recette Energie SARL',
    `Facture n : ${numero}`,
    'Date de facture : 03/11/2026',
    'Client : compte de recette HoteSmart',
    'Electricite - periode du 01/10/2026 au 31/10/2026',
    `Total HT : ${ht} EUR`,
    `TVA 20 % : ${tva} EUR`,
    `Total TTC : ${ttc} EUR`,
    'DOCUMENT DE RECETTE HOTESMART - NE PAS PAYER',
    `Reference de recette : ${marque}`
  ])
}

/** La garde de base : STAGING, sinon un refus avec sa raison. */
function refusDeBase (url) {
  const base = nomDeLaBase(url)
  if (base === 'STAGING') return null
  return `REFUS : cette recette ne tourne que sur STAGING (base lue : ${base}).`
}

// ─── Le déroulé ─────────────────────────────────────────────────────────────
async function principal () {
  const URL = process.env.SUPABASE_URL
  const KEY = process.env.SUPABASE_SERVICE_KEY
  if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
  const base = nomDeLaBase(URL)
  console.log(`Base : ${base}`)
  // ⚠ LA GARDE, AVANT TOUTE LECTURE : staging, et rien d'autre.
  if (base !== 'STAGING') { console.error(refusDeBase(URL)); process.exit(1) }

  const args = process.argv.slice(2)
  const GO = args.includes('--go')
  const compte = (args.find(a => a.startsWith('--compte=')) || '').slice(9) || null

  const { createClient } = require('@supabase/supabase-js')
  const db = createClient(URL, KEY)
  const charges = require('../lib/charges')
  const { BUCKET } = require('../lib/charges/regles')

  console.log(`Clé de l'IA (CLAUDE_API_KEY) : ${process.env.CLAUDE_API_KEY ? 'présente' : 'ABSENTE'}`)
  console.log(`CRON_SECRET : ${process.env.CRON_SECRET ? 'présent' : 'absent (un secret local au processus sera utilisé)'}`)

  // Prérequis : la table, le bucket.
  const { error: eTable } = await db.from('charges').select('id', { count: 'exact', head: true })
  if (eTable) { console.error(`✘ table charges illisible : ${eTable.message}`); process.exit(1) }
  const { data: bucket, error: eBucket } = await db.storage.getBucket(BUCKET)
  if (eBucket || !bucket) { console.error(`✘ bucket ${BUCKET} absent`); process.exit(1) }
  console.log(`Bucket ${BUCKET} : ${bucket.public ? 'PUBLIC ⚠' : 'privé'}`)

  if (!compte) {
    // Sans compte : la liste des comptes de staging, pour choisir.
    const { data: biens, error } = await db.from('properties').select('user_id').limit(1000)
    if (error) { console.error(`✘ properties illisible : ${error.message}`); process.exit(1) }
    const parCompte = {}
    for (const b of biens || []) parCompte[b.user_id] = (parCompte[b.user_id] || 0) + 1
    console.log('\nComptes de staging (logements) :')
    for (const [id, n] of Object.entries(parCompte)) {
      const { data: u } = await db.auth.admin.getUserById(id)
      const { entites } = await require('../lib/entites-juridiques').entitesDuCompte(id, { db })
      const actives = (entites || []).filter(e => !e.archivee_le).length
      console.log(`  ${id}  ${(u && u.user && u.user.email) || '?'}  ${n} logement(s), ${actives} entité(s) active(s)`)
    }
    console.log('\nRelancer avec --compte=<uuid> (à blanc), puis --compte=<uuid> --go.')
    return 0
  }

  const { data: u, error: eU } = await db.auth.admin.getUserById(compte)
  if (eU || !u || !u.user) { console.error('✘ compte introuvable sur staging'); process.exit(1) }
  const ent = await require('../lib/entites-juridiques').entitesDuCompte(compte, { db })
  if (!ent.ok) { console.error('✘ entités illisibles (panne)'); process.exit(1) }
  const entite = (ent.entites || []).find(e => !e.archivee_le) || null
  console.log(`Compte : ${u.user.email}`)
  console.log(`Entité active : ${entite ? entite.nom : 'AUCUNE — la validation sera vérifiée en refus seulement'}`)

  if (!GO) {
    console.log('\nÀ BLANC. Avec --go, la recette :')
    console.log('  1. envoie une facture PDF de recette (URL signée), la confirme, la fait lire par l\'IA ;')
    console.log('  2. vérifie la cellule du résumé, puis la consultation par URL de 60 s ;')
    console.log('  3. renvoie le même fichier : il doit être regroupé en doublon, jamais refusé ;')
    console.log('  4. valide la facture (avec l\'entité active, sinon vérifie le refus) ;')
    console.log('  5. supprime le doublon : la première perd son signal ;')
    console.log('  6. prépare un envoi abandonné (vieilli de 25 h) et une facture laissée en attente ;')
    console.log('  7. attend 2 minutes, lance UN passage de api/cron-charges : purge, recalcul, lecture ;')
    console.log('  8. efface tout ce qu\'elle a créé (lignes et fichiers), et le vérifie.')
    console.log('Coût : 2 lectures IA (Haiku), environ 2 minutes 30.')
    return 0
  }

  // ─── La recette ──────────────────────────────────────────────────────────
  const marque = new Date().toISOString()
  const crees = new Set()
  const resultats = []
  const verifier = (nom, ok, detail = '') => {
    resultats.push({ nom, ok })
    console.log(`${ok ? '✔' : '✘'} ${nom}${detail ? ` — ${detail}` : ''}`)
    return ok
  }
  const ignorer = (nom, raison) => { resultats.push({ nom, ok: null }); console.log(`· ${nom} — non vérifié : ${raison}`) }

  async function envoyer (pdf) {
    const o = await charges.ouvrirEnvoi(db, { compte, type: 'application/pdf', octets: pdf.length })
    if (!o.ok) throw new Error(`ouvrirEnvoi : ${o.statut} ${o.code}`)
    crees.add(o.id)
    const { error } = await db.storage.from(BUCKET).uploadToSignedUrl(`${compte}/${o.id}`, o.jeton, pdf, { contentType: 'application/pdf' })
    if (error) throw new Error(`envoi au stockage : ${error.message}`)
    return o.id
  }
  async function lire (id) {
    const { data } = await db.from('charges').select('id, statut, motif, montant_ttc_cents, montant_ht_cents, fournisseur_nom, numero_facture, jour, entite_juridique_id, bien_id, signal, groupe_doublon, justificatif_chemin')
      .eq('id', id).eq('user_id', compte).maybeSingle()
    return data
  }

  const pdf1 = factureDeRecette({ numero: 'RE-2026-001', ht: '100,00', tva: '20,00', ttc: '120,00', marque })
  const pdf2 = factureDeRecette({ numero: 'RE-2026-002', ht: '37,50', tva: '7,50', ttc: '45,00', marque })
  const pdf3 = factureDeRecette({ numero: 'RE-2026-003', ht: '10,00', tva: '2,00', ttc: '12,00', marque })

  let code = 0
  try {
    // 1. Envoi, confirmation, lecture tout de suite (le chemin de l'endpoint).
    const id1 = await envoyer(pdf1)
    const c1 = await charges.confirmerEnvoi(db, { compte, id: id1 })
    verifier('1a envoi confirmé, type relu dans le fichier', c1.ok && c1.type === 'application/pdf' && c1.charge.statut === 'a_lire',
      c1.ok ? 'a_lire' : `${c1.statut} ${c1.code}`)
    const autorise = await charges.lectureAutorisee(db, compte)
    verifier('1b garde de coût lisible et sous le plafond', autorise === true)
    const { lireDocument } = require('../lib/charges/lecture')
    const lu1 = await lireDocument({ octets: pdf1, type: 'application/pdf', compte })
    const a1 = await charges.appliquerLecture(db, { compte, id: id1, resultat: lu1 })
    const l1 = await lire(id1)
    verifier('1c lecture IA appliquée', a1.ok && l1 && l1.statut === 'a_verifier',
      lu1.panne ? `PANNE ${lu1.motif}` : lu1.echec ? `ÉCHEC ${lu1.motif}` : `${l1 && l1.fournisseur_nom} · n° ${l1 && l1.numero_facture}`)
    verifier('1d montant TTC lu = 120,00 €', l1 && l1.montant_ttc_cents === TTC_ATTENDU, `lu : ${l1 && l1.montant_ttc_cents}`)

    // 2. Le résumé, tenu par le trigger ; la consultation.
    if (l1) {
      let q = db.from('charges_resume').select('ttc_cents, nb_factures, nb_non_verifiees, calcule_le')
        .eq('user_id', compte).eq('jour', l1.jour)
      q = l1.entite_juridique_id ? q.eq('entite_juridique_id', l1.entite_juridique_id) : q.is('entite_juridique_id', null)
      q = l1.bien_id ? q.eq('bien_id', l1.bien_id) : q.is('bien_id', null)
      const { data: cellule } = await q.maybeSingle()
      verifier('2a cellule du résumé à jour dès l\'écriture', !!cellule && cellule.nb_factures >= 1 && Number(cellule.ttc_cents) >= Number(l1.montant_ttc_cents || 0) && cellule.nb_non_verifiees >= 1,
        cellule ? `jour ${l1.jour}, TTC ${cellule.ttc_cents}, ${cellule.nb_factures} facture(s)` : 'cellule absente')
    }
    const url = await charges.urlConsultation(db, { compte, id: id1 })
    let octetsLus = null
    if (url.ok) { const rep = await fetch(url.url); octetsLus = rep.ok ? Buffer.from(await rep.arrayBuffer()) : null }
    verifier('2b consultation : URL de 60 s, le fichier rendu est le bon', url.ok && url.expire_dans_s === 60 && !!octetsLus && octetsLus.equals(pdf1))

    // 3. Le même fichier, renvoyé : regroupé, jamais refusé (Q14).
    const id2 = await envoyer(pdf1)
    const c2 = await charges.confirmerEnvoi(db, { compte, id: id2 })
    const l2 = await lire(id2)
    const l1b = await lire(id1)
    verifier('3 même fichier : regroupé en doublon sur la première', c2.ok && l2 && l2.groupe_doublon === id1 && l2.signal === 'doublon' && l1b.signal === 'doublon')

    // 4. Validation.
    const champs = { categorie: 'energie', montant_ht_cents: 10000, montant_tva_cents: 2000, montant_ttc_cents: 12000,
      date_facture: '2026-11-03', fournisseur_nom: 'Recette Energie SARL', numero_facture: 'RE-2026-001' }
    if (entite) {
      const v = await charges.valider(db, { compte, valideur: compte, id: id1, champs: { ...champs, entite_juridique_id: entite.id } })
      verifier('4 validation avec l\'entité active', v.ok && v.charge.statut === 'validee', v.ok ? 'validee' : `${v.statut} ${v.code}`)
    } else {
      const v = await charges.valider(db, { compte, valideur: compte, id: id1, champs })
      verifier('4 validation sans entité : refusée (Q20)', !v.ok && v.code === 'entite_requise', v.ok ? 'ACCEPTÉE' : v.code)
      ignorer('4 validation avec entité', 'aucune entité active sur ce compte')
    }

    // 5. Supprimer le doublon : la première n'est plus le doublon de rien.
    const s2 = await charges.supprimer(db, { compte, id: id2 })
    if (s2.ok) crees.delete(id2)
    const l1c = await lire(id1)
    verifier('5 doublon supprimé, la première perd son signal', s2.ok && l1c && l1c.signal === null)

    // 6. Un envoi abandonné (vieilli de 25 h), une facture laissée en attente.
    const id3 = await envoyer(pdf3)
    // ⚠ ÉCRITURE DIRECTE, PROPRE À LA RECETTE (staging seulement, garde plus
    // haut) : seul moyen de rendre un envoi « vieux de 25 h » sans attendre.
    const { error: eVieux } = await db.from('charges').update({ cree_le: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
      .eq('id', id3).eq('user_id', compte).eq('statut', 'envoi')
    verifier('6a envoi abandonné vieilli de 25 h', !eVieux)
    const id4 = await envoyer(pdf2)
    const c4 = await charges.confirmerEnvoi(db, { compte, id: id4 })
    const a4 = await charges.appliquerLecture(db, { compte, id: id4, resultat: { panne: true, motif: 'recette' } })
    const l4 = await lire(id4)
    verifier('6b facture laissée en attente (panne simulée)', c4.ok && a4.ok && l4 && l4.statut === 'a_lire' && l4.motif === 'panne_ia')

    // 7. Un passage réel du cron dédié.
    console.log(`… attente de ${Math.round(ATTENTE_CRON_MS / 1000)} s : la file du cron ne prend pas une charge touchée il y a moins de 2 minutes`)
    await new Promise(r => setTimeout(r, ATTENTE_CRON_MS))
    // Le secret ne sort pas du processus : s'il manque, on en pose un, local.
    if (!process.env.CRON_SECRET) process.env.CRON_SECRET = crypto.randomBytes(32).toString('hex')
    const handler = require('../api/cron-charges')
    const rep = { statut: null, corps: null }
    await handler({ headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
      { status (s) { rep.statut = s; return this }, json (c) { rep.corps = c; return this }, setHeader () {} })
    const corps = rep.corps || {}
    verifier('7a passage du cron : 200, sans erreur', rep.statut === 200 && Array.isArray(corps.errors) && corps.errors.length === 0,
      `purges ${corps.purges}, lues ${corps.lues}, recalcul ${corps.recalcul ? `${corps.recalcul.comptes} compte(s)${corps.recalcul.complet ? '' : ' INCOMPLET'}` : '—'}${corps.errors && corps.errors.length ? `, erreurs ${JSON.stringify(corps.errors)}` : ''}`)
    const l3 = await lire(id3)
    const f3 = await db.storage.from(BUCKET).download(`${compte}/${id3}`)
    verifier('7b l\'envoi abandonné est purgé, ligne et fichier', !l3 && !!f3.error)
    if (!l3) crees.delete(id3)
    const l4b = await lire(id4)
    verifier('7c la facture en attente est lue par le cron', l4b && l4b.statut === 'a_verifier', l4b ? `${l4b.statut}, TTC ${l4b.montant_ttc_cents}` : 'absente')
    verifier('7d le recalcul a tourné jusqu\'au bout', !!(corps.recalcul && corps.recalcul.complet))
  } catch (e) {
    verifier('déroulé', false, e.message)
  } finally {
    // 8. Rien ne reste.
    for (const id of [...crees]) {
      const s = await charges.supprimer(db, { compte, id })
      if (s.ok || s.code === 'charge_introuvable') crees.delete(id)
    }
    const { data: restes } = await db.from('charges').select('id').eq('user_id', compte)
      .in('fournisseur_nom', ['Recette Energie SARL'])
    verifier('8 tout ce que la recette a créé est effacé', crees.size === 0 && (!restes || restes.length === 0),
      crees.size ? `restent : ${[...crees].join(', ')}` : '')
  }

  const echecs = resultats.filter(r => r.ok === false).length
  const passes = resultats.filter(r => r.ok === true).length
  const nonVus = resultats.filter(r => r.ok === null).length
  console.log(`\n${echecs ? 'RECETTE EN ÉCHEC' : 'RECETTE OK'} : ${passes} vérification(s) passée(s), ${echecs} en échec${nonVus ? `, ${nonVus} non vérifiée(s)` : ''}.`)
  code = echecs ? 1 : 0
  return code
}

if (require.main === module) {
  principal().then(c => process.exit(c || 0)).catch(e => { console.error(e); process.exit(1) })
}

module.exports = { pdfDeRecette, factureDeRecette, refusDeBase }
