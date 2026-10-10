#!/usr/bin/env node
// scripts/creer-bucket-photos.js — cree ou CONFORME le bucket
// « property-photos » (lot photos, 10 octobre 2026) : lecture publique (les
// photos des biens sont deja publiques sur les OTA), ecriture refusee aux
// clients (aucune policy storage : seule la service key de
// api/property-photo.js ecrit), JPEG seulement, 2 Mo max.
//
//   node --env-file=<.env de la base visee> scripts/creer-bucket-photos.js
//
// Idempotent : un bucket existant mais mal regle (prive, autre limite) est
// REMIS en conformite — un bucket cree a la main prive rendait des URL
// publiques qui repondent 400 a tous les visiteurs (releve en review).
// Applique le 10 octobre 2026 sur staging et production.

const { createClient } = require('@supabase/supabase-js')

const REGLAGES = { public: true, fileSizeLimit: 2 * 1024 * 1024, allowedMimeTypes: ['image/jpeg'] }

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count } = await sb.from('properties').select('id', { count: 'exact', head: true })
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)
  const { data: existant } = await sb.storage.getBucket('property-photos')
  if (!existant) {
    const { error } = await sb.storage.createBucket('property-photos', REGLAGES)
    if (error) { console.error('ECHEC creation :', error.message); process.exit(1) }
    console.log('bucket property-photos CREE (public, jpeg, 2 Mo)')
    return
  }
  if (existant.public !== true) {
    const { error } = await sb.storage.updateBucket('property-photos', REGLAGES)
    if (error) { console.error('ECHEC mise en conformite :', error.message); process.exit(1) }
    console.log('bucket property-photos remis en conformite (il etait prive)')
    return
  }
  console.log(`bucket property-photos conforme (public=${existant.public})`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
