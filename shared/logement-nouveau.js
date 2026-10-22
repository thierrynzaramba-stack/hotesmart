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
  if (champ.type === 'entier') {
    const n = parseInt(brut, 10)
    return Number.isNaN(n) ? brut : n
  }
  if (champ.type === 'nombre') {
    const n = parseFloat(brut)
    return Number.isNaN(n) ? brut : n
  }
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
// ⚠ `voyageurs_inclus <= capacite` EST UNE REGLE DU SERVEUR QUE L'ECRAN
// IGNORAIT. L'ancien formulaire bornait ce champ a 20 ; l'endpoint, lui, refuse
// « Voyageurs inclus invalide (1 a capacite) ». Un hote qui saisissait 10
// inclus pour 2 voyageurs remplissait ses dix champs et recevait un 400 sans
// savoir lequel etait en cause.
function refusDeSaisie (valeurs) {
  const v = valeurs || {}

  if (!v.name || String(v.name).length < 1 || String(v.name).length > 100) {
    return { champ: 'nom', cle: 'nouveau.faute_nom' }
  }
  const cap = Number(v.capacity)
  if (!Number.isInteger(cap) || cap < 1 || cap > 20) {
    return { champ: 'capacite', cle: 'nouveau.faute_capacite' }
  }
  const prix = Number(v.base_price)
  if (!Number.isFinite(prix) || prix <= 0 || prix > 100000) {
    return { champ: 'prix_base', cle: 'nouveau.faute_prix_base' }
  }
  if (v.included_guests != null) {
    const inc = Number(v.included_guests)
    if (!Number.isInteger(inc) || inc < 1 || inc > cap) {
      return { champ: 'voyageurs_inclus', cle: 'nouveau.faute_voyageurs_inclus' }
    }
  }
  if (v.extra_guest_fee != null) {
    const sup = Number(v.extra_guest_fee)
    if (!Number.isFinite(sup) || sup < 0 || sup > 100000) {
      return { champ: 'supplement', cle: 'nouveau.faute_supplement' }
    }
  }
  return null
}

export { CHAMPS, valeursDuFormulaire, refusDeSaisie, valeurDuChamp }
