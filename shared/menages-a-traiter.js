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
// `pas_vu` se place APRES les trois alertes de couverture et AVANT le passe :
// « personne ne viendra » est plus grave que « quelqu'un viendra peut-etre
// sans le savoir », qui est plus urgent qu'un depart deja manque.
// ⚠ IL A PORTE LE NOM `non_valide` QUELQUES HEURES, le 14 octobre 2026, le
// temps que Thierry tranche le vocabulaire : « Vu » / « Pas vu » partout,
// jamais « valider ». Ce qu'il MESURE a bien change ce jour-la — non plus
// « elle n'a pas ouvert sa page » (un indice de remplacement, par LIEN et pour
// tous ses menages a la fois) mais « elle n'a pas vu CE menage », le bouton
// oeil de sa page. Le nom, lui, est redevenu le bon.
export const TYPES = ['sans_personnel', 'non_assigne', 'non_pris', 'pas_vu', 'non_termine', 'mauvais_retour']
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

// ⚠ LA BORNE DE L'IMMINENCE, EXPORTEE — une seule fois, pour un seul calcul.
// La bulle et l'en-tete de la fiche prestataire doivent crier sur EXACTEMENT
// la meme fenetre : un bandeau vert au-dessus d'une ligne rouge sur la meme
// personne est ce qu'un hote ne pardonne pas. Recopier `jourPlus(auj, 2)` dans
// la page garantissait qu'un jour l'un des deux change seul.
export const limiteDeLImminence = (aujourdhui) => jourPlus(aujourdhui, JOURS_IMMINENT)

// ⚠ « ELLE NE L'A PAS VU » EST UNE SEULE REGLE, PARTAGEE. L'en-tete de sa
// fiche (« A jour » / « Pas vu ») et la bulle « A traiter » posent la MEME
// question, sur la MEME fenetre. Deux implementations auraient fini par se
// contredire sur le meme ecran, et c'est exactement ce qu'un hote ne pardonne
// pas : un bandeau vert au-dessus d'une ligne rouge sur la meme personne.
//
// ⚠ DEUX SITUATIONS, DEUX SOURCES — et c'est le changement du 14 octobre 2026 :
//
//   - ELLE LE PORTE. La question se tranche sur CE menage : `vuLe`, pose par le
//     bouton « Vu » de sa page (et par les deux gestes qui valent deja oui,
//     accepter une proposition et prendre un menage libre). C'est une reponse
//     exacte, la ou « a-t-elle ouvert sa page ? » n'etait qu'un indice de
//     remplacement : elle ouvre sa page lundi, l'hote lui ajoute un menage
//     mardi, et plus rien ne distinguait les deux.
//
//   - ON LUI PROPOSE. Il n'y a rien a valider : accepter EST la validation, et
//     l'offre a sa propre boucle (echeance, escalade, relance). La seule
//     question qui reste est « sait-elle qu'on lui demande quelque chose ? »,
//     et c'est la derniere ouverture de sa page qui y repond, comme avant.
//
// Rend `null` quand on ne peut RIEN conclure :
//   - `m.vuLe === undefined` (porteuse) : le serveur ne sert pas la colonne —
//     on se TAIT plutot que d'accuser tout le monde ;
//   - `vueLe === undefined` (proposee) : on ne sait pas (lien supprime,
//     lecture en panne) ;
//   - aucun jalon connu cote proposition : accuser sur une date qu'on ignore
//     serait au hasard.
// Rend `true` quand elle est concernee et ne l'a pas vu ; `false` sinon.
export function nonVuPar (m, profilId, vueLe) {
  if (!m) return null
  const id = String(profilId || '')
  if (!id) return null
  const porte = m.porteur && String(m.porteur.id) === id
  const propose = (m.proposeesA || []).filter(Boolean).some(q => String(q.id) === id)
  if (!porte && !propose) return false
  // ⚠ LA PORTEUSE NE DEPEND PLUS DE `vueLe` DU TOUT : l'alerte tient donc meme
  // quand la lecture des ouvertures de liens est en panne. C'est le menage
  // lui-meme qui porte la reponse.
  if (porte) {
    if (m.vuLe === undefined) return null
    return !m.vuLe
  }
  if (vueLe === undefined) return null
  // ⚠ JAMAIS OUVERTE ALERTE SANS CONDITION DE DATE : c'est le cas le plus
  // grave, et il n'a aucun jalon a comparer.
  if (vueLe === null) return true
  const jalons = [(m.etapes || {}).propose, m.noteLe]
    .filter(Boolean).map(x => Date.parse(x)).filter(x => Number.isFinite(x))
  if (!jalons.length) return null
  const vu = Date.parse(vueLe)
  if (!Number.isFinite(vu)) return null
  return jalons.some(j => j > vu)
}

// `garde` et `menages` sont ceux de /api/garde ; `biens` donne nom et photo.
// `maintenant` est injecté (règle du dépôt : un test qui lit l'horloge prend
// des dates relatives, un test qui injecte le temps prend des dates figées).
// `vues` est la carte `{ profilId: instant | null }` de /api/garde — null =
// ce lien n'a jamais ete ouvert, ABSENT = on ne sait rien de cette personne.
// `vuesLues = false` dit que la lecture a echoue : on se tait alors.
export function lignesATraiter ({ biens = [], garde = [], menages = [],
                                  avecAvis = false, aujourdhui, maintenant = Date.now(),
                                  vues = null, vuesLues = false } = {}) {
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

  const limiteImminente = limiteDeLImminence(aujourdhui)
  // ─── « Pas vu » : une ligne par PERSONNE, son menage le plus proche ──────
  // On accumule pendant la boucle, on tranche apres : trois departs qu'elle
  // n'a pas vus sont un seul coup de telephone.
  const pasVus = new Map()
  for (const m of menages) {
    const bien = parBien.get(String(m.propertyId))
    const passe = m.date < aujourdhui
    const tour = (m.proposeesA || []).filter(Boolean)
    const confie = !nonConfie.has(String(m.propertyId))

    // ─── Non terminé : départ passé, jamais marqué fait ───────────────────
    if (passe) {
      if (!m.fait && confie) ajouter('non_termine', bien, m.date, { bookingId: String(m.bookingId), qui: m.porteur || null })
      // ─── Mauvais retour : une remarque CONFIRMÉE sur un ménage fait ─────
      // (le serveur ne rend que les verdicts validés par un humain, et rien
      // du tout sans le droit `avis`.)
      // ⚠ CELUI-CI VAUT AUSSI POUR UN BIEN NON CONFIÉ : ce n'est pas une
      // alerte de couverture, c'est la parole d'un voyageur sur un séjour.
      if (avecAvis && m.retour && m.retour.verdict === 'remarque') {
        ajouter('mauvais_retour', bien, m.date, { bookingId: String(m.bookingId), qui: m.porteur || null, retour: m.retour })
      }
      continue
    }

    // ─── Elle ne sait peut-être pas qu'elle doit venir ────────────────────
    // ⚠ CE N'EST PAS UNE ALERTE DE COUVERTURE, donc elle vaut AUSSI sur un
    // bien non confié : quelqu'un est dessus, par la main de l'hôte ou par le
    // moteur, et le logement sera découvert si cette personne ne l'a pas lu.
    // Trois conditions, toutes nécessaires : elle porte ou on lui propose ·
    // elle n'a pas validé (la règle ci-dessus) · le départ est proche.
    //
    // ⚠ L'IMMINENCE SE COMPTE EN JOURS CALENDAIRES, comme `non_pris` : la
    // même borne, pour que deux alertes du même écran ne se contredisent pas.
    // ⚠ ET LE PASSÉ EST EXCLU DEPUIS LE 14 OCTOBRE 2026 (`m.date >=
    // aujourdhui`). Avec `vuLe`, un départ de la semaine dernière jamais
    // validé alerterait pour toujours — alors que `non_termine` le dit déjà,
    // et mieux : on ne demande pas de valider ce qui est derrière. Même borne
    // que le bouton de sa page (`estAValider`).
    // ⚠ UN MENAGE DEJA MARQUE FAIT NE DIT RIEN : elle y est allee, savoir
    // si elle l'avait valide n'apprend plus rien a personne.
    // ⚠ LA LECTURE DES OUVERTURES N'EST PLUS UNE CONDITION D'ENTREE : la
    // porteuse se juge sur le menage. Elle ne commande plus que le cas de la
    // PROPOSITION, et c'est pourquoi le test est descendu dans la boucle.
    if (!m.fait && m.date >= aujourdhui && m.date <= limiteImminente) {
      for (const q of [m.porteur, ...tour].filter(Boolean)) {
        const vid = String(q.id || '')
        if (!vid) continue
        const porte = m.porteur && String(m.porteur.id) === vid
        // ⚠ ABSENT DE LA CARTE ≠ JAMAIS OUVERTE. Une personne dont on ne lit
        // pas le lien (retirée de l'équipe, lien supprimé) ne produit aucune
        // alerte de PROPOSITION : on n'invente pas une page jamais ouverte sur
        // un lien qui n'existe plus. Seul un `null` EXPLICITE veut dire
        // « jamais ». La porteuse, elle, ne lit pas cette carte.
        let vueLe
        const carteLue = !!(vuesLues && vues)
        const connue = carteLue && Object.prototype.hasOwnProperty.call(vues, vid)
        if (!porte) {
          if (!connue) continue
          vueLe = vues[vid]
        } else {
          // ⚠ PAS DE LIEN, PAS D'ALERTE — MÊME POUR LA PORTEUSE (constat de la
          // revue de 20fb83d). Une personne ABSENTE d'une carte LUE n'a aucune
          // ligne `public_tokens` : elle n'a pas de page, donc aucun moyen de
          // valider. La ligne « Non validé » resterait rouge jusqu'au départ
          // sans qu'aucun geste puisse l'éteindre — et une alerte qu'on ne peut
          // pas résoudre est exactement ce qui apprend à ne plus regarder.
          // ⚠ ABSENTE D'UNE CARTE LUE ≠ CARTE NON LUE. Une panne de lecture
          // (`vuesLues: false`) ne dit rien de personne : l'alerte TIENT alors,
          // et c'est tout l'intérêt d'avoir déplacé la règle sur le ménage.
          if (carteLue && !connue) continue
          // La date d'ouverture n'entre pas dans la règle de la porteuse :
          // elle n'est gardée que pour l'AFFICHER (« page vue il y a 2 h, et
          // toujours pas validé » se décide autrement que « page jamais
          // ouverte »). `undefined` = on ne le dira pas.
          if (connue) vueLe = vues[vid]
        }
        // La règle vit au-dessus, et la fiche de la personne lit la MÊME.
        if (nonVuPar(m, vid, vueLe) !== true) continue
        const vu = pasVus.get(vid)
        if (!vu || m.date < vu.date) {
          pasVus.set(vid, { qui: q, date: m.date, bien, bookingId: String(m.bookingId),
                            vueLe, nbMenages: (vu ? vu.nbMenages : 0) + 1 })
        } else {
          vu.nbMenages++
        }
      }
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
        ajouter('non_pris', bien, m.date, { bookingId: String(m.bookingId), qui: tour[0], expireLe: m.expireLe || null })
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
    ajouter('non_assigne', bien, m.date, { bookingId: String(m.bookingId) })
  }

  for (const v of pasVus.values()) {
    ajouter('pas_vu', v.bien, v.date, { bookingId: v.bookingId, qui: v.qui,
                                        vueLe: v.vueLe, nbMenages: v.nbMenages })
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
