// tests/dispos-cablage.test.js
// TOUT CE QUI CHARGE DES DISPONIBILITÉS DOIT TRANSMETTRE LES TROIS FAMILLES.
//
// ⚠ POURQUOI CE FICHIER EXISTE, ET IL EXISTE PARCE QUE J'AI ÉCHOUÉ.
// Le lot « congés en plage » (15 septembre 2026) a ajouté un étage à
// `estDisponible` : un congé rend indisponible, au-dessus des exceptions et des
// règles. La fonction sait les lire — mais elle ne lit que ce qu'on lui DONNE.
// J'ai câblé quatre points de passage en écrivant dans le commit « les congés se
// chargent partout où les règles se chargent ». C'était faux : il y en avait
// SIX. La review a trouvé les deux manquants, tous deux classés CRITIQUES :
//
//   `api/menages.js` — rattrapage immédiat à la création d'une liaison : une
//   prestataire en congé tout septembre se voyait attribuer les ménages de
//   septembre en `accepted`. Le cron ne repassait pas dessus, puisqu'ils
//   n'étaient plus `unassigned`.
//
//   `api/menages-public.js` — remplaçante après un refus : la personne calculée
//   pouvait être en vacances le jour du départ, recevoir le SMS, et devenir
//   porteuse d'office.
//
// ⚠ AUCUN TEST D'UNITÉ NE POUVAIT LE VOIR. `estDisponible` était juste,
// `congeCouvrant` était juste, la précédence était juste — et tous leurs tests
// verts. Ce qui manquait n'était pas une règle, c'était un CÂBLE. Un défaut de
// câblage ne se teste pas en éprouvant les deux bouts : il se teste en vérifiant
// qu'ils sont reliés.
//
// Ce fichier lit donc le SOURCE. C'est un test de structure, pas de
// comportement, et c'est assumé : le comportement est déjà couvert ailleurs.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')

// Les fichiers qui construisent un contexte de disponibilité pour le moteur.
// ⚠ LISTE DÉRIVÉE, PAS RECOPIÉE : on la retrouve en cherchant les appelants de
// `chargerDisponibilites`. Une liste tenue à la main aurait le défaut même
// qu'elle prétend fermer — elle ne connaîtrait pas le septième appelant.
function appelants () {
  const dossiers = [path.join(racine, 'api'), path.join(racine, 'lib', 'cleaning')]
  const out = []
  for (const d of dossiers) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.js')) continue
      const chemin = path.join(d, f)
      const src = fs.readFileSync(chemin, 'utf8')
      // On ignore le fournisseur lui-même : c'est lui qui rend les trois familles.
      if (chemin.endsWith(path.join('lib', 'cleaning', 'assign.js'))) continue
      if (/chargerDisponibilites\s*\(/.test(src)) out.push({ chemin, src, nom: path.relative(racine, chemin) })
    }
  }
  return out
}

test('on trouve bien les appelants — sinon ce test ne teste rien', () => {
  // ⚠ CONTRE-ÉPREUVE DU TEST LUI-MÊME. Le jour où `chargerDisponibilites` est
  // renommée, la recherche rendrait zéro fichier et tous les tests ci-dessous
  // passeraient en ne vérifiant rien. Un vérificateur qui n'a rien lu doit
  // échouer, pas se taire.
  const liste = appelants()
  assert.ok(liste.length >= 4,
    `au moins quatre appelants attendus, ${liste.length} trouvé(s) — la recherche est cassée`)
})

test('CHAQUE appelant transmet `conges` en même temps que `regles`', () => {
  // La forme réelle dans le dépôt : un littéral
  //   { …, regles: dispos.regles, exceptions: dispos.exceptions, conges: dispos.conges }
  // On vérifie que partout où `regles:` est transmis depuis un `chargerDisponibilites`,
  // `conges:` l'est aussi. Le compte suffit : c'est un oubli qu'on cherche, pas
  // une faute de frappe.
  for (const { src, nom } of appelants()) {
    const regles = (src.match(/regles:\s*\w+\.regles/g) || []).length
    const conges = (src.match(/conges:\s*\w+\.conges/g) || []).length
    assert.strictEqual(conges, regles,
      `${nom} : ${regles} contexte(s) passent \`regles\` mais seulement ${conges} passent \`conges\` — ` +
      'une prestataire en congé y serait considérée disponible, et aucun test d\'unité ne le verrait')
  }
})

test('`estDisponible` lit bien les trois familles, et le congé en premier', () => {
  // Le pendant comportemental, en une ligne : si l'ordre changeait, tout le
  // câblage ci-dessus deviendrait sans objet.
  const src = fs.readFileSync(path.join(racine, 'lib', 'cleaning', 'availability.js'), 'utf8')
  const sig = /function estDisponible \(date, \{([^}]*)\}/.exec(src)
  assert.ok(sig, 'la signature de `estDisponible` est introuvable')
  for (const famille of ['regles', 'exceptions', 'conges']) {
    assert.match(sig[1], new RegExp(famille), `\`${famille}\` doit être reçu`)
  }
  const corps = src.slice(src.indexOf('function estDisponible'))
  const posConge = corps.indexOf('congeCouvrant')
  const posException = corps.indexOf('exceptions || []')
  assert.ok(posConge > -1 && posException > -1, 'les deux étages sont présents')
  assert.ok(posConge < posException,
    'le congé doit être évalué AVANT l\'exception — sinon une exception « disponible » ' +
    'posée par mégarde rend assignable un jour que le calendrier montre verrouillé')
})
