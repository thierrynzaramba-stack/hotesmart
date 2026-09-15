// lib/cleaning/regles.js
// LA REGLE RECURRENTE, VALIDEE EN UN SEUL ENDROIT.
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// ⚠ POURQUOI CE MODULE EXISTE. Depuis le 15 septembre 2026, DEUX endpoints
// ecrivent les jours habituels d'une prestataire : `api/disponibilites.js`
// (l'hote, depuis la fiche) et `api/menages-public.js` (elle-meme, depuis sa
// PWA). Recopier la validation dans le second aurait produit deux regles pour
// la meme chose — et ce depot a deja paye trois fois le meme prix : la copie
// devient plus permissive que l'original, et personne ne s'en apercoit avant
// qu'une donnee impossible soit en base.
//
// Ce module ne touche PAS la base. Il rend ce qu'il faut ecrire, ou pourquoi on
// ne peut pas : les gardes de compte, de droit et de jeton restent chez les
// appelants, ou elles different reellement.

const { construireRrule, cleJour } = require('./availability')

// ⚠ AU SINGULIER, ET ON N'Y TOUCHE PAS. C'est la forme deja stockee en base
// (« Tous les lundi et mardi ») : la mettre au pluriel en deplacant ce code
// aurait fait diverger les libelles des regles NEUVES de ceux des anciennes,
// sans que personne l'ait demande. Un libelle est une donnee, pas un affichage.
const NOMS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

// ⚠ AU-DELA DE 4, CE N'EST PLUS UNE CADENCE DE MENAGE : c'est une saisie qui a
// derape, et la recurrence deviendrait illisible a l'ecran.
const CADENCE_MAX = 4

// Le libelle lu par les deux ecrans ET par la PWA. Il est STOCKE en base : le
// changer ici ne renomme pas les regles existantes, il ne vaut que pour les
// suivantes.
function libelle (jours, cadence) {
  const tries = [...jours].sort((a, b) => a - b)
  const noms = tries.map(j => NOMS[j])
  const liste = noms.length > 1
    ? `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`
    : noms[0]
  if (cadence === 1) return `Tous les ${liste}`
  if (cadence === 2) return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, une semaine sur deux`
  return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, toutes les ${cadence} semaines`
}

// Rend `{ erreur }` ou `{ rrule, label, jours, cadence }`.
//
// ⚠ AUCUNE CHAINE RRULE N'ENTRE ICI. Le client envoie des JOURS, une cadence et
// une ancre ; la chaine est CONSTRUITE par le serveur. C'est la regle du §2 de
// la spec, et elle vaut dans les deux sens : ce qui ne descend pas ne remonte
// pas non plus. Accepter une RRULE du client laisserait ecrire n'importe quelle
// recurrence — une `FREQ=MONTHLY` qu'aucun des deux ecrans ne sait relire, donc
// invisible et sans issue par l'interface.
// ⚠ `cleJour` VIENT D'ICI, il n'est plus injecte. La premiere version le
// prenait en parametre alors que ce module importe deja `./availability` : une
// couture ouverte pour rien, par laquelle un troisieme appelant aurait pu passer
// une autre normalisation et changer la semantique de l'ancrage sans qu'aucun
// test ne bouge.
function validerRegle ({ jours, toutes_les_n_semaines: cadenceBrute, depuis }) {
  if (!Array.isArray(jours) || !jours.length) {
    return { erreur: 'Choisissez au moins un jour' }
  }
  // ⚠ Les jours arrivent parfois en CHAINES (une `value` de case a cocher, un
  // JSON construit a la main). Les refuser d'emblee rendait le meme corps
  // acceptable depuis un ecran et refuse depuis l'autre.
  const lus = jours.map(v =>
    typeof v === 'number' ? v
      : (typeof v === 'string' && /^[0-6]$/.test(v.trim()) ? Number(v) : NaN))
  if (lus.some(j => !Number.isInteger(j) || j < 0 || j > 6)) {
    return { erreur: 'Jours invalides' }
  }
  const cadence = cadenceBrute === undefined ? 1 : Number(cadenceBrute)
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > CADENCE_MAX) {
    return { erreur: 'Cadence invalide' }
  }
  // ⚠ L'ANCRAGE DECIDE QUELLE SEMAINE EST « ON ». Une date illisible retombe sur
  // aujourd'hui plutot que d'echouer : c'est le comportement de
  // `construireRrule`, et les deux ecrans envoient toujours une date.
  const ancre = depuis && cleJour(depuis) ? cleJour(depuis) : null
  // ⚠ DEDUPLIQUE AVANT LE LIBELLE. `construireRrule` deduplique de son cote, si
  // bien qu'un corps `{jours:[1,1,2]}` produisait une RRULE correcte mais un
  // libelle « Tous les lundi, lundi et mardi » — affiche tel quel dans les
  // deux ecrans, et stocke pour toujours.
  const joursUniques = [...new Set(lus)].sort((a, b) => a - b)
  const rrule = construireRrule({ jours: joursUniques, toutesLesNSemaines: cadence, depuis: ancre })
  if (!rrule) return { erreur: 'Règle impossible' }

  return { rrule, label: libelle(joursUniques, cadence), jours: joursUniques, cadence }
}

module.exports = { validerRegle, libelle, CADENCE_MAX }
