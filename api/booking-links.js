// api/booking-links.js
// DOC : docs/kb/moteur-reservation.md §7 et §12 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §3 ter (ajout 3) et §6 bis
//
// L'APP « RESERVATION DIRECTE » — gestion des liens et de la politique.
// Remplace `scripts/booking-links.js`, qui restera l'outil de service.
//
// ⚠ L'ACTIVATION DU MOTEUR, C'EST LE LIEN. Il n'existe aucun drapeau
// « moteur actif » sur le bien, et il ne doit pas en exister : un bien sans lien
// actif n'a pas de page publique, c'est l'etat par defaut. Ajouter un second
// interrupteur creerait deux verites sur la meme question.
//
// ⚠ NE JAMAIS LIRE `paused_at` NI `automation_paused` ICI. Ce sont le kill
// switch d'AUTOMATISATION, pose automatiquement quand une conversation IA
// boucle. Les confondre avec une pause commerciale mettrait le canal de vente
// hors ligne tout seul (voir docs/kb/moteur-reservation.md §3.6).
//
// GARDE : domaine `reglages`, niveau `write`, RESOLU PAR LE BIEN. Un identifiant
// de bien fourni par le client est toujours revalide serveur : c'est ce qui
// empeche de designer le bien d'un autre compte.

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { raisonNonVendable } = require('../lib/moteur-reservation')
const { POLITIQUES } = require('../lib/email-voyageur')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Meme recette que partout : 32 octets, base64url, 43 caracteres.
const nouveauJeton = () => crypto.randomBytes(32).toString('base64url')

// Les quatre politiques du §2, et rien d'autre. La liste vit ici ET dans la
// contrainte SQL : le front ne doit pas pouvoir en inventer une cinquieme.
const POLITIQUES_VALIDES = Object.keys(POLITIQUES.fr)

function base () {
  const b = process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app'
  return String(b).trim().replace(/\/+$/, '')
}

// ⚠ LE JETON COMPLET SORT ICI, et c'est normal : l'hote a besoin de l'URL pour
// la coller sur son site. Ce qui ne doit jamais sortir, c'est le jeton d'un
// AUTRE compte — d'ou la resolution par le bien, jamais par un identifiant de
// lien fourni brut.
function lienPublic (l) {
  return {
    id: l.id,
    property_id: l.property_id,
    label: l.label || '',
    coefficient: Number(l.price_coefficient),
    active: l.active === true,
    url: `${base()}/book/${l.token}`,
    cree_le: l.created_at
  }
}

function corps (req) {
  if (!req.body) return {}
  if (typeof req.body === 'object') return req.body
  try { return JSON.parse(req.body) } catch (e) { return null }
}

// Le coefficient est un POURCENTAGE. Memes bornes que la contrainte SQL : un 0
// vendrait les nuits gratuitement, un negatif rembourserait le voyageur, et le
// plafond attrape la faute de frappe (10000 au lieu de 100).
function coefficientValide (v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 1000
}

module.exports = async function handler (req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'methode_non_autorisee' })
  }

  const body = req.method === 'GET' ? {} : corps(req)
  if (!body) return res.status(400).json({ error: 'corps_illisible' })

  // ─── Liste : tous les biens du compte, avec leurs liens ────────────────────
  if (req.method === 'GET' && !req.query.bien) {
    const garde = await requirePermission(req, res, { domaine: 'reglages', niveau: 'read' })
    if (!garde.ok) return
    try {
      const { data: biens, error: eB } = await supabase
        .from('properties')
        .select('id, name, base_price, currency, capacity, cancellation_policy, provider, provider_property_id, inventory_units')
        .eq('user_id', garde.accountUserId).order('name')
      if (eB) throw new Error(eB.message)

      const ids = (biens || []).map(b => b.id)
      let liens = []
      if (ids.length) {
        const { data, error } = await supabase.from('booking_links')
          .select('*').in('property_id', ids).order('created_at')
        if (error) throw new Error(error.message)
        liens = data || []
      }

      return res.status(200).json({
        biens: (biens || []).map(b => ({
          id: b.id, nom: b.name, devise: b.currency || 'EUR',
          prix_de_base: b.base_price, capacite: b.capacity,
          politique: b.cancellation_policy || 'non_remboursable',
          // La raison pour laquelle un bien ne peut PAS vendre est dite en clair
          // a l'hote : « non vendable » sans motif l'envoie chercher au hasard.
          bloquant: raisonNonVendable(b),
          liens: liens.filter(l => l.property_id === b.id).map(lienPublic)
        })),
        politiques: POLITIQUES_VALIDES
      })
    } catch (e) {
      console.error('[booking-links] liste', e.message)
      return res.status(500).json({ error: 'indisponible' })
    }
  }

  // ─── Tout le reste est PAR BIEN, et le bien est revalide serveur ───────────
  const bienDemande = req.query.bien || body.bien
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })
  // ⚠ LA LECTURE N'EXIGE PAS UN DROIT D'ECRITURE. Constat de review : lister les
  // liens d'un bien passait par `write`, donc un profil `reglages: read` recevait
  // 403 sur un simple affichage.
  const ecriture = req.method !== 'GET'
  const garde = await requirePermission(req, res, {
    domaine: 'reglages', niveau: ecriture ? 'write' : 'read',
    bien: bienDemande, bienRequis: true
  })
  if (!garde.ok) return

  // ⚠ TITULAIRE UNIQUEMENT POUR ECRIRE, ET C'EST VERIFIE ICI.
  // Constat de review, et c'est le contresens que `tests/pages-non-delegables.js`
  // documente deja : masquer une entree de menu ne ferme pas la page. Le
  // sous-menu est cache aux non-titulaires et la page appelle
  // `exigerCompteProprePage` — mais `reglages` EST delegable
  // (lib/permissions.js : seuls `facturation` et `equipe` ne le sont pas), donc
  // un collaborateur pouvait appeler cet endpoint en direct : creer un lien de
  // vente public, fixer son coefficient a 1 %, revoquer tous les liens actifs —
  // le canal de vente hors ligne — ou changer les conditions d'annulation.
  //
  // On ne detourne PAS `facturation` pour ca : ce domaine designe la
  // facturation HoteSmart, et l'y ranger tromperait la prochaine lecture. Le
  // controle est explicite, et il se leve d'une ligne le jour ou la delegation
  // du moteur sera tranchee.
  if (ecriture && garde.userId !== garde.accountUserId) {
    return res.status(403).json({ error: 'titulaire_uniquement' })
  }
  const bien = garde.bien

  try {
    // ─── Creer un lien ──────────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (body.action === 'politique') {
        // La politique d'annulation du bien. Elle est FIGEE sur chaque vente au
        // moment du paiement : la changer ici n'affecte que les ventes futures.
        // ⚠ ON VALIDE ET ON ECRIT LA MEME VALEUR. Constat de review : on validait
        // `String(body.politique)` et on ecrivait `body.politique` BRUT — un
        // tableau `['j7']` passait la liste blanche (`String(['j7']) === 'j7'`)
        // puis partait tel quel dans l'update, donnant un 500 au lieu d'un 400.
        const politique = String(body.politique)
        if (!POLITIQUES_VALIDES.includes(politique)) {
          return res.status(400).json({ error: 'politique_invalide', valides: POLITIQUES_VALIDES })
        }
        const { error } = await supabase.from('properties')
          .update({ cancellation_policy: politique })
          .eq('id', bien.id).eq('user_id', garde.accountUserId)
        if (error) throw new Error(error.message)
        return res.status(200).json({ ok: true, politique })
      }

      const coef = body.coefficient == null ? 100 : body.coefficient
      if (!coefficientValide(coef)) {
        return res.status(400).json({ error: 'coefficient_invalide' })
      }
      const { data, error } = await supabase.from('booking_links').insert({
        property_id: bien.id,
        token: nouveauJeton(),
        label: String(body.label || '').trim().slice(0, 120),
        price_coefficient: Number(coef),
        active: true
      }).select('*').maybeSingle()
      if (error) throw new Error(error.message)
      // ⚠ LE BIEN DE LA GARDE NE SUFFIT PAS. Constat de review, reproduit :
      // `resoudreBien` ne selectionne que `id, user_id, name, provider,
      // provider_property_id` — ni `base_price`, ni `inventory_units`.
      // `raisonNonVendable` y voyait donc TOUJOURS `sans_prix_de_base`, et
      // chaque creation de lien annoncait un bloquant sur un bien parfaitement
      // configure. Le test ne le voyait pas : son faux `requirePermission`
      // rendait un objet complet, la vraie garde non.
      const { data: complet } = await supabase.from('properties')
        .select('id, base_price, inventory_units, provider, provider_property_id')
        .eq('id', bien.id).maybeSingle()

      // ⚠ ON CREE, MAIS ON PREVIENT. Constat de review : l'outil de service
      // remplace avertissait avant d'ecrire (« le lien serait cree mais la page
      // publique repondrait ferme »), et ce garde-fou s'etait perdu. Sans lui,
      // l'hote voit « actif », colle l'URL sur son site, et chaque visiteur
      // recoit « ce logement n'est pas ouvert a la reservation ».
      // On n'INTERDIT pas : preparer un lien avant de renseigner le prix est
      // legitime. On le dit.
      return res.status(200).json({
        ok: true, lien: lienPublic(data), bloquant: complet ? (raisonNonVendable(complet) || null) : null
      })
    }

    // ─── Modifier ou revoquer ───────────────────────────────────────────────
    if (req.method === 'PATCH') {
      // ⚠ FORME VALIDEE AVANT LA REQUETE. Piege deja grave dans
      // lib/require-permission.js : `.eq('id', …)` sur une colonne `uuid` avec
      // une valeur qui n'en est pas fait ECHOUER la requete (« invalid input
      // syntax for type uuid ») — donc un 500, la ou l'appelant merite un 404.
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id || ''))) {
        return res.status(404).json({ error: 'lien_inconnu' })
      }

      // ⚠ LE LIEN EST CONFRONTE AU BIEN DEJA VALIDE. Sans ce filtre, un
      // identifiant de lien suffirait a modifier le lien d'un autre compte.
      const { data: existant, error: eL } = await supabase.from('booking_links')
        .select('*').eq('id', body.id).eq('property_id', bien.id).maybeSingle()
      if (eL) throw new Error(eL.message)
      if (!existant) return res.status(404).json({ error: 'lien_inconnu' })

      const maj = {}
      if (body.label !== undefined) maj.label = String(body.label || '').trim().slice(0, 120)
      if (body.coefficient !== undefined) {
        if (!coefficientValide(body.coefficient)) return res.status(400).json({ error: 'coefficient_invalide' })
        maj.price_coefficient = Number(body.coefficient)
      }
      // ⚠ REVOQUER, C'EST DESACTIVER — jamais supprimer. La provenance des
      // reservations deja creees par ce lien doit rester lisible (§3 ter,
      // ajout 4), et `booking_attempts.link_id` porte une cle etrangere
      // `on delete restrict` qui l'interdirait de toute facon.
      if (body.active !== undefined) maj.active = body.active === true

      if (!Object.keys(maj).length) return res.status(400).json({ error: 'rien_a_modifier' })

      const { data, error } = await supabase.from('booking_links')
        .update(maj).eq('id', existant.id).eq('property_id', bien.id).select('*').maybeSingle()
      if (error) throw new Error(error.message)
      return res.status(200).json({ ok: true, lien: lienPublic(data) })
    }

    // ─── Les liens d'un bien ────────────────────────────────────────────────
    const { data, error } = await supabase.from('booking_links')
      .select('*').eq('property_id', bien.id).order('created_at')
    if (error) throw new Error(error.message)
    return res.status(200).json({ liens: (data || []).map(lienPublic) })
  } catch (e) {
    console.error('[booking-links]', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }
}
