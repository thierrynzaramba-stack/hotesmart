// lib/notifications/file.js — LE SEUL MODULE QUI ÉCRIT dans `notifications_file`.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §4.3 et §16.2 · KB : docs/kb/pwa.md §10
//
// Ce qui peut attendre la fin des heures calmes d'une personne y est rangé, déjà
// rédigé dans SA langue. Une passe du cron (`viderFile`) le fait partir à la
// fin de la plage, en UN message regroupé par personne et par canal (§4.3).
//
// ⚠ UN SUJET = UNE LIGNE PAR PERSONNE : la même surréservation relancée toutes
// les 45 minutes REMPLACE sa ligne (spec §7). L'index unique (user_id, sujet)
// le garantit en base.
//
// ⚠ UNE LIGNE EST POUR UNE PERSONNE DU COMPTE (`user_id`) OU POUR UN CONTACT
// LIBRE (`contact_id`, lot 2c-3), jamais les deux (contrainte en base). Le
// contact a son propre index unique (contact_id, sujet) ; à la sortie, il se
// RELIT comme une personne relit ses droits : désinscrit, ou plus réglé pour cet
// événement sur ce bien, sa ligne est écartée.
//
// ⚠ UNE LIGNE NE PART QU'UNE FOIS : la passe SUPPRIME les lignes qu'elle prend,
// et n'envoie que celles que sa suppression a rendues. Deux passes qui se
// croisent ne se partagent rien. Le prix : une ligne prise puis ratée (panne
// d'envoi) est perdue — le même sort que l'envoi immédiat, qui ne réessaie pas
// non plus.
const textes = require('./textes')
const { envoyerMaintenant } = require('./envoi')

function client () {
  return require('../cron-shared').supabase
}

const PLAFOND_PAR_PASSE = 200
// ⚠ UN BUDGET, COMME LES BROUILLONS (api/cron.js) : au plus 30 envois regroupés
// par passe, et on ne commence plus de groupe quand il reste moins de 20 s au
// cycle. Chaque groupe n'est PRIS (supprimé) qu'au moment de partir : ce qui n'a
// pas eu le temps de commencer reste en base pour le cycle suivant.
// ⚠ CE QUE LA MARGE NE GARANTIT PAS (seconde review) : un groupe commencé peut
// durer plus qu'elle — 5 s par appareil muet, jusqu'à 10 appareils. Si le cycle
// est tué pendant ce groupe, c'est LUI qui est perdu : au plus un par cycle, et
// jamais ceux qui n'ont pas commencé.
const GROUPES_PAR_PASSE = 30
const MARGE_MS = 20000
const CHEMIN_REGROUPE = '/pages/aujourdhui'
const SUJET_REGROUPE = 'heures-calmes'

async function enfiler ({ userId = null, contactId = null, compte, code, sujet, canaux, a, contenu, db = client() }) {
  if (!userId === !contactId) return { ok: false, motif: 'destinataire_illisible' }
  const ligne = {
    user_id: contactId ? null : userId,
    ...(contactId ? { contact_id: contactId } : {}),
    compte_id: compte,
    code,
    sujet: String(sujet || code).slice(0, 200),
    canaux,
    a: new Date(a).toISOString(),
    contenu,
    cree_le: new Date().toISOString()
  }
  const { error } = await db.from('notifications_file').upsert(ligne, { onConflict: contactId ? 'contact_id,sujet' : 'user_id,sujet' })
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true }
}

// Une alerte qui vient de partir MAINTENANT remplace celle du même sujet qui
// attendait (sinon : la relance de 7 h part, puis la ligne en attente repart
// derrière elle — constat de review).
async function retirer ({ userId = null, contactId = null, sujet, db = client() }) {
  if ((!userId && !contactId) || !sujet) return { ok: true }
  const { error } = await db.from('notifications_file').delete()
    .eq(contactId ? 'contact_id' : 'user_id', contactId || userId).eq('sujet', String(sujet).slice(0, 200))
  return error ? { ok: false, motif: 'ecriture_impossible' } : { ok: true }
}

// Une alerte qui n'a plus d'objet (surréservation acquittée ou disparue) ne doit
// plus partir chez PERSONNE du compte.
// `code` : ne retirer que la ligne de CET événement sur ce sujet. Une
// conversation porte un seul sujet pour quatre événements (b, c, d, e) : la
// réponse partie retire « Réponse à valider », jamais le « Nouveau message »
// arrivé depuis.
async function retirerSujet ({ compte, sujet, code = null, db = client() }) {
  if (!compte || !sujet) return { ok: true }
  let q = db.from('notifications_file').delete().eq('compte_id', compte).eq('sujet', String(sujet).slice(0, 200))
  if (code) q = q.eq('code', code)
  const { error } = await q
  return error ? { ok: false, motif: 'ecriture_impossible' } : { ok: true }
}

/**
 * Faire partir ce qui est dû. Rend un bilan ; ne lève jamais.
 *
 * ⚠ REGROUPÉ PAR PERSONNE ET PAR COMPTE, jamais par personne seule (constat de
 * SÉCURITÉ de review) : une personne membre de deux comptes recevrait sinon le
 * nom d'un bien de A sur le téléphone et par la clé SMS de B — et dans les
 * journaux SMS de B.
 *
 * ⚠ LES DROITS SE RELISENT À LA SORTIE (constat de SÉCURITÉ de review) : une
 * personne désactivée, ou qui a perdu le domaine ou le bien pendant ses heures
 * calmes, ne reçoit plus rien ; et les coordonnées sont celles d'AUJOURD'HUI.
 *
 * ⚠ CHAQUE CANAL NE PORTE QUE SES LIGNES : une ligne en notification seule
 * n'apparaît ni dans l'e-mail ni dans le SMS d'une autre.
 *
 * `seulement` : une personne qui demande ce qui l'attend, TOUT DE SUITE, quelle
 * que soit l'heure de fin de sa plage (POST /api/push, `vider_ma_file` — la
 * recette sur staging, qui n'a pas de cron). Jamais les lignes d'un autre.
 */
async function viderFile ({ maintenant = Date.now(), plafond = PLAFOND_PAR_PASSE, seulement = null, resteMs = null,
  db = client(), deps = {} } = {}) {
  const bilan = { dues: 0, prises: 0, groupes: 0, messages: 0, ecartees: 0, reportees: 0, erreurs: [] }
  const { destinataires } = require('./destinataires')
  const { relireContact } = require('./contacts')
  try {
    let q = db.from('notifications_file').select('id, user_id, contact_id, compte_id')
    q = seulement ? q.eq('user_id', seulement) : q.lte('a', new Date(maintenant).toISOString())
    const { data: dues, error: e1 } = await q
      .order('a', { ascending: true })
      .limit(plafond)
    if (e1) { bilan.erreurs.push('lecture_impossible'); return bilan }
    bilan.dues = (dues || []).length
    if (!bilan.dues) return bilan

    const groupes = new Map()
    for (const l of dues) {
      // Un contact libre a sa clé à lui : il n'est jamais regroupé avec une personne.
      const cle = l.contact_id ? `c:${l.contact_id}|${l.compte_id}` : `u:${l.user_id}|${l.compte_id}`
      if (!groupes.has(cle)) groupes.set(cle, [])
      groupes.get(cle).push(l.id)
    }

    const droits = new Map() // compte|code|bien → Map userId → personne (fraîche)
    let n = 0
    for (const [cle, ids] of groupes) {
      if (n >= GROUPES_PAR_PASSE || (resteMs && resteMs() < MARGE_MS)) { bilan.reportees += ids.length; continue }
      n++
      const [qui, compte] = cle.split('|')
      const contactId = qui.startsWith('c:') ? qui.slice(2) : null
      const userId = contactId ? null : qui.slice(2)

      // 1. LES DROITS ET LES COORDONNÉES D'AUJOURD'HUI, AVANT DE PRENDRE quoi que
      // ce soit (seconde review) : une relecture en panne laisse le groupe en
      // base pour le cycle suivant, au lieu de le prendre puis de le perdre.
      const { data: lues, error: eL } = await db.from('notifications_file').select('*').in('id', ids)
      if (eL) { bilan.erreurs.push('lecture_impossible'); bilan.reportees += ids.length; continue }
      const verdict = new Map() // id → personne fraîche, ou null (écartée)
      let panne = false
      for (const l of lues || []) {
        const c = l.contenu || {}
        const bien = c.bienRef || c.bienId ? { ref: c.bienRef || undefined, id: c.bienId || undefined } : null
        if (contactId) {
          const r = await relireContact({ compte, contactId, code: l.code, bien, db })
          if (!r.ok) { bilan.erreurs.push('contact_illisible'); panne = true; break }
          verdict.set(l.id, r.contact ? { contact: { contactId: r.contact.contactId, jeton: r.contact.jeton }, email: r.contact.email, telephone: r.contact.telephone } : null)
          continue
        }
        const k = `${compte}|${l.code}|${c.bienRef || ''}|${c.bienId || ''}`
        if (!droits.has(k)) {
          const r = await destinataires({ compte, code: l.code, bien, db })
          if (!r.ok) { bilan.erreurs.push('droits_illisibles'); panne = true; break }
          droits.set(k, new Map(r.personnes.map(p => [p.userId, p])))
        }
        verdict.set(l.id, droits.get(k).get(userId) || null)
      }
      if (panne) { bilan.reportees += ids.length; continue }

      // 2. Prendre = supprimer, et ne garder que ce que la suppression a rendu.
      const { data: prises, error: e2 } = await db.from('notifications_file')
        .delete().in('id', [...verdict.keys()]).select('*')
      if (e2) { bilan.erreurs.push('prise_impossible'); continue }
      if (!prises || !prises.length) continue
      bilan.prises += prises.length
      bilan.groupes++

      const retenues = []
      let personne = null
      for (const l of prises) {
        const p = verdict.get(l.id)
        if (!p) { bilan.ecartees++; continue }
        personne = p
        retenues.push(l)
      }

      // ⚠ LE RELEVÉ DÉTAILLÉ D'UNE RÉSERVATION DIRECTE PART SEUL (décision de
      // Thierry du 8 novembre 2026, lib/notifications/releve.js) : jamais fondu
      // dans le message regroupé, relu dans le cœur, et au TITULAIRE seul.
      // ⚠ CHAQUE RELEVÉ PASSE LE BUDGET (constat de review) : il coûte des
      // lectures et un envoi ; ce qui n'a pas le temps de partir REVIENT dans la
      // file au lieu d'être perdu avec le cycle.
      const gardees = []
      for (const l of retenues) {
        if (!(l.contenu && l.contenu.releve)) { gardees.push(l); continue }
        if (contactId) { bilan.ecartees++; continue }
        if ((verdict.get(l.id) || {}).userId !== compte) { bilan.ecartees++; continue }
        if (n >= GROUPES_PAR_PASSE || (resteMs && resteMs() < MARGE_MS)) {
          const remise = await enfiler({ userId: l.user_id, compte, code: l.code, sujet: l.sujet, canaux: l.canaux, a: l.a, contenu: l.contenu, db })
          if (remise.ok) bilan.reportees++
          else bilan.erreurs.push('releve_perdu')
          continue
        }
        n++
        try {
          const sortir = deps.sortirReleve || require('./releve').sortirDeLaFile
          const r = await sortir({ ligne: l, maintenant, db })
          if (r && r.envoye) bilan.messages++
          else if (r && r.remise) bilan.reportees++
          else if (r && r.erreur) bilan.erreurs.push('releve_non_envoye')
        } catch (e) { bilan.erreurs.push('releve_exception') }
      }
      if (!gardees.length) continue

      gardees.sort((x, y) => String(x.cree_le).localeCompare(String(y.cree_le)))
      const langue = textes.langueDe((gardees[0].contenu || {}).langue)
      const contenuDe = (lignes) => {
        const items = lignes.map(l => ({ titre: (l.contenu || {}).titre, corps: (l.contenu || {}).corps }))
        const { titre, corps } = textes.regrouper(langue, items)
        const seule = lignes.length === 1
        return {
          titre, corps, langue,
          chemin: seule ? (lignes[0].contenu || {}).chemin : CHEMIN_REGROUPE,
          sujet: seule ? lignes[0].sujet : SUJET_REGROUPE,
          // ⚠ CE QUI SORT DES HEURES CALMES SONNE TOUJOURS (recette du
          // 8 novembre 2026) : c'est le moment où l'alerte est ENFIN dite. Sans
          // `rappel`, elle remplaçait EN SILENCE une notification du même sujet
          // encore affichée — envoyée, acceptée, et jamais vue.
          rappel: true
        }
      }
      const canaux = [...new Set(gardees.flatMap(l => l.canaux || []))]
      const contenus = Object.fromEntries(canaux.map(c => [c, contenuDe(gardees.filter(l => (l.canaux || []).includes(c)))]))
      const seuleLigne = gardees.length === 1 ? gardees[0] : null
      try {
        const e = await envoyerMaintenant({
          personne,
          canaux,
          contenu: contenus[canaux[0]] || contenuDe(gardees),
          contenus,
          compte,
          bienRef: seuleLigne ? ((seuleLigne.contenu || {}).bienRef || null) : null,
          db,
          deps
        })
        if (e.push || e.email || e.sms) bilan.messages++
        bilan.erreurs.push(...e.erreurs)
      } catch (e) { bilan.erreurs.push('envoi_exception') }
    }
  } catch (e) {
    bilan.erreurs.push('exception')
  }
  return bilan
}

module.exports = { PLAFOND_PAR_PASSE, GROUPES_PAR_PASSE, enfiler, retirer, retirerSujet, viderFile }
