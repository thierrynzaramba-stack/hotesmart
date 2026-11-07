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
const CHEMIN_REGROUPE = '/pages/aujourdhui'
const SUJET_REGROUPE = 'heures-calmes'

async function enfiler ({ userId, compte, code, sujet, canaux, a, contenu, db = client() }) {
  const ligne = {
    user_id: userId,
    compte_id: compte,
    code,
    sujet: String(sujet || code).slice(0, 200),
    canaux,
    a: new Date(a).toISOString(),
    contenu,
    cree_le: new Date().toISOString()
  }
  const { error } = await db.from('notifications_file').upsert(ligne, { onConflict: 'user_id,sujet' })
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true }
}

/**
 * Faire partir ce qui est dû. Rend un bilan ; ne lève jamais.
 * @param {object} [p]
 * @param {number} [p.maintenant]
 */
// `seulement` : une personne qui demande ce qui l'attend, TOUT DE SUITE, quelle
// que soit l'heure de fin de sa plage (POST /api/push, `vider_ma_file` — la
// recette sur staging, qui n'a pas de cron). Jamais les lignes d'un autre.
async function viderFile ({ maintenant = Date.now(), plafond = PLAFOND_PAR_PASSE, seulement = null, db = client(), deps = {} } = {}) {
  const bilan = { dues: 0, prises: 0, personnes: 0, messages: 0, erreurs: 0 }
  try {
    let q = db.from('notifications_file').select('id')
    q = seulement ? q.eq('user_id', seulement) : q.lte('a', new Date(maintenant).toISOString())
    const { data: dues, error: e1 } = await q
      .order('a', { ascending: true })
      .limit(plafond)
    if (e1) { bilan.erreurs++; return bilan }
    bilan.dues = (dues || []).length
    if (!bilan.dues) return bilan

    // Prendre = supprimer, et ne garder que ce que la suppression a rendu.
    const { data: prises, error: e2 } = await db.from('notifications_file')
      .delete()
      .in('id', dues.map(l => l.id))
      .select('*')
    if (e2) { bilan.erreurs++; return bilan }
    bilan.prises = (prises || []).length

    const parPersonne = new Map()
    for (const l of prises || []) {
      if (!parPersonne.has(l.user_id)) parPersonne.set(l.user_id, [])
      parPersonne.get(l.user_id).push(l)
    }
    for (const [userId, lignes] of parPersonne) {
      bilan.personnes++
      lignes.sort((x, y) => String(x.cree_le).localeCompare(String(y.cree_le)))
      const premiere = lignes[0].contenu || {}
      const langue = textes.langueDe(premiere.langue)
      const items = lignes.map(l => ({ titre: (l.contenu || {}).titre, corps: (l.contenu || {}).corps }))
      const { titre, corps } = textes.regrouper(langue, items)
      const seule = lignes.length === 1
      const canaux = [...new Set(lignes.flatMap(l => l.canaux || []))]
      // La plus récente des coordonnées rangées.
      const derniere = lignes[lignes.length - 1].contenu || {}
      try {
        await envoyerMaintenant({
          personne: { userId, email: derniere.email || null, telephone: derniere.telephone || null },
          canaux,
          contenu: {
            titre, corps, langue,
            chemin: seule ? premiere.chemin : CHEMIN_REGROUPE,
            sujet: seule ? lignes[0].sujet : SUJET_REGROUPE,
            rappel: false
          },
          compte: lignes[lignes.length - 1].compte_id,
          bienRef: seule ? (premiere.bienRef || null) : null,
          deps
        })
        bilan.messages++
      } catch (e) { bilan.erreurs++ }
    }
  } catch (e) {
    bilan.erreurs++
  }
  return bilan
}

module.exports = { PLAFOND_PAR_PASSE, enfiler, viderFile }
