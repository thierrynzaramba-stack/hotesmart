// lib/yield/jours-feries.js
// DOC : docs/kb/evenements-yield.md (modif = MEME COMMIT)
//
// Jours feries francais. Fonction PURE : ni table, ni reseau, ni cache.
//
// ⚠ POURQUOI AUCUNE TABLE, CONTRAIREMENT AUX VACANCES SCOLAIRES.
// Les vacances scolaires sont une DECISION administrative : elles ne se
// calculent pas, il faut les lire quelque part. Les jours feries francais, eux,
// se DEDUISENT — huit dates fixes, et trois mobiles derivees de Paques par une
// formule qui n'a pas bouge depuis 1582. Les importer creerait une dependance
// reseau, une table a rafraichir et une fenetre d'annees limitee, pour une
// donnee qu'une vingtaine de lignes rendent exacte a l'infini.
//
// Portee : France metropolitaine. L'Alsace-Moselle (Vendredi saint, 26
// decembre) et les DOM (abolition de l'esclavage, dates variables) ont des
// jours supplementaires — non couverts, et c'est dit plutot que devine.

// ─── Paques ─────────────────────────────────────────────────────────────────
// Algorithme de Meeus/Jones/Butcher (gregorien). Rend { mois, jour }.
// ⚠ Les mois sont ici en base 1 (3 = mars) : `new Date()` les attend en base 0.
// Confondre les deux decale toutes les fetes mobiles d'un mois — c'est la
// raison de cette note.
function paques (annee) {
  const a = annee % 19
  const b = Math.floor(annee / 100)
  const c = annee % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mois = Math.floor((h + l - 7 * m + 114) / 31)
  const jour = ((h + l - 7 * m + 114) % 31) + 1
  return { mois, jour }
}

// ⚠ TOUT EN UTC, DU DEBUT A LA FIN.
// Un `new Date(a, m, j)` construit une date LOCALE : sur une machine en UTC-5,
// `toISOString()` rendrait la veille. Les dates de ce module sont des jours
// calendaires, pas des instants — on les manipule donc en UTC et on les
// formate sans jamais repasser par le fuseau de la machine.
function jourUTC (annee, mois1, jour) {
  return new Date(Date.UTC(annee, mois1 - 1, jour))
}
function iso (d) {
  return d.toISOString().slice(0, 10)
}
function decale (d, n) {
  const x = new Date(d.getTime())
  x.setUTCDate(x.getUTCDate() + n)
  return x
}

// Rend une Map 'YYYY-MM-DD' -> nom, pour une annee.
function joursFeriesDeLAnnee (annee) {
  const an = Number(annee)
  if (!Number.isInteger(an) || an < 1970 || an > 2200) return new Map()

  const p = paques(an)
  const dimanchePaques = jourUTC(an, p.mois, p.jour)

  const feries = new Map()
  const poser = (d, nom) => feries.set(iso(d), nom)

  // Fixes.
  poser(jourUTC(an, 1, 1), 'Jour de l\'An')
  poser(jourUTC(an, 5, 1), 'Fête du Travail')
  poser(jourUTC(an, 5, 8), 'Victoire 1945')
  poser(jourUTC(an, 7, 14), 'Fête nationale')
  poser(jourUTC(an, 8, 15), 'Assomption')
  poser(jourUTC(an, 11, 1), 'Toussaint')
  poser(jourUTC(an, 11, 11), 'Armistice 1918')
  poser(jourUTC(an, 12, 25), 'Noël')

  // Mobiles, derivees de Paques.
  poser(decale(dimanchePaques, 1), 'Lundi de Pâques')
  poser(decale(dimanchePaques, 39), 'Ascension')          // jeudi
  poser(decale(dimanchePaques, 50), 'Lundi de Pentecôte')

  return feries
}

// Les jours feries d'une periode, bornes INCLUSES — meme convention que le
// reste du chantier.
function joursFeriesEntre (debut, fin) {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!re.test(String(debut || '')) || !re.test(String(fin || '')) || fin < debut) return new Map()
  const out = new Map()
  const a1 = Number(debut.slice(0, 4))
  const a2 = Number(fin.slice(0, 4))
  // Garde-fou : une fenetre de plus de deux siecles vient d'une erreur d'appel.
  if (a2 - a1 > 200) return new Map()
  for (let a = a1; a <= a2; a++) {
    for (const [j, nom] of joursFeriesDeLAnnee(a)) {
      if (j >= debut && j <= fin) out.set(j, nom)
    }
  }
  return out
}

function estFerie (jourISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(jourISO || ''))) return false
  return joursFeriesDeLAnnee(Number(jourISO.slice(0, 4))).has(jourISO)
}

module.exports = { paques, joursFeriesDeLAnnee, joursFeriesEntre, estFerie }
