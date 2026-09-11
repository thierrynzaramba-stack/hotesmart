// lib/yield/zones-scolaires.js
// DOC : docs/kb/evenements-yield.md (modif = MEME COMMIT)
//
// Correspondance departement -> zone de vacances scolaires, et conversion des
// instants servis par data.education.gouv.fr en dates LOCALES.
//
// Fonctions PURES : aucun acces base, aucun reseau. C'est ce qui permet de les
// tester exhaustivement, et la raison pour laquelle les deux pieges ci-dessous
// sont fermes ici plutot que dans le script d'import.

// ─── Zones officielles, par academie ────────────────────────────────────────
// Source : arrete du calendrier scolaire. Stable depuis 2016 ; la derniere
// refonte (fusion des academies de Normandie) est anterieure.
// ⚠ ECRITE PAR ACADEMIE, ET C'EST DELIBERE.
// La premiere version listait les departements a plat, zone par zone : le 72
// (Sarthe) s'y etait glisse en zone A alors qu'il releve de l'academie de
// Nantes, donc de la zone B. Un bien manceau aurait ete place en vacances aux
// dates de Lyon au lieu de celles de Nantes — deux semaines d'ecart sur la
// Toussaint, l'hiver et le printemps, TOUS LES ANS. Et le test d'integrite ne
// l'attrapait pas : il verifiait la couverture 01-95 et l'absence de doublon,
// c'est-a-dire la FORME, jamais l'exactitude de l'affectation.
//
// Regroupee par academie, la table se relit contre l'arrete officiel ligne a
// ligne, et le test compare desormais academie par academie.
const ACADEMIES = {
  A: {
    'Besançon':         ['25', '39', '70', '90'],
    'Bordeaux':         ['24', '33', '40', '47', '64'],
    'Clermont-Ferrand': ['03', '15', '43', '63'],
    'Dijon':            ['21', '58', '71', '89'],
    'Grenoble':         ['07', '26', '38', '73', '74'],
    'Limoges':          ['19', '23', '87'],
    'Lyon':             ['01', '42', '69'],
    'Poitiers':         ['16', '17', '79', '86']
  },
  B: {
    'Aix-Marseille':    ['04', '05', '13', '84'],
    'Amiens':           ['02', '60', '80'],
    'Lille':            ['59', '62'],
    'Nancy-Metz':       ['54', '55', '57', '88'],
    'Nantes':           ['44', '49', '53', '72', '85'],
    'Nice':             ['06', '83'],
    'Normandie':        ['14', '27', '50', '61', '76'],
    'Orléans-Tours':    ['18', '28', '36', '37', '41', '45'],
    'Reims':            ['08', '10', '51', '52'],
    'Rennes':           ['22', '29', '35', '56'],
    'Strasbourg':       ['67', '68']
  },
  C: {
    'Créteil':          ['77', '93', '94'],
    'Montpellier':      ['11', '30', '34', '48', '66'],
    'Paris':            ['75'],
    'Toulouse':         ['09', '12', '31', '32', '46', '65', '81', '82'],
    'Versailles':       ['78', '91', '92', '95']
  }
}

// Vue a plat, derivee — jamais saisie a la main.
const ZONE_PAR_DEPARTEMENT = Object.fromEntries(
  Object.entries(ACADEMIES).map(([zone, ac]) => [zone, Object.values(ac).flat()])
)

// Index inverse, construit une fois.
const INDEX = {}
for (const [zone, deps] of Object.entries(ZONE_PAR_DEPARTEMENT)) {
  for (const d of deps) INDEX[d] = zone
}

// ⚠ LE DEPARTEMENT SE LIT SUR LE CODE POSTAL, PAS SUR LA VILLE.
// Mesure du 12 septembre 2026 : un bien porte `city = 'comomiers'` (faute de
// frappe) avec `zip_code = '31770'`. Chercher par nom de ville aurait rendu
// « inconnu » sur un bien parfaitement localise. Le code postal est saisi par
// le provider, pas tape a la main.
//
// La Corse (2A/2B) et les DOM (971+) ont leurs propres calendriers, absents de
// la table ci-dessus : on rend `null` plutot que de deviner.
function departementDuCodePostal (cp) {
  const v = String(cp || '').trim()
  if (!/^\d{5}$/.test(v)) return null
  // 97xxx / 98xxx : DOM-TOM, sur 3 chiffres.
  if (v.startsWith('97') || v.startsWith('98')) return v.slice(0, 3)
  // 20xxx : Corse, que ce format ne distingue pas (2A/2B).
  if (v.startsWith('20')) return '20'
  return v.slice(0, 2)
}

// Rend 'A' | 'B' | 'C', ou null si la zone n'est pas determinable.
function zoneDuBien (bien) {
  if (!bien) return null
  // Un pays autre que la France n'a pas de zone francaise.
  const pays = String(bien.country || 'FR').toUpperCase()
  if (pays && pays !== 'FR' && pays !== 'FRA') return null
  const dep = departementDuCodePostal(bien.zip_code)
  return dep ? (INDEX[dep] || null) : null
}

// ─── Conversion des instants de la source ───────────────────────────────────
// ⚠ LE PIEGE PRINCIPAL DE CE LOT, MESURE SUR LES DONNEES REELLES.
// data.education.gouv.fr sert des instants UTC dont le decalage VARIE avec
// l'heure d'ete :
//   Vacances de la Toussaint 2025 : 2025-10-17T22:00:00+00:00  (UTC+2)
//   Vacances de Noel 2025         : 2025-12-19T23:00:00+00:00  (UTC+1)
// Les deux valent MINUIT a Paris — le 18 octobre et le 20 decembre. Un
// `slice(0, 10)` naif rendrait le 17 et le 19 : toutes les dates decalees d'un
// jour, et pas toujours du meme cote selon la saison.
//
// On convertit donc explicitement vers Europe/Paris. `Intl` fait le travail
// sans dependance, et connait les regles de changement d'heure.
const FORMATEUR = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
})

function jourLocalParis (instantISO) {
  if (!instantISO) return null
  const d = new Date(instantISO)
  if (Number.isNaN(d.getTime())) return null
  // 'fr-CA' formate en YYYY-MM-DD, ce qui evite un reassemblage manuel.
  return FORMATEUR.format(d)
}

function veille (jourISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jourISO || ''))) return null
  const d = new Date(`${jourISO}T12:00:00Z`)   // midi : a l'abri de tout decalage
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ⚠ `end_date` EST LE JOUR DE LA RENTREE, PAS LE DERNIER JOUR DE VACANCES.
// Verifie sur les donnees reelles : Toussaint 2025 finit a 2025-11-02T23:00Z,
// soit le 3 novembre a Paris — or la rentree 2025 a bien eu lieu le 3. Le
// dernier jour de vacances est donc le 2. Stocker le 3 ferait compter un jour
// de vacances de trop a chaque periode, tous les ans.
//
// Exception : les evenements PONCTUELS (debut des vacances d'ete servi comme
// marqueur) ont `start === end`. Les reculer d'un jour rendrait une periode
// inversee, que la contrainte CHECK refuserait.
function periodeDepuisSource (ligne) {
  const debut = jourLocalParis(ligne?.start_date)
  const finBrute = jourLocalParis(ligne?.end_date)
  if (!debut || !finBrute) return null
  // ⚠ `start === end` est LEGITIME (marqueur ponctuel), `end < start` ne l'est
  // pas — releve en review. La premiere version rendait `{debut, debut}` dans
  // les deux cas : une donnee corrompue devenait une periode d'un jour
  // INVENTEE, que rien ne distinguait ensuite d'un vrai marqueur.
  if (finBrute < debut) return null
  const fin = finBrute > debut ? veille(finBrute) : debut
  if (!fin || fin < debut) return null
  return { date_debut: debut, date_fin: fin }
}

// La source sert une ligne par academie ET par population (« Eleves »,
// « Enseignants », « - »). Les enseignants rentrent un jour plus tot : garder
// leurs lignes ferait deux periodes concurrentes pour les memes vacances.
function estLignePertinente (ligne) {
  const pop = String(ligne?.population ?? '').trim()
  return pop === '' || pop === '-' || pop.toLowerCase().startsWith('élève') ||
         pop.toLowerCase().startsWith('eleve')
}

function zoneDepuisSource (ligne) {
  const m = /Zone\s+([ABC])/i.exec(String(ligne?.zones || ''))
  return m ? m[1].toUpperCase() : null
}

module.exports = {
  ACADEMIES,
  ZONE_PAR_DEPARTEMENT,
  departementDuCodePostal,
  zoneDuBien,
  jourLocalParis,
  veille,
  periodeDepuisSource,
  estLignePertinente,
  zoneDepuisSource
}
