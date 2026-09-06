// api/incidents-acquitter.js
// DOC : docs/kb/reservation-directe.md (modif = MEME COMMIT)
//
// Acquittement MANUEL d'une alarme recurrente (surreservation).
// Spec : docs/specs/spec-reservation-manuelle.md §4.
//
// C'est le SEUL moyen d'arreter la reemission tant que la surreservation dure :
// aucune extinction automatique. L'alarme s'eteint d'elle-meme dans un seul cas —
// quand le conflit a disparu — et c'est lib/cron-overbooking.js qui le constate.
//
// Un acquittement vaut pour l'ETAT VU : si les nuits ou les reservations en cause
// changent, c'est un probleme nouveau et l'alarme repart.
//
// GET                 -> liste les alarmes ouvertes du compte
// POST { id }         -> acquitte une alarme du compte

const { requirePermission } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  // ⚠ GARDE STANDARD DU REPO, pas une verification maison.
  // Premiere version : l'endpoint refaisait son propre `getUser` et prenait
  // `user.id` comme compte. Un profil delegue (sélecteur de compte) voyait donc
  // une banniere vide et ne pouvait pas acquitter l'alarme du compte qu'il gere,
  // et aucun controle de domaine ni de perimetre n'etait applique.
  // `accountUserId` est le compte REELLEMENT consulte, `userId` l'identite.
  //
  // Domaine `reservations` : une surreservation est un conflit de reservations.
  // Lecture pour consulter, ECRITURE pour acquitter — acquitter, c'est engager
  // « j'ai vu, je m'en occupe », et faire taire une alarme que d'autres attendent.
  const niveau = req.method === 'POST' ? 'write' : 'read'
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau, compteDelegue: true
  })
  if (!garde.ok) return

  // ⚠ PERIMETRE PAR BIEN, en plus du domaine.
  // Un membre delegue en `property_scope: 'selected'` ne doit voir QUE les biens
  // de son perimetre — et surtout ne pas pouvoir acquitter l'alarme d'un bien
  // qu'il ne gere pas, ce qui l'eteindrait durablement (la signature fait taire
  // tant que le conflit ne change pas). Meme mecanique que api/avis.js et
  // api/menages.js.
  const refs = refsDuPerimetre(garde.contexte)
  const filtre = filtrePerimetreSql(refs, 'property_id')

  // ─── Lecture : les alarmes encore ouvertes ─────────────────────────────────
  if (req.method === 'GET') {
    // Perimetre vide : le membre n'a aucun bien. Ce n'est pas une erreur.
    if (filtre === '') return res.status(200).json({ alarmes: [] })

    let q = supabase
      .from('automation_incidents')
      .select('id, type, property_id, detail, created_at, last_alerted_at')
      .eq('user_id', garde.accountUserId)
      .eq('type', 'overbooking')
      .is('acquitted_at', null)
    if (filtre !== null) q = q.or(filtre)
    const { data, error } = await q.order('created_at', { ascending: false })
    if (error) {
      console.error('[incidents-acquitter] lecture echec', error.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
    return res.status(200).json({ alarmes: data || [] })
  }

  // ─── Acquittement ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id manquant' })

    // ⚠ Le filtre sur le compte n'est PAS decoratif : sans lui, n'importe quel
    // utilisateur authentifie pourrait eteindre l'alarme d'un autre compte — et
    // celle-ci ne se rallumerait pas tant que le conflit garde la meme forme.
    // `.is('acquitted_at', null)` rend l'operation idempotente : un double clic
    // n'ecrase pas l'horodatage du premier acquittement.
    // `acquitted_by` porte l'IDENTITE (qui a clique), pas le compte : c'est la
    // trace de la personne, et un delegue n'est pas le titulaire.
    // Perimetre vide : rien a acquitter, et surtout rien a laisser passer.
    if (filtre === '') return res.status(404).json({ error: 'Alarme introuvable ou déjà acquittée' })

    let m = supabase
      .from('automation_incidents')
      .update({ acquitted_at: new Date().toISOString(), acquitted_by: garde.userId })
      .eq('id', id)
      .eq('user_id', garde.accountUserId)
      .eq('type', 'overbooking')
      .is('acquitted_at', null)
    if (filtre !== null) m = m.or(filtre)
    const { data, error } = await m.select('id, type, property_id')
    if (error) {
      console.error('[incidents-acquitter] acquittement echec', error.message)
      return res.status(500).json({ error: 'Acquittement impossible' })
    }
    if (!data || !data.length) {
      // On ne distingue pas « inexistant », « d'un autre compte » et « deja
      // acquitte » : cela renseignerait un tiers sur l'existence d'un incident
      // qui ne le regarde pas.
      return res.status(404).json({ error: 'Alarme introuvable ou déjà acquittée' })
    }

    console.log(`[incidents-acquitter] overbooking bien ${data[0].property_id} acquitte par ${String(garde.userId).slice(0, 8)} (compte ${String(garde.accountUserId).slice(0, 8)})`)
    return res.status(200).json({ ok: true, acquitte: data[0].id })
  }

  return res.status(405).json({ error: 'Méthode non autorisée' })
}
