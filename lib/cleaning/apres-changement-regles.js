// lib/cleaning/apres-changement-regles.js
// CE QUI SE PASSE QUAND ELLE CHANGE SES JOURS DEPUIS SA PWA.
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// ⚠ LE PENDANT OBLIGATOIRE DE LA DECISION DU 15 SEPTEMBRE 2026. Ce jour-la, la
// prestataire a recu la main sur ses jours habituels. La garde d'avant — « les
// regles restent a l'hote » — n'etait pas un verrou de code, c'etait cette
// decision. En la levant, on a ouvert deux trous, et ce module les ferme :
//   1. l'hote ne l'apprenait pas ;
//   2. les menages DEJA PROPOSES sur les jours retires restaient proposes a
//      quelqu'un qui venait de dire qu'elle ne travaillait plus ce jour-la.
//
// ⚠ ON NE TOUCHE JAMAIS UN MENAGE ACCEPTE. Un engagement ne se defait que par un
// humain : elle a dit oui, quelqu'un compte dessus, et l'alerte de refus existe
// deja pour ce cas. On ne reprend que ce qui n'engage personne — une PROPOSITION
// en attente.
//
// ⚠ BEST-EFFORT, ET C'EST VOULU. L'ecriture des regles est deja faite quand on
// arrive ici : un echec de notification ne doit ni la defaire, ni faire echouer
// la requete. La verite reste la base.

const { createClient } = require('@supabase/supabase-js')
const { resumerChangement } = require('./changement-regles')
const { alertReglesModifiees } = require('../alert-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ UNE FENETRE, PAS TOUT L'AVENIR. Un an devant, comme le calendrier : au-dela,
// aucun menage n'existe encore, et une lecture sans borne se ferait tronquer en
// silence — donc des menages laisses proposes sans que rien ne le dise.
const HORIZON_JOURS = 400
const LOT_MENAGES = 500

const jourIso = d => d.toISOString().slice(0, 10)

// Les menages PROPOSES a cette personne, dans la fenetre, sur les jours perdus.
//
// ⚠ ON FILTRE LE JOUR DE SEMAINE EN JS, PAS EN SQL. PostgREST n'expose pas
// `extract(dow from ...)` : le faire en base demanderait une vue ou une fonction,
// pour une liste deja bornee a quelques dizaines de lignes.
async function menagesAReprendre ({ userId, providerId, perdus, maintenant }) {
  const debut = jourIso(maintenant)
  const fin = jourIso(new Date(maintenant.getTime() + HORIZON_JOURS * 86400000))
  const { data, error } = await supabase.from('menages')
    .select('id, property_id, departure_date, status, provider_id, offered_to, assigned_by')
    .eq('user_id', userId)
    .eq('offered_to', providerId)
    .gte('departure_date', debut).lte('departure_date', fin)
    .limit(LOT_MENAGES)
  if (error) {
    console.error('[apres-changement-regles] lecture menages echec:', error.message)
    return { erreur: true, menages: [] }
  }
  const vises = (data || []).filter(m => {
    // ⚠ TROIS GARDES, ET CHACUNE A SA RAISON.
    // - `provider_id` : quelqu'un PORTE deja ce menage. La proposition vit a
    //   cote ; la retirer ne libere rien et effacerait une sollicitation.
    // - `assigned_by === 'manual'` : le verrou de l'hote (§3). Une decision
    //   humaine ne se defait pas par un calcul.
    // - statut clos : rien a reprendre.
    if (m.provider_id) return false
    if (m.assigned_by === 'manual') return false
    if (m.status === 'cancelled' || m.status === 'orphaned') return false
    const d = new Date(m.departure_date + 'T12:00:00Z')
    return perdus.includes(d.getUTCDay())
  })
  return { erreur: false, menages: vises }
}

// Rend la proposition au moteur : il repassera au cycle suivant.
//
// ⚠ ON NE RECALCULE PAS ICI, ON REND LA MAIN. `sync-menages-entite` reevalue a
// chaque cycle tout menage sans porteur, sans offre et sans verrou : remettre
// ces deux champs a zero suffit a le lui confier, avec sa garde d'engagement,
// son escalade et sa memoire des refus. Recopier `deciderParGarde` ici aurait
// fait un second moteur — et c'est la faute que ce depot a deja payee.
async function rendreAuMoteur (menages, prenom) {
  let repris = 0
  for (const m of menages) {
    const { error } = await supabase.from('menages')
      .update({ offered_to: null, offered_at: null, offer_expires_at: null,
                status: 'unassigned',
                assignment_reason:
                  `${prenom || 'La prestataire'} ne travaille plus ce jour-la : ` +
                  'proposition reprise, a reattribuer.',
                updated_at: new Date().toISOString() })
      // ⚠ `.eq('offered_to', ...)` DANS L'UPDATE, pas seulement dans la lecture.
      // Entre les deux, elle a pu accepter depuis son telephone : sans cette
      // condition, on effacerait une acceptation qui vient d'arriver.
      .eq('id', m.id).eq('offered_to', m.offered_to).is('provider_id', null)
    if (error) { console.error('[apres-changement-regles] reprise echec:', error.message); continue }
    repris++
  }
  return repris
}

// Le point d'entree. Ne leve jamais.
async function apresChangementDeRegles ({ userId, providerId, prenom, avant, apres,
                                          maintenant = new Date() }) {
  const bilan = { annonce: false, repris: 0, menages: [] }
  try {
    const resume = resumerChangement({
      avant, apres, prenom,
      aPartirDe: new Date(maintenant).toLocaleDateString('fr-FR',
        { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })
    })
    // ⚠ SE TAIRE QUAND RIEN N'A CHANGE. L'ecran renvoie tout le reglage a chaque
    // geste : rouvrir l'onglet et recocher le meme jour produit une ecriture
    // sans changement reel. Alerter dessus apprendrait a l'hote a ignorer ces
    // messages — et c'est celui-la qu'il ne faut pas apprendre a ignorer.
    if (!resume) return bilan

    let repris = []
    if (resume.perdus.length) {
      const r = await menagesAReprendre({ userId, providerId, perdus: resume.perdus, maintenant })
      if (!r.erreur && r.menages.length) {
        bilan.repris = await rendreAuMoteur(r.menages, prenom)
        repris = r.menages
        bilan.menages = r.menages.map(m => ({ propertyId: String(m.property_id),
                                              depart: m.departure_date }))
      }
    }

    // ⚠ LE BIEN SERT AU ROUTAGE, PAS AU SENS. `sendAlertNotifications` lit la
    // configuration d'alerte PAR BIEN : sans identifiant de bien, le message ne
    // partirait a personne. On prend donc celui d'un menage repris — celui ou
    // l'hote a quelque chose a faire — et a defaut n'importe lequel des siens.
    const bien = repris.length ? String(repris[0].property_id)
                               : await unBienDElle(userId, providerId)
    bilan.annonce = await alertReglesModifiees({
      userId, providerId, propertyId: bien, prenom,
      texte: resume.texte,
      menagesRepris: bilan.menages
    })
  } catch (e) {
    console.error('[apres-changement-regles] echec:', e.message)
  }
  return bilan
}

async function unBienDElle (userId, providerId) {
  const { data, error } = await supabase.from('property_cleaning_providers')
    .select('property_id').eq('user_id', userId).eq('provider_id', providerId)
    .eq('active', true).limit(1)
  if (error || !data || !data.length) return null
  return String(data[0].property_id)
}

module.exports = { apresChangementDeRegles, menagesAReprendre, HORIZON_JOURS }
