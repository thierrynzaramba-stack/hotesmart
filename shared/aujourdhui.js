// shared/aujourdhui.js — LES REGLES DE LA PAGE « AUJOURD'HUI » (refonte UI V5,
// lot 1 ; spec docs/specs/spec-refonte-ui-v5.md §4, KB docs/kb/aujourdhui.md).
//
// ⚠ DES FONCTIONS PURES. Ce module ne parle a aucune API et n'ecrit rien : la
// page charge (endpoints existants, tables du coeur lues sous RLS), ce module
// COMPTE. Une regle de comptage vit ici et nulle part ailleurs — l'ordinateur
// et le telephone sont la meme page, mais la regle doit pouvoir etre testee
// sans navigateur (tests/aujourdhui.test.js).
//
// ⚠ FAITS COMPTES, JAMAIS D'ESTIMATION (spec §1, principe 3). Une fonction qui
// ne peut pas compter proprement rend `null`, jamais 0 : la page affiche alors
// « non calculable », pas un chiffre faux et credible.

// Jour calendaire de Paris (celui des biens), YYYY-MM-DD, a `decalage` jours.
// Meme regle que api/messages.js (`jourParis`).
export function jourParis (maintenant = Date.now(), decalage = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })
    .format(new Date(maintenant + decalage * 86400000))
}

// YYYY-MM-DD decale de n jours, par arithmetique UTC sur la DATE : jamais
// « maintenant + n x 24 h », qui glisse d'un jour au changement d'heure
// pres de minuit (constat de revue).
export function ajouterJours (jour, n) {
  const [y, m, d] = String(jour).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Ecart en jours entre deux YYYY-MM-DD (b - a), sans fuseau ni heure d'ete.
export function joursEntre (a, b) {
  const [ya, ma, da] = String(a).slice(0, 10).split('-').map(Number)
  const [yb, mb, db] = String(b).slice(0, 10).split('-').map(Number)
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000)
}

// « 11:00:00 » ou « 11:00 » -> « 11:00 ». Rien d'exploitable -> null.
export function heureCourte (h) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h || '').trim())
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

// ─── Les arrivees et departs du jour ────────────────────────────────────────
// `bookings` : la reponse de GET /api/menages (reservations ACTIVES seulement,
// filtrees par la couche sync : annulations et blocages proprietaire exclus).
// `biens` : properties lues sous RLS, cle `provider_property_id`.
// `menages` / `prestataires` : la meme reponse de /api/menages.
// `etatsArrivee` : { [booking_id]: { codeEtat } } venu de GET /api/messages.
//
// Une ligne demande une action (pastille ambre + bouton) dans deux cas, tous
// deux PROUVES par le coeur :
//   - arrivee dont le code existe mais n'a pas ete transmis (codeEtat 'cree') ;
//   - depart dont le menage n'a personne (statut 'unassigned' ou 'orphaned').
export function evenementsDuJour ({ bookings = [], biens = [], menages = [], prestataires = [],
  etatsArrivee = {}, aujourdHui }) {
  const bienParRef = new Map(biens.map(b => [String(b.provider_property_id), b]))
  // ⚠ `prenom`, pas `first_name` : c'est le nom du champ dans la reponse de
  // /api/menages (constat de revue — la fixture d'origine figeait le bug).
  const prenomParId = new Map(prestataires.map(p => [String(p.id), p.prenom || '']))
  const menageParResa = new Map(menages.map(m => [`${m.property_id}|${m.booking_id}`, m]))
  const out = []
  for (const r of bookings) {
    const bien = bienParRef.get(String(r.propId))
    if (!bien) continue
    const voyageur = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null
    const base = { bookingId: String(r.id), bienRef: String(r.propId), bienId: bien.id, bien: bien.name, voyageur }
    if (r.arrival === aujourdHui) {
      const etat = etatsArrivee[String(r.id)] || null
      const codeEtat = etat ? etat.codeEtat : null
      out.push({
        ...base,
        type: 'arrivee',
        heure: heureCourte(bien.checkin_time),
        nuits: r.departure ? joursEntre(r.arrival, r.departure) : null,
        codeEtat,
        action: codeEtat === 'cree' ? 'code' : null
      })
    }
    if (r.departure === aujourdHui) {
      const m = menageParResa.get(`${r.propId}|${r.id}`) || null
      const statut = m ? m.status : null
      const prestataire = m && m.provider_id ? (prenomParId.get(String(m.provider_id)) || null) : null
      // ⚠ LE TOUR : `proposee_a` fait foi, `offered_to` n'est lu que pour une
      // ligne d'avant la bascule — meme regle que `tourDe` du planning menage
      // (apps/menages/index.html). Une proposition en cours n'est pas « personne ».
      const tour = !m ? [] : (Array.isArray(m.proposee_a) && m.proposee_a.length)
        ? m.proposee_a : (m.offered_to ? [m.offered_to] : [])
      const proposeeA = tour.map(id => prenomParId.get(String(id))).filter(Boolean).join(', ') || null
      const sansPersonne = (statut === 'unassigned' || statut === 'orphaned') && !tour.length
      out.push({
        ...base,
        type: 'depart',
        heure: heureCourte(bien.checkout_time),
        menage: { statut: tour.length && !m.provider_id ? 'offered' : statut, prestataire, proposeeA },
        action: sansPersonne ? 'menage' : null
      })
    }
  }
  // Chronologique ; sans heure connue, en fin de liste ; departs avant
  // arrivees a heure egale (le logement se libere avant d'etre occupe).
  const rang = e => (e.heure || '99:99') + (e.type === 'depart' ? '0' : '1')
  return out.sort((a, b) => rang(a).localeCompare(rang(b)) || a.bien.localeCompare(b.bien))
}

// ─── Etat de chaque bien ce soir, et sa prochaine arrivee ───────────────────
export function etatDesBiens ({ bookings = [], biens = [], aujourdHui }) {
  const out = new Map()
  for (const b of biens) out.set(String(b.provider_property_id), { occupeCeSoir: false, prochaineArrivee: null })
  for (const r of bookings) {
    const e = out.get(String(r.propId))
    if (!e || !r.arrival || !r.departure) continue
    if (r.arrival <= aujourdHui && aujourdHui < r.departure) e.occupeCeSoir = true
    if (r.arrival >= aujourdHui && (!e.prochaineArrivee || r.arrival < e.prochaineArrivee)) {
      e.prochaineArrivee = r.arrival
    }
  }
  return out
}

// ─── Chiffres d'un bien sur une fenetre, depuis /api/yield (granularite jour) ─
// `realise` : les periodes jour du moteur YieldFlow (lib/yield/indicateurs.js).
// Le CA y est deja reparti par nuit et reconstruit au prix VOYAGEUR
// (docs/kb/prix-voyageur.md) : on ne fait que sommer.
//
// CA `null` si une nuit occupee n'a pas de prix connu (la somme serait un
// minorant presente comme un total). Occupation `null` si un seul jour n'a pas
// de capacite calculable (docs/kb/capacite-yield.md : « non calculable »
// n'est jamais zero) OU si sa capacite est ESTIMEE (`capacite_estimee` : pas
// de ligne d'intention ce jour-la) — un taux sur un denominateur estime n'est
// pas un fait compte (spec §1, principe 3).
// ⚠ Le numerateur de l'occupation est celui du moteur : les nuits vendues
// un jour en exception sortent du taux, comme ce jour sort des jours ouverts
// (lib/yield/indicateurs.js, `nuiteesRef` ; sinon 300 % sur un bien en
// exception). Le CA, lui, garde toutes les nuits.
export function chiffresFenetre (realise = [], debut, fin) {
  const jours = realise.filter(p => p.periode >= debut && p.periode <= fin)
  const attendus = joursEntre(debut, fin) + 1
  let ca = 0, nuitees = 0, ouverts = 0
  let caComplet = jours.length === attendus
  let occCalculable = jours.length === attendus
  for (const p of jours) {
    ca += Number(p.ca) || 0
    nuitees += (Number(p.nuitees) || 0) - (Number(p.nuitees_hors_reference) || 0)
    if (Number(p.nuits_a_prix_connu) < Number(p.nuitees)) caComplet = false
    if (p.jours_ouverts == null || p.capacite_estimee) occCalculable = false
    else ouverts += Number(p.jours_ouverts)
  }
  return {
    ca: caComplet ? Math.round(ca * 100) / 100 : null,
    nuitees,
    joursOuverts: occCalculable ? ouverts : null
  }
}

// Variation relative (0,12 pour +12 %). `null` des que la base manque ou vaut
// zero : une hausse « infinie » n'est pas un fait.
export function variation (actuel, precedent) {
  if (actuel == null || precedent == null || !(precedent > 0)) return null
  return (actuel - precedent) / precedent
}

// Taux d'occupation d'une fenetre ; `null` si non calculable ou sans jour ouvert.
export function occupation (nuitees, joursOuverts) {
  if (joursOuverts == null || !(joursOuverts > 0)) return null
  return nuitees / joursOuverts
}

// ─── Min / max du CA mensuel sur 12 mois, PAR BIEN ──────────────────────────
// `realise` : les periodes mois de /api/yield. Un mois ne compte que s'il a ete
// ouvert a la vente (jours_ouverts > 0) et que toutes ses nuits ont un prix :
// un mois ou le bien n'existait pas n'est pas un « minimum a 0 € ».
export function minMaxMensuel (realise = [], moisDebut, moisFin) {
  const mois = realise.filter(p => p.periode >= moisDebut && p.periode <= moisFin
    && Number(p.jours_ouverts) > 0
    && !(Number(p.nuits_a_prix_connu) < Number(p.nuitees)))
  if (!mois.length) return null
  const cas = mois.map(p => Number(p.ca) || 0)
  return { min: Math.min(...cas), max: Math.max(...cas), mois: mois.length }
}

// ─── Les douze derniers mois COMPLETS (le mois en cours fausserait le min) ───
export function douzeMoisComplets (aujourdHui) {
  const [a, m] = aujourdHui.split('-').map(Number)
  const cle = (an, mo) => `${an}-${String(mo).padStart(2, '0')}`
  const fin = m === 1 ? [a - 1, 12] : [a, m - 1]
  const debut = fin[1] === 12 ? [fin[0], 1] : [fin[0] - 1, fin[1] + 1]
  const dernierJour = new Date(Date.UTC(fin[0], fin[1], 0)).toISOString().slice(0, 10)
  return {
    moisDebut: cle(...debut), moisFin: cle(...fin),
    jourDebut: `${cle(...debut)}-01`, jourFin: dernierJour
  }
}

// ─── Totaux du compte, a partir des chiffres par bien ───────────────────────
// Un bien PAS RACCORDE (aucun provider_property_id : /api/yield repond 409) n'a
// rien vendu par nous : il est hors du total, sans le rendre faux. Toute autre
// lecture en echec rend le total non calculable — un total ampute serait faux.
export function totaux (parBien = []) {
  let ca = 0, caPrec = 0, nuitees = 0, nuiteesPrec = 0, ouverts = 0, ouvertsPrec = 0
  let caOk = true, caPrecOk = true, occOk = true, occPrecOk = true
  let comptes = 0
  for (const b of parBien) {
    if (b.nonRaccorde) continue
    if (!b.actuel || !b.precedent) { caOk = caPrecOk = occOk = occPrecOk = false; continue }
    comptes++
    if (b.actuel.ca == null) caOk = false; else ca += b.actuel.ca
    if (b.precedent.ca == null) caPrecOk = false; else caPrec += b.precedent.ca
    if (b.actuel.joursOuverts == null) occOk = false
    else { nuitees += b.actuel.nuitees; ouverts += b.actuel.joursOuverts }
    if (b.precedent.joursOuverts == null) occPrecOk = false
    else { nuiteesPrec += b.precedent.nuitees; ouvertsPrec += b.precedent.joursOuverts }
  }
  if (!comptes) return { ca: null, caVariation: null, occupation: null, occupationEcart: null }
  const occ = occOk ? occupation(nuitees, ouverts) : null
  const occPrec = occPrecOk ? occupation(nuiteesPrec, ouvertsPrec) : null
  return {
    ca: caOk ? Math.round(ca * 100) / 100 : null,
    caVariation: caOk && caPrecOk ? variation(ca, caPrec) : null,
    occupation: occ,
    // L'occupation varie en POINTS, pas en pourcentage d'elle-meme.
    occupationEcart: occ != null && occPrec != null ? occ - occPrec : null
  }
}
