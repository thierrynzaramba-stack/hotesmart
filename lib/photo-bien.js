// lib/photo-bien.js — les regles PURES de la photo de couverture d'un bien
// (lot photos, 10 octobre 2026). Testees par tests/photo-bien.test.js.
// L'endpoint (api/property-photo.js) ne fait que garder, lire et ecrire.

const BUCKET = 'property-photos'
const TAILLE_MAX = 2 * 1024 * 1024 // 2 Mo, la limite posee sur le bucket

// Un JPEG commence par FF D8 FF. On verifie le CONTENU, jamais le nom ou le
// Content-Type annonces : un PNG renomme .jpg doit etre refuse.
function estJpeg (buf) {
  return Buffer.isBuffer(buf) && buf.length > 3
    && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
}

// Le chemin du fichier DANS NOTRE bucket, depuis une URL publique Supabase —
// ou null si l'URL pointe ailleurs. « Remplacer » n'efface que ce que nous
// avons ecrit : une URL etrangere (posee a la main en base) n'est pas touchee.
function cheminDansBucket (url, supabaseUrl) {
  if (!url || !supabaseUrl) return null
  const prefixe = `${String(supabaseUrl).replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/`
  if (!String(url).startsWith(prefixe)) return null
  const chemin = String(url).slice(prefixe.length)
  // Un seul segment attendu (nom aleatoire .jpg) : pas de traversee.
  return /^[A-Za-z0-9-]+\.jpg$/.test(chemin) ? chemin : null
}

// Nom de fichier ALEATOIRE (decision de Thierry) : jamais l'id du bien — une
// URL publique ne doit pas permettre d'enumerer les biens.
function nomAleatoire (uuid) {
  return `${uuid}.jpg`
}

module.exports = { BUCKET, TAILLE_MAX, estJpeg, cheminDansBucket, nomAleatoire }
