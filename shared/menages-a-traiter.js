// shared/menages-a-traiter.js — CE QUI ATTEND L'HÔTE, compté sur le cœur.
// Lot Ménages V5, étape 2 (spec §3.1 + décisions §13 et F/Q2 de
// docs/specs/inventaire-menages.md).
//
// ⚠ UNE FONCTION PURE, pas un bout d'écran. La règle « ce qui mérite une
// alerte » doit être éprouvable sans DOM ni réseau : c'est elle qui décide
// ce que l'hôte voit en rouge, et un faux positif répété lui apprend à ne
// plus regarder. Elle reçoit la réponse de `/api/garde` et rend des lignes
// prêtes à peindre ; la page les met en forme, le badge les compte.
//
// ⚠ TOUS LES FAITS VIENNENT DU CŒUR. Aucune estimation, aucun « peut-être » :
// un jour sans personne, un ménage sans preneur, un départ passé non fait,
// une remarque de propreté confirmée. Rien d'autre n'entre ici.

// L'ordre d'affichage, et l'ordre tout court : ce qui bloque la couverture
// d'abord, le reproche en dernier (spec §3.1).
export const TYPES = ['sans_personnel', 'non_assigne', 'non_pris', 'non_termine', 'mauvais_retour']
const RANG = Object.fromEntries(TYPES.map((t, i) => [t, i]))

// Un « non pris » n'est une alerte que si personne ne peut plus le prendre,
// ou si le départ est imminent (décision de Thierry, §13 / Q2) : une offre
// qui court normalement n'est pas une alerte, c'est le fonctionnement normal.
//
// ⚠ L'IMMINENCE SE COMPTE EN JOURS, pas en heures d'horloge. « 48 h » mesuré
// depuis un instant faisait apparaître l'alerte à 14 h (midi UTC moins deux
// jours) : le matin de J−2 l'hôte ne voyait rien, l'après-midi si — et la
// demi-journée perdue était celle où il regardait. Deux jours CALENDAIRES,
// c'est ce que « moins de 48 h » veut dire pour qui lit l'écran, et c'est
// insensible au fuseau (revue de c197a10).
export const JOURS_IMMINENT = 2

const cleJour = (iso) => String(iso).slice(0, 10)
function jourPlus (iso, n) {
  const d = new Date(cleJour(iso) + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// `garde` et `menages` sont ceux de /api/garde ; `biens` donne nom et photo.
// `maintenant` est injecté (règle du dépôt : un test qui lit l'horloge prend
// des dates relatives, un test qui injecte le temps prend des dates figées).
export function lignesATraiter ({ biens = [], garde = [], menages = [],
                                  avecAvis = false, aujourdhui, maintenant = Date.now() } = {}) {
  const parBien = new Map(biens.map(b => [String(b.id), b]))
  // ⚠ `gere: false` = AUCUNE prestataire liée à ce bien. Le moteur n'alerte
  // jamais dessus (« alerter à chaque départ noierait les vraies alertes sous
  // du bruit permanent », décision du 3 septembre 2026) : la bulle non plus.
  // Un hôte qui fait ses ménages lui-même verrait sinon une ligne par départ,
  // qu'il ne pourrait même pas solder — le writer de « fait » est la PWA.
  // ⚠ ABSENCE de ligne `garde` ≠ `gere: false` : sans information, on alerte.
  const nonConfie = new Set(garde.filter(g => g && g.gere === false).map(g => String(g.propertyId)))
  const lignes = []
  const ajouter = (type, bien, date, extra = {}) => {
    if (!bien) return   // un bien hors périmètre n'existe pas pour l'écran
    lignes.push({ type, bienId: String(bien.id), bienNom: bien.name || '', photo: bien.photo || null, date, ...extra })
  }

  // ─── Sans personnel : UNE ligne par bien, avec le nombre de jours ────────
  // ⚠ Les biens NON CONFIÉS en sont exclus par le serveur (`gere: false`) :
  // un hôte qui fait son ménage lui-même ne doit pas voir de rouge permanent
  // (décision du 3 septembre 2026).
  for (const g of garde) {
    if (!g || g.gere === false) continue
    const jours = (g.jours || []).filter(j => j.trou && j.date >= aujourdhui).map(j => j.date).sort()
    if (!jours.length) continue
    ajouter('sans_personnel', parBien.get(String(g.propertyId)), jours[0], { nbJours: jours.length })
  }

  const limiteImminente = jourPlus(aujourdhui, JOURS_IMMINENT)
  for (const m of menages) {
    const bien = parBien.get(String(m.propertyId))
    const passe = m.date < aujourdhui
    const tour = (m.proposeesA || []).filter(Boolean)
    const confie = !nonConfie.has(String(m.propertyId))

    // ─── Non terminé : départ passé, jamais marqué fait ───────────────────
    if (passe) {
      if (!m.fait && confie) ajouter('non_termine', bien, m.date, { qui: m.porteur || null })
      // ─── Mauvais retour : une remarque CONFIRMÉE sur un ménage fait ─────
      // (le serveur ne rend que les verdicts validés par un humain, et rien
      // du tout sans le droit `avis`.)
      // ⚠ CELUI-CI VAUT AUSSI POUR UN BIEN NON CONFIÉ : ce n'est pas une
      // alerte de couverture, c'est la parole d'un voyageur sur un séjour.
      if (avecAvis && m.retour && m.retour.verdict === 'remarque') {
        ajouter('mauvais_retour', bien, m.date, { qui: m.porteur || null, retour: m.retour })
      }
      continue
    }

    // ─── À venir ──────────────────────────────────────────────────────────
    if (!confie) continue                      // bien non confié : aucun bruit
    if (m.fait || m.porteur) continue          // quelqu'un s'en occupe
    if (tour.length) {
      // Proposé : alerte si le départ est imminent, OU si l'offre est MORTE.
      // ⚠ L'ÉCHÉANCE DÉPASSÉE COMPTE (§13 : « laissé expirer »). Le cron
      // escalade normalement, mais une panne avalée l'a déjà empêché 24 h :
      // sans ce test, une offre périmée sur un départ lointain laissait
      // l'écran annoncer le calme (revue de c197a10).
      const expiree = m.expireLe && Date.parse(m.expireLe) <= maintenant
      if (m.date <= limiteImminente || expiree) {
        ajouter('non_pris', bien, m.date, { qui: tour[0], expireLe: m.expireLe || null })
      }
      continue
    }
    // ⚠ `differe` NE SUFFIT PAS À SE TAIRE : le serveur le calcule sans
    // regarder le statut, et un ménage REFUSÉ par tout le monde (`orphaned`,
    // offres effacées, verrou `manual` — le moteur ne le reprendra pas) le
    // porte aussi. Se fier à lui seul rendait le refus invisible jusqu'à
    // J−7, alors que c'est exactement ce qui demande une décision humaine
    // (§13 : « plus de preneur possible » ; revue de c197a10).
    if (m.differe && m.status !== 'orphaned') continue
    ajouter('non_assigne', bien, m.date)
  }

  return lignes.sort((a, b) =>
    (RANG[a.type] - RANG[b.type]) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
    (a.bienNom < b.bienNom ? -1 : a.bienNom > b.bienNom ? 1 : 0))
}

// Le compte par type, pour les cinq compteurs du téléphone.
export function comptesParType (lignes) {
  const c = Object.fromEntries(TYPES.map(t => [t, 0]))
  for (const l of lignes) c[l.type]++
  return c
}
