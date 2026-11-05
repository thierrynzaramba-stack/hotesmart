// ═══════════════════════════════════════════════════════════════════════════
// /api/ecran/connaissance — L'ÉCRAN DE LA BASE DE CONNAISSANCE (lot 3)
// Spec : docs/specs/spec-base-connaissance-v5.md
//
// ⚠ UN ÉCRAN = UN ENDPOINT (règle de performance de CLAUDE.md). Le volet de
// l'ordinateur et la page du téléphone sont le MÊME écran : ils appellent ce
// GET, une fois, et il rend tout — la liste des biens, les faits, les réponses
// prêtes. La page remplacée, elle, lisait Supabase depuis le navigateur.
//
// ⚠ ET L'ÉCRITURE NE PASSE PLUS PAR UN `delete` DE TOUT LE BIEN.
// `apps/agent-ai/knowledge.html` supprimait toutes les lignes du bien puis les
// réinsérait : `created_at` était perdu à chaque enregistrement, une panne
// entre les deux vidait la base du bien, et `verifie_le` — l'objet même de ce
// lot — n'aurait pas survécu à une sauvegarde. On écrit LIGNE À LIGNE, en
// `upsert` sur la contrainte d'unicité que la table porte déjà
// (`user_id, property_id, type, key`).
//
// ⚠ L'ÉCRITURE EST RÉSERVÉE AU TITULAIRE, comme les réglages de l'IA (dette
// 68) : ce que la base contient gouverne ce que l'agent DIT au voyageur, et un
// code d'immeuble y vit. La LECTURE suit les droits `messagerie`, pour qu'un
// membre délégué voie le texte des réponses sans pouvoir les changer.
// ═══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran } = require('../../lib/require-permission')
const { refsDuPerimetre, peutLire, estTitulaireDuCompte } = require('../../lib/permissions')
const { colonneAbsente } = require('../../lib/colonne-absente')
const { carte, faits } = require('../../lib/connaissance')
const { BALISES, etiquetteDe } = require('../../lib/balises')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ PostgREST TRONQUE À 1000 LIGNES SANS ERREUR. `knowledge` dépassera ce seuil
// à quelques dizaines de biens : toute lecture se pagine par CURSEUR sur `id`.
async function toutesLesEntrees (accountUserId, ref, compteur) {
  let apres = null
  const acc = []
  for (;;) {
    let q = supabase.from('knowledge')
      .select('id, type, key, value, created_at, verifie_le, lisible_par_ia')
      .eq('user_id', accountUserId).eq('property_id', String(ref))
      .order('id').limit(200)
    if (apres) q = q.gt('id', apres)
    const { data, error } = await q
    compteur.n++
    if (error) {
      // ⚠ LA MIGRATION PEUT NE PAS ÊTRE PASSÉE, et l'écran doit alors marcher
      // SANS les deux colonnes neuves plutôt que de refuser : c'est ce qui
      // permet de déployer le code avant de coller le SQL.
      if (colonneAbsente(error)) return { lignes: acc, migration: false }
      throw new Error(error.message)
    }
    acc.push(...data)
    if (data.length < 200) return { lignes: acc, migration: true }
    apres = data[data.length - 1].id
  }
}

// Le repli, quand les colonnes neuves n'existent pas encore.
async function entreesSansMigration (accountUserId, ref, compteur) {
  const acc = []
  let apres = null
  for (;;) {
    let q = supabase.from('knowledge')
      .select('id, type, key, value, created_at')
      .eq('user_id', accountUserId).eq('property_id', String(ref))
      .order('id').limit(200)
    if (apres) q = q.gt('id', apres)
    const { data, error } = await q
    compteur.n++
    if (error) throw new Error(error.message)
    acc.push(...data)
    if (data.length < 200) return acc
    apres = data[data.length - 1].id
  }
}

module.exports = async (req, res) => {
  const t0 = Date.now()
  const compteur = { n: 0 }
  // L'en-tête privé avant tout, y compris avant un refus de méthode (dette 90).
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId, contexte } = garde

  try {
    // ─── Les biens que cet utilisateur a le droit de voir ────────────────
    const refs = refsDuPerimetre(contexte)
    let qb = supabase.from('properties')
      .select('id, name, provider_property_id, photo_url')
      .eq('user_id', accountUserId).order('name')
    const { data: tousLesBiens, error: eB } = await qb
    compteur.n++
    if (eB) throw new Error(eB.message)
    const biens = (tousLesBiens || []).filter(p =>
      refs === null || peutLire(contexte, 'messagerie', p.provider_property_id))
    if (!biens.length) {
      res.setHeader('Server-Timing', `db;desc="${compteur.n} requêtes";dur=${Date.now() - t0}`)
      return res.status(200).json({ biens: [], bien: null, faits: [], reponses: [], migration: true })
    }

    const demande = String(req.query.bien || req.body?.bien || '').trim()
    const choisi = biens.find(p => String(p.provider_property_id) === demande) || biens[0]

    // ─── POST : enregistrer ou supprimer UNE entrée ──────────────────────
    if (req.method === 'POST') {
      if (!estTitulaireDuCompte(contexte)) {
        return res.status(403).json({ error: 'Réservé au titulaire du compte' })
      }
      if (demande && !biens.some(p => String(p.provider_property_id) === demande)) {
        return res.status(403).json({ error: 'Logement hors de votre périmètre' })
      }
      const { action, id, type, key, value, lisible_par_ia: lisible } = req.body || {}

      if (action === 'supprimer') {
        if (!id) return res.status(400).json({ error: 'Entrée non désignée' })
        const { error } = await supabase.from('knowledge').delete()
          .eq('id', id).eq('user_id', accountUserId).eq('property_id', String(choisi.provider_property_id))
        compteur.n++
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ ok: true, supprime: id })
      }

      if (action !== 'enregistrer') return res.status(400).json({ error: 'Action inconnue' })
      const sujet = String(key || '').trim()
      if (!sujet) return res.status(400).json({ error: 'Le sujet est obligatoire' })
      const nature = type === 'fixed' ? 'fixed' : 'faq'
      // ⚠ `verifie_le` EST POSÉE ICI, ET SEULEMENT ICI : c'est le geste de
      // l'hôte qui la pose. Une date posée par le système dirait « vérifié » de
      // ce que personne n'a relu — et le badge « À revoir » ne vaudrait rien.
      const ligne = {
        user_id: accountUserId, property_id: String(choisi.provider_property_id),
        type: nature, key: sujet, value: String(value == null ? '' : value),
        verifie_le: new Date().toISOString()
      }
      if (lisible === true || lisible === false) ligne.lisible_par_ia = lisible
      const { data, error } = await supabase.from('knowledge')
        .upsert(ligne, { onConflict: 'user_id,property_id,type,key' })
        .select('id, type, key, value, verifie_le, lisible_par_ia').maybeSingle()
      compteur.n++
      if (error) {
        if (colonneAbsente(error)) {
          return res.status(503).json({ error: 'Migration 2026-11-04-connaissance-v5 non appliquée' })
        }
        return res.status(500).json({ error: error.message })
      }
      return res.status(200).json({ ok: true, entree: data })
    }

    // ─── GET : tout l'écran, en une fois ─────────────────────────────────
    let lignes; let migration = true
    try {
      const r = await toutesLesEntrees(accountUserId, choisi.provider_property_id, compteur)
      lignes = r.lignes; migration = r.migration
      if (!migration) lignes = await entreesSansMigration(accountUserId, choisi.provider_property_id, compteur)
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }

    const connaissance = Object.fromEntries(
      lignes.filter(l => l.type === 'fixed').map(l => [l.key, l.value]))
    const maintenant = Date.now()
    const reponses = lignes.filter(l => l.type !== 'fixed')
      .map(l => carte(l, { connaissance, maintenant }))
      .sort((a, b) => a.sujet.localeCompare(b.sujet, 'fr'))

    res.setHeader('Server-Timing', `db;desc="${compteur.n} requêtes";dur=${Date.now() - t0}`)
    return res.status(200).json({
      migration,
      biens: biens.map(p => ({ ref: p.provider_property_id, nom: p.name, photo: p.photo_url || null })),
      bien: { ref: choisi.provider_property_id, nom: choisi.name, photo: choisi.photo_url || null },
      faits: faits(lignes, { maintenant }),
      reponses,
      // ⚠ LES BALISES INSÉRABLES VIENNENT DU MODULE, JAMAIS RECOPIÉES DANS LA
      // PAGE : le jour où une balise change de libellé, elle change partout.
      balises: Object.keys(BALISES).map(cle => ({ cle, libelle: etiquetteDe(cle), origine: BALISES[cle].origine }))
    })
  } catch (e) {
    console.error('[ecran/connaissance]', e.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }
}
