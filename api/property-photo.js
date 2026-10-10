// api/property-photo.js — la photo de couverture d'un bien (lot photos,
// 10 octobre 2026 ; KB docs/kb/aujourdhui.md §photos).
//
// POST { property_id: <uuid>, data: <base64 JPEG> }
//   -> { ok: true, photo_url }
//
// SEUL WRITER de properties.photo_url et du bucket « property-photos ».
// Le bucket est public en LECTURE seulement : aucune policy storage cote
// client, tout passe par la service key d'ici.
//
// Regles (shared : lib/photo-bien.js, teste) :
//  - garde `reglages` en ECRITURE sur le bien designe (bienRequis) ;
//  - contenu verifie (magic JPEG), 2 Mo max apres decodage ;
//  - nom de fichier ALEATOIRE, jamais l'id du bien ;
//  - « Remplacer » : l'ancien fichier n'est efface qu'APRES l'ecriture
//    reussie du nouveau (fichier + photo_url), et seulement s'il vit dans
//    notre bucket. Un echec d'effacement ne casse pas le remplacement.

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { BUCKET, TAILLE_MAX, estJpeg, cheminDansBucket, nomAleatoire } = require('../lib/photo-bien')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  const propertyId = String(req.body?.property_id || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'property_id requis' })

  // ⚠ `bienRequis` : la ressource designe le compte, l'en-tete X-Compte ne
  // peut rien detourner. Changer le visuel d'une annonce est un REGLAGE.
  const garde = await requirePermission(req, res, {
    domaine: 'reglages', niveau: 'write', bien: propertyId, bienRequis: true
  })
  if (!garde.ok) return

  const brut = String(req.body?.data || '')
  if (!brut) return res.status(400).json({ error: 'data (base64) requis' })
  let buf
  try { buf = Buffer.from(brut.replace(/^data:image\/jpeg;base64,/, ''), 'base64') }
  catch { return res.status(400).json({ error: 'base64 illisible' }) }
  if (!estJpeg(buf)) return res.status(400).json({ error: 'Seul le JPEG est accepté' })
  if (buf.length > TAILLE_MAX) return res.status(413).json({ error: 'Image trop lourde (2 Mo max)' })

  // L'URL actuelle, AVANT d'ecrire : c'est elle qu'on effacera apres succes.
  const { data: bien, error: eBien } = await supabase.from('properties')
    .select('id, photo_url').eq('id', garde.bien.id).maybeSingle()
  if (eBien || !bien) return res.status(500).json({ error: 'Lecture du bien impossible' })

  const chemin = nomAleatoire(crypto.randomUUID())
  const { error: eUp } = await supabase.storage.from(BUCKET)
    .upload(chemin, buf, { contentType: 'image/jpeg', upsert: false })
  if (eUp) {
    console.error('[property-photo] upload echec', eUp.message)
    return res.status(500).json({ error: 'Écriture du fichier impossible' })
  }
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(chemin)
  const photoUrl = pub?.publicUrl
  if (!photoUrl) return res.status(500).json({ error: 'URL publique introuvable' })

  const { error: eMaj } = await supabase.from('properties')
    .update({ photo_url: photoUrl }).eq('id', bien.id)
  if (eMaj) {
    // La colonne n'a pas bouge : on retire le fichier qu'on vient de poser
    // plutot que de laisser un orphelin, et l'ancien visuel reste en place.
    try { await supabase.storage.from(BUCKET).remove([chemin]) } catch { /* orphelin signale ci-dessous */ }
    console.error('[property-photo] update photo_url echec', eMaj.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }

  // L'ancien fichier, seulement maintenant, et seulement s'il est a nous.
  const ancien = cheminDansBucket(bien.photo_url, process.env.SUPABASE_URL)
  if (ancien && ancien !== chemin) {
    const { error: eDel } = await supabase.storage.from(BUCKET).remove([ancien])
    if (eDel) console.error('[property-photo] ancien fichier non efface', ancien, eDel.message)
  }

  return res.status(200).json({ ok: true, photo_url: photoUrl })
}
