// shared/photo-bien-client.js
// LA PRÉPARATION D'UNE PHOTO DE BIEN, CÔTÉ NAVIGATEUR — une seule fois.
//
// ⚠ EXTRAIT DE `pages/biens.html` LE 21 OCTOBRE 2026 (étape 3 du lot Logements),
// parce que la fiche V5 en a besoin à son tour. La recopier aurait fait deux
// copies d'une même règle, et celle-ci porte des leçons de revue : une image
// sans dimensions, et l'échelle de qualité qui décide « trop lourde ». La règle
// du dépôt est explicite — « une règle partagée vit dans un module commun,
// jamais recopiée dans chaque page ».
//
// ⚠ AUCUN TEXTE ICI. Le module refuse avec un CODE ; chaque page le traduit
// avec son propre dictionnaire. Un message écrit ici devrait l'être trois fois
// (fr/en/es) dans un module qui n'a pas de dictionnaire, ou être en dur — ce
// que le socle V5 interdit.
//
// ⚠ ET LA BORNE EST CELLE DU SERVEUR. `api/property-photo.js` refuse au-delà de
// 2 Mo (413) : la même valeur ici évite d'envoyer ce qui sera refusé, mais elle
// ne REMPLACE pas la garde serveur — c'est elle qui protège le bucket.

export const TAILLE_MAX = 2 * 1024 * 1024
export const COTE_MAX = 2000
const QUALITES = [0.85, 0.7, 0.55]

export class PhotoRefusee extends Error {
  constructor (code) { super(code); this.code = code; this.name = 'PhotoRefusee' }
}

export async function preparerJpeg (fichier) {
  if (!fichier || !/^image\//.test(fichier.type || '')) throw new PhotoRefusee('type')
  const img = await new Promise((ok, ko) => {
    const u = URL.createObjectURL(fichier)
    const i = new Image()
    i.onload = () => { URL.revokeObjectURL(u); ok(i) }
    i.onerror = () => { URL.revokeObjectURL(u); ko(new PhotoRefusee('type')) }
    i.src = u
  })
  // ⚠ Une image sans dimensions (SVG sans width/height, fichier corrompu)
  // donnerait un canvas 0 × 0 et un faux « trop lourde » (relevé en revue).
  if (!img.naturalWidth || !img.naturalHeight) throw new PhotoRefusee('type')
  const ratio = Math.min(1, COTE_MAX / Math.max(img.naturalWidth, img.naturalHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * ratio)
  c.height = Math.round(img.naturalHeight * ratio)
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  let unBlob = null
  for (const qualite of QUALITES) {
    const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', qualite))
    if (blob) unBlob = blob
    if (blob && blob.size <= TAILLE_MAX) return blob
  }
  // ⚠ DEUX REFUS, PAS UN. Aucun blob du tout = image non rastérisable (« type ») ;
  // des blobs trop gros = « trop lourde ». Les confondre enverrait l'hôte
  // changer de fichier alors qu'il doit en réduire un, ou l'inverse.
  throw new PhotoRefusee(unBlob ? 'taille' : 'type')
}
