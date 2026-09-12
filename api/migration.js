// api/migration.js
// L'ASSISTANT DE MIGRATION — l'etat et les actions, par etape.
// Spec : docs/specs/spec-assistant-migration.md (modif = MEME COMMIT)
//
// Regle de Thierry (9 septembre 2026) : chaque mecanisme du chantier migration
// est une ETAPE de l'assistant, pas un script d'operateur. Thierry est le
// testeur 0, pas un cas special : sa migration passe par ces endpoints, meme
// tant que l'UI n'existe pas.
//
// ⚠ LA VERITE DE L'ETAT VIT DANS lib/migration-etapes.js, pas ici. Cet endpoint
// expose, il ne decide pas — sinon un script et l'assistant finiraient par dire
// deux choses differentes du meme bien.
//
//   GET  /api/migration?property_id=<provider_property_id>   -> etat des etapes
//   GET  /api/migration                                       -> tous les biens
//   POST /api/migration?property_id=...&action=<id>&dry_run=  -> execute UNE etape
//
// `dry_run` vaut TRUE par defaut sur toute action, sans exception : une etape
// qui agit sans qu'on ait pu voir ce qu'elle ferait n'est pas une etape
// d'assistant.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, REF_SURE_RE, UUID_RE } = require('../lib/require-permission')
const { etatMigration } = require('../lib/migration-etapes')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Les colonnes que les etapes lisent. Une etape qui juge sur une colonne non
// selectionnee lit `undefined` — piege rencontre trois fois sur ce chantier.
// ⚠ `migration_target_property_id` EST DANS CETTE LISTE POUR UNE RAISON DE SURETE.
// Sans elle, `raisonDeRefus` lisait `undefined` et le refus « deja_provisionne »
// ne se declenchait jamais : relancer le provisionnement creait une SECONDE
// propriete Channex et ecrasait la premiere, devenue orpheline et muette.
// `country` et `zip_code` sont lus par le payload de creation.
const COLS = 'id, user_id, name, provider, provider_property_id, provider_room_type_id, '
  + 'provider_rate_plan_id, base_price, prix_minimum, capacity, included_guests, extra_guest_fee, '
  + 'currency, property_type, timezone, inventory_units, rate_sync_mode, '
  + 'migration_target_property_id, migration_target_at, country, zip_code, automation_paused'

async function biensDuCompte (accountUserId, providerPropertyId) {
  let q = supabase.from('properties').select(COLS).eq('user_id', accountUserId)
  // ⚠ SUR LES DEUX IDENTIFIANTS. Le re-keying PROMEUT la cle : sans cela,
  // `GET /api/migration?property_id=209413` — la cle utilisee de bout en bout
  // par le plan de bascule — repondait « bien introuvable » dans la minute qui
  // suit le deplacement. Au pire moment, ca se lit comme une perte de donnees.
  if (providerPropertyId) {
    const ref = String(providerPropertyId)
    // ⚠ FORMAT VALIDE AVANT TOUTE INTERPOLATION, comme partout ailleurs dans ce
    // depot. Sans ce controle, `?property_id=a&property_id=b` donne « a,b » —
    // PostgREST y lit une troisieme condition mal formee — et surtout un
    // appelant pouvait ajouter ses propres termes OR (`...,name.neq.zzz`) pour
    // elargir la correspondance DANS SON COMPTE : `biens[0]` devenait un bien
    // arbitraire, et un `re_keying&dry_run=false` partait sur le mauvais logement.
    if (!REF_SURE_RE.test(ref) && !UUID_RE.test(ref)) {
      throw new Error('identifiant de bien au format refuse')
    }
    q = q.or(`provider_property_id.eq.${ref},migration_target_property_id.eq.${ref}`)
  }
  const { data, error } = await q.order('name')
  if (error) throw new Error(`properties : ${error.message}`)
  return data || []
}

module.exports = async function handler (req, res) {
  // ─── Etat ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'read' })
    if (!garde.ok) return
    try {
      const biens = await biensDuCompte(garde.accountUserId, req.query.property_id)
      if (req.query.property_id && !biens.length) {
        return res.status(404).json({ error: 'Bien introuvable pour ce compte' })
      }
      const out = []
      for (const b of biens) out.push(await etatMigration(supabase, b))
      return res.status(200).json({ biens: out })
    } catch (e) {
      console.error('[migration] GET', e.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'write' })
    if (!garde.ok) return

    const action = String(req.query.action || '').trim()
    const propertyId = String(req.query.property_id || '').trim()
    // ⚠ `dry_run` par DEFAUT. Il faut le dire explicitement pour agir.
    const dryRun = req.query.dry_run !== 'false'

    if (!propertyId) return res.status(400).json({ error: 'property_id requis' })
    if (!action) return res.status(400).json({ error: 'action requise' })

    let biens
    try { biens = await biensDuCompte(garde.accountUserId, propertyId) }
    catch (e) { console.error('[migration] POST', e.message); return res.status(500).json({ error: 'Lecture impossible' }) }
    const bien = biens[0]
    if (!bien) return res.status(404).json({ error: 'Bien introuvable pour ce compte' })

    // ─── provisionner_channex ────────────────────────────────────────────────
    // Cree la propriete cible chez Channex et pose ses identifiants sur le bien
    // EXISTANT. Ne touche ni `provider`, ni `provider_property_id` : la bascule
    // appartient au re-keying.
    if (action === 'provisionner_channex') {
      const { provisionner } = require('../lib/migration-provisionner')
      try {
        const r = await provisionner(supabase, bien, { dryRun })
        return res.status(r.ok ? 200 : 409).json(r)
      } catch (e) {
        console.error('[migration] provisionner', e.message)
        return res.status(500).json({ error: 'provisionnement_impossible', detail: e.message })
      }
    }

    // ─── mode_de_prix ────────────────────────────────────────────────────────
    // Change `rate_sync_mode` pour un bien EN MIGRATION — l'angle mort de
    // `api/channel-property.js`, qui refuse ce reglage a tout bien pas encore
    // chez le canal. Ne touche aucune autre colonne, et ne pousse rien.
    if (action === 'mode_de_prix') {
      const { changerModeDePrix } = require('../lib/migration-mode-prix')
      const mode = String(req.query.mode || '').trim()
      try {
        const r = await changerModeDePrix(supabase, bien, mode, { dryRun })
        // Un parametre absent ou invalide est une requete mal formee (400), pas
        // un conflit d'etat (409) : l'appelant doit savoir lequel corriger.
        const code = r.ok ? 200 : (r.raison === 'mode_invalide' ? 400 : 409)
        return res.status(code).json(r)
      } catch (e) {
        console.error('[migration] mode_de_prix', e.message)
        return res.status(500).json({ error: 'changement_impossible', detail: e.message })
      }
    }

    // ─── poussee_ari ─────────────────────────────────────────────────────────
    // Pousse les 500 jours d'ARI vers la propriete CIBLE, par le writer unique
    // (`runFullSync`). Aucun canal n'existe sur cette propriete : rien de ceci
    // n'atteint un OTA. Plan de bascule, phase 0.3.
    if (action === 'poussee_ari') {
      const { pousserAri } = require('../lib/migration-ari')
      try {
        // ⚠ La cible peut porter des canaux ACTIFS entre les phases 2.6 et 2.8
        // du plan de bascule : l'etape le verifie chez le provider avant d'agir,
        // et refuse plutot que d'atteindre un OTA en le niant.
        const r = await pousserAri(bien, { dryRun })
        return res.status(r.ok ? 200 : 409).json(r)
      } catch (e) {
        console.error('[migration] poussee_ari', e.message)
        return res.status(500).json({ error: 'poussee_impossible', detail: e.message })
      }
    }

    // ─── purger_le_futur ─────────────────────────────────────────────────────
    // Neutralise les sejours a venir et en cours (statut `demapped`) APRES le
    // re-keying. Regle de Thierry : le passe reste, le futur ne compte plus — au
    // remapping l'OTA rend ses propres identifiants, donc rien a rapprocher.
    // Rien n'est supprime : la trace reste, et le geste se defait.
    if (action === 'purger_le_futur') {
      const { purgerLeFutur } = require('../lib/migration-purge-futur')
      try {
        const r = await purgerLeFutur(supabase, bien, { dryRun })
        // Meme convention que `re_keying` : une indisponibilite ou un echec
        // d'ecriture n'est pas un conflit d'etat.
        const indispo = ['lecture_impossible', 'annulation_partielle']
        const code = r.ok ? 200 : (indispo.includes(r.raison) ? 500 : 409)
        return res.status(code).json(r)
      } catch (e) {
        console.error('[migration] purger_le_futur', e.message)
        return res.status(500).json({ error: 'purge_impossible', detail: e.message })
      }
    }

    // ─── re_keying ───────────────────────────────────────────────────────────
    // Deplace les 18 tables enfants et le bien vers le nouveau provider, en UNE
    // transaction SQL. Refuse si l'automatisation n'est pas en pause.
    if (action === 're_keying') {
      const { deplacerLeBien } = require('../lib/migration-rekeying')
      try {
        const r = await deplacerLeBien(supabase, bien, { dryRun })
        // Une indisponibilite (fonction SQL pas encore appliquee, base
        // injoignable) n'est pas un conflit d'etat : l'operateur ne doit pas
        // lire « 409 » pour « je n'ai pas pu lire ».
        const code = r.ok ? 200 : (r.raison === 'lecture_impossible' ? 500 : 409)
        return res.status(code).json(r)
      } catch (e) {
        console.error('[migration] re_keying', e.message)
        return res.status(500).json({ error: 'deplacement_impossible', detail: e.message })
      }
    }

    // Les actions arrivent avec leur etape. Tant qu'une action n'est pas
    // construite, on le DIT — on ne fait pas semblant de l'avoir.
    const CONSTRUITES = new Set(['provisionner_channex', 'poussee_ari', 'mode_de_prix', 're_keying', 'purger_le_futur'])
    if (!CONSTRUITES.has(action)) {
      const etat = await etatMigration(supabase, bien)
      return res.status(501).json({
        error: 'action_non_construite',
        action,
        message: `L'action « ${action} » n'est pas encore un geste de l'assistant. `
          + 'Elle est disponible en script le temps de la construire.',
        etat
      })
    }
  }

  return res.status(405).json({ error: 'Methode non supportee' })
}
