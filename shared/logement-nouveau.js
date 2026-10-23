// shared/logement-nouveau.js
//
// La saisie d'un logement neuf : lecture du formulaire et refus de saisie.
//
// ⚠ POURQUOI UN MODULE, ET PAS DU CODE DANS LA PAGE. Les bornes doivent dire la
// MEME chose ici et au serveur (`api/channel-property.js`, bloc POST). Deux
// copies divergent — c'est la regle du depot, et le lot Logements en a deja paye
// une : la grille de la fiche et le moteur avaient deux assemblees differentes.
// Un module se teste seul, et un test confronte ses bornes a celles du serveur.
//
// ⚠ ET LE REFUS CLIENT NE REMPLACE PAS LE SERVEUR. Il evite a l'hote un
// aller-retour pour une faute de saisie ; la decision reste au serveur, qui
// refuse en 400 avec un message ecrit pour l'hote, et en 403 un membre non
// titulaire.

// Les dix champs de l'ecran, dans l'ordre ou l'hote les rencontre. `id` est
// l'identifiant DANS LE FORMULAIRE (donc ce qui porte le focus et le message),
// `api` le nom attendu par l'endpoint. Les deux diffèrent : l'ecran est en
// francais, l'API en anglais, et melanger les deux a deja coute un champ muet.
const CHAMPS = [
  { id: 'nom', api: 'name', type: 'texte', requis: true, max: 100 },
  { id: 'capacite', api: 'capacity', type: 'entier', requis: true, min: 1, max: 20 },
  { id: 'devise', api: 'currency', type: 'texte' },
  { id: 'prix_base', api: 'base_price', type: 'nombre', requis: true, min: 1, max: 100000 },
  { id: 'voyageurs_inclus', api: 'included_guests', type: 'entier', min: 1, max: 20 },
  { id: 'supplement', api: 'extra_guest_fee', type: 'nombre', min: 0, max: 100000 },
  { id: 'adresse', api: 'address', type: 'texte', max: 200 },
  { id: 'code_postal', api: 'zip_code', type: 'texte', max: 20 },
  { id: 'ville', api: 'city', type: 'texte', max: 100 },
  { id: 'pays', api: 'country', type: 'texte' }
]

// Les champs dont l'absence est acceptee : l'endpoint leur donne un defaut
// (`included_guests` -> capacite, `extra_guest_fee` -> null) ou les stocke tels
// quels. On envoie `null` et non la chaine vide : `''` passerait les gardes
// `!= null` du serveur et finirait en base.
function valeurDuChamp (form, champ) {
  const el = form.querySelector('#' + champ.id)
  if (!el) return null
  const brut = String(el.value == null ? '' : el.value).trim()
  if (brut === '') return null
  // ⚠ ON NE CONVERTIT QUE CE QUI EST VRAIMENT DU TYPE ATTENDU, et on rend la
  // saisie TELLE QUELLE sinon. `parseInt('2.5')` rend 2 : l'hote tapait 2,5
  // voyageurs et obtenait 2, sans un mot — l'ancien ecran, lui, refusait
  // (validation native du navigateur). Rendre la chaine laisse `refusDeSaisie`
  // la voir et la refuser, au lieu de la tronquer en silence.
  if (champ.type === 'entier') return /^-?\d+$/.test(brut) ? parseInt(brut, 10) : brut
  if (champ.type === 'nombre') return /^-?\d+(\.\d+)?$/.test(brut) ? parseFloat(brut) : brut
  return brut
}

function valeursDuFormulaire (form) {
  const out = {}
  for (const champ of CHAMPS) out[champ.api] = valeurDuChamp(form, champ)
  return out
}

// Le premier refus seulement : on ne montre pas dix messages a la fois, et le
// focus va sur le champ nomme. Rend `null` quand la saisie est acceptable.
//
// ⚠ LES BORNES SONT LUES DANS `CHAMPS`, PAS RECOPIEES. Avant, `CHAMPS.min` et
// `CHAMPS.max` n'etaient lus par personne : changer `min` de 1 a 99 ne changeait
// RIEN, et un test qui relisait ces litteraux se croyait une confrontation.
// Mesure de la review (22 octobre 2026) : la mutation passait, 19 tests verts.
// Une seule source, donc, et le HTML est confronte a elle par un test.
//
// ⚠ ET LE PRIX DE BASE EST REFUSE SOUS 1. L'ecran declare `min="1"` mais porte
// `novalidate` — le navigateur n'applique plus rien. Mesure : un logement a
// 0,50 EUR la nuit se creait, et le plan tarifaire partait chez le partenaire
// a 50 centimes. Le prix de base est le PLANCHER du plan provisionne
// (docs/kb/prix-plancher.md) : c'est la derniere valeur a laisser filer.
function refusDeSaisie (valeurs) {
  const v = valeurs || {}

  for (const champ of CHAMPS) {
    const brut = v[champ.api]
    if (brut == null || brut === '') {
      if (champ.requis) return { champ: champ.id, cle: 'nouveau.faute_' + champ.id }
      continue
    }
    if (champ.type === 'texte') {
      if (champ.max && String(brut).length > champ.max) {
        return { champ: champ.id, cle: champ.requis ? 'nouveau.faute_' + champ.id : 'nouveau.faute_trop_long' }
      }
      continue
    }
    const cle = 'nouveau.faute_' + champ.id
    // ⚠ UNE SAISIE RESTEE TEXTE SUR UN CHAMP NUMERIQUE EST REFUSEE, et c'est
    // `1e1` qui l'impose. Un champ `type="number"` CONSERVE « 1e1 » dans sa
    // valeur — c'est un nombre flottant valide, et c'est l'accident classique
    // de la touche « e ». `Number('1e1')` vaut 10, entier, dans les bornes :
    // l'ecran acceptait. Le serveur, lui, lit `parseInt('1e1', 10)` = 1.
    // L'hote voyait son 10 valide sans message, et le bien partait chez le
    // partenaire — propriete, type de chambre, plan tarifaire — avec une
    // capacite de 1. Releve a la re-review du 22 octobre 2026.
    //
    // `valeurDuChamp` ne convertit que ce qui est vraiment du type attendu : ce
    // qui reste une chaine ici n'a donc pas passe ce filtre, et personne ne
    // doit le reinterpreter — surtout pas avec une autre fonction que le
    // serveur.
    if (typeof brut === 'string') return { champ: champ.id, cle }
    const n = Number(brut)
    if (!Number.isFinite(n)) return { champ: champ.id, cle }
    if (champ.type === 'entier' && !Number.isInteger(n)) return { champ: champ.id, cle }
    if (champ.min != null && n < champ.min) return { champ: champ.id, cle }
    if (champ.max != null && n > champ.max) return { champ: champ.id, cle }
  }

  // ⚠ LA SEULE REGLE CROISEE, ET ELLE EXISTAIT AU SERVEUR SANS EXISTER A
  // L'ECRAN : « Voyageurs inclus invalide (1 a capacite) ». L'ancien formulaire
  // bornait ce champ a 20 ; un hote qui saisissait 10 inclus pour 2 voyageurs
  // remplissait ses dix champs et recevait un 400 sans savoir lequel etait en
  // cause.
  if (v.included_guests != null && v.included_guests !== '' &&
      Number(v.included_guests) > Number(v.capacity)) {
    return { champ: 'voyageurs_inclus', cle: 'nouveau.faute_voyageurs_inclus' }
  }
  return null
}

export { CHAMPS, valeursDuFormulaire, refusDeSaisie, valeurDuChamp }
