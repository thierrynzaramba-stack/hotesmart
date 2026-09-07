// api/book-public.js
// DOC : docs/kb/moteur-reservation.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §4 (etape 1)
//
// ENDPOINT PUBLIC DU MOTEUR DE RESERVATION — LECTURE SEULE.
// Sert la page /book/<token>. Aucune authentification : le jeton EST le droit
// d'acces. Modele repris de `api/menages-public.js`, deja eprouve.
//
// CE QU'IL N'EST PAS
// - Il n'ECRIT rien. Le paiement est `api/book-pay.js`, un chemin distinct.
// - Il ne lit AUCUN provider. Les sources sont des tables HoteSmart.
//   C'est la regle d'architecture « provider -> cœur -> apps » (CLAUDE.md).
//
// CE QU'IL NE DOIT JAMAIS RENDRE
// `user_id`, le jeton du lien, son coefficient, son label, `provider*`, l'UUID
// du bien, l'adresse exacte, et la RAISON pour laquelle une nuit est
// indisponible. Un voyageur n'a pas a savoir si une nuit est fermee par choix
// ou deja vendue.
//
// PAS D'EN-TETE CORS — VOLONTAIRE
// La page est servie par le meme domaine : le navigateur n'a besoin d'aucune
// permission croisee. `Access-Control-Allow-Origin: *` laisserait n'importe quel
// site lire le calendrier de n'importe quel bien depuis le navigateur de ses
// visiteurs.
//
// PAS D'EN-TETE X-Frame-Options — VOLONTAIRE AUSSI
// Decision 3 gravee : la page reste embarquable. On n'en introduit pas.

const { createClient } = require('@supabase/supabase-js')
const {
  bornerJours,
  estDateIso,
  ajouterJours,
  raisonNonVendable,
  nuitPublique,
  validerSejour
} = require('../lib/moteur-reservation')
const { resoudreLien, chargerCalendrier } = require('../lib/moteur-coeur')
const { nuits } = require('../lib/reservation-directe')
const { paiementAutorise } = require('../lib/moteur-paiement')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

function bienPublic (bien) {
  return {
    nom: bien.name,
    ville: bien.city || null,
    pays: bien.country || null,
    devise: bien.currency || 'EUR',
    capacite: Math.max(1, Number(bien.capacity) || 1),
    voyageurs_inclus: Number(bien.included_guests) || Math.max(1, Number(bien.capacity) || 1),
    supplement_voyageur: Number(bien.extra_guest_fee) || 0,
    heure_arrivee: bien.checkin_time || null,
    heure_depart: bien.checkout_time || null,
    // §6.5 : affichee AVANT le paiement, dans la langue du voyageur.
    politique_annulation: bien.cancellation_policy || 'non_remboursable'
  }
}

// Aujourd'hui en UTC. Meme convention que lib/moteur-reservation.js : une date de
// calendrier est un jour civil, jamais un instant local.
function aujourdhui () {
  return new Date().toISOString().slice(0, 10)
}

module.exports = async function handler (req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') {
    // Cet endpoint est en lecture seule. Un POST ici n'est pas « pas encore
    // implemente », c'est hors contrat — il va sur `api/book-pay.js`.
    return res.status(405).json({ error: 'methode_non_autorisee' })
  }

  const { lien, bien, erreur } = await resoudreLien(supabase, req.query.token)
  if (erreur) return res.status(erreur === 'indisponible' ? 500 : 404).json({ error: erreur })

  // ─── Confirmation (retour depuis Stripe) ───────────────────────────────────
  // ⚠ LE MINIMUM STRICT, ET RIEN D'AUTRE (§6.3).
  // Ni e-mail, ni telephone du voyageur, ni identifiant provider, ni montant
  // brut en centimes. L'`attempt_id` est un UUID non devinable, mais une URL se
  // partage, se journalise et se retrouve dans un historique de navigateur : ce
  // qu'elle expose doit rester ce que le voyageur a DEJA sous les yeux.
  //
  // ⚠ La tentative est confrontee au LIEN : sans ce filtre, un identifiant de
  // tentative valide rendrait sa confirmation depuis n'importe quel lien, donc
  // depuis n'importe quel bien d'un autre compte.
  //
  // ⚠ PLACEE AVANT `raisonNonVendable` ET AVANT LE CALENDRIER. Constat de
  // review : plus bas, un hote qui desactive son lien ou un bien qui perd sa
  // configuration juste apres le paiement rendaient la confirmation
  // INACCESSIBLE — le voyageur revenait de Stripe et ne voyait jamais l'etat de
  // sa reservation. Elle ne depend d'aucun des deux, et chaque affichage payait
  // en plus une lecture de 365 nuits dont il n'utilise rien.
  if (req.query.action === 'confirmation') {
    const t = String(req.query.t || '')
    if (!/^[0-9a-f-]{36}$/i.test(t)) return res.status(404).json({ error: 'introuvable' })
    try {
      const { data, error } = await supabase
        .from('booking_attempts')
        .select('status, arrival, departure, guests, amount_cents, currency, cancellation_policy, lang')
        .eq('id', t).eq('link_id', lien.id).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return res.status(404).json({ error: 'introuvable' })
      return res.status(200).json({
        statut: data.status,
        arrivee: data.arrival, depart: data.departure,
        nuits: nuits(data.arrival, data.departure).length,
        voyageurs: data.guests,
        total: Math.round(Number(data.amount_cents)) / 100,
        devise: data.currency,
        politique_annulation: data.cancellation_policy || 'non_remboursable',
        bien: bienPublic(bien)
      })
    } catch (e) {
      console.error('[book-public] confirmation', e.message)
      return res.status(500).json({ error: 'indisponible' })
    }
  }

  const blocage = raisonNonVendable(bien)
  if (blocage) {
    // 200, pas 404 : le lien est valide, c'est le bien qui n'est pas ouvert a la
    // vente. La page affiche un message sobre ; `raison` sert au diagnostic.
    return res.status(200).json({ ouvert: false, raison: blocage, bien: bienPublic(bien) })
  }

  const debut = estDateIso(req.query.debut) && req.query.debut >= aujourdhui()
    ? req.query.debut
    : aujourdhui()
  const jours = bornerJours(req.query.jours)

  let calendrier
  try {
    calendrier = await chargerCalendrier(supabase, bien, lien, debut, jours)
  } catch (e) {
    console.error('[book-public] calendrier', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }

  // ─── Devis ─────────────────────────────────────────────────────────────────
  // Le total affiche au voyageur est CALCULE ICI, jamais recu de la page. C'est
  // le meme calcul que celui qui fixe le montant a encaisser dans
  // `api/book-pay.js` : le montant ne doit avoir qu'une seule source.
  if (req.query.action === 'devis') {
    const devis = validerSejour({
      calendrier,
      bien,
      lien,
      arrival: String(req.query.arrivee || ''),
      departure: String(req.query.depart || ''),
      personnes: Number(req.query.personnes)
    })
    return res.status(200).json({
      ouvert: true,
      ok: devis.ok,
      raison: devis.raison,
      minimum: devis.minimum || null,
      maximum: devis.maximum || null,
      nuits: devis.nuits.length,
      detail: devis.ok ? devis.detail : [],
      total: devis.total,
      devise: bien.currency || 'EUR'
    })
  }

  // ─── Le paiement est-il possible pour CE bien ? ────────────────────────────
  // La page doit le savoir avant d'afficher un bouton : proposer de payer puis
  // echouer sur le clic est la pire des sequences.
  // On ne rend RIEN du compte Stripe de l'hote — ni cle, ni identifiant, ni
  // etat du webhook. Seulement : peut-on payer, et dans quel mode.
  // Le MODE est publie a dessein : une page en mode test doit le dire, sinon un
  // voyageur croit avoir paye.
  let paiement = { actif: false, mode: null }
  try {
    const { data } = await supabase
      .from('stripe_accounts').select('mode, webhook_endpoint_id, webhook_secret_cipher')
      .eq('user_id', bien.user_id).maybeSingle()
    // Il faut une cle ET de quoi recevoir la confirmation : sans webhook, un
    // paiement aboutirait sans que rien ne le sache.
    const pret = !!(data && (data.webhook_endpoint_id || data.webhook_secret_cipher))
    paiement = { actif: pret && paiementAutorise(), mode: data ? data.mode : null }
  } catch (e) {
    // Un echec ici n'empeche pas de CONSULTER le calendrier : on degrade vers
    // « paiement indisponible » plutot que de rendre la page inaccessible.
    console.error('[book-public] etat paiement', e.message)
  }

  return res.status(200).json({
    ouvert: true,
    bien: bienPublic(bien),
    paiement,
    debut,
    jours,
    // Le lendemain de la derniere nuit publiee est un DEPART valide : on n'y dort
    // pas. Sans cette borne, la page rendait la derniere nuit de la fenetre
    // inreservable alors que le serveur, lui, l'acceptait.
    depart_max: calendrier.length ? ajouterJours(calendrier[calendrier.length - 1].date, 1) : debut,
    nuits: calendrier.map(nuitPublique)
  })
}
