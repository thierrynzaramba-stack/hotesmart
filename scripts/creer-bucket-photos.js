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
const { nomDeLaBase } = require('../lib/empreinte-base')

const REGLAGES = { public: true, fileSizeLimit: 2 * 1024 * 1024, allowedMimeTypes: ['image/jpeg'] }

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  const { count } = await sb.from('properties').select('id', { count: 'exact', head: true })
  console.log(`Base ${base} · biens = ${count}`)
  // ⚠ CE SCRIPT N'AVAIT AUCUNE GARDE DE BASE — il imprimait la legende
  // « 5 = production, 3 = staging » et continuait sur n'importe quelle base
  // designee par l'environnement (constat de la review du 26 octobre 2026).
  // Une legende n'est pas une garde : elle se lit apres coup, dans une sortie
  // que personne ne relit quand tout s'est bien passe.
  if (base === 'INCONNUE') {
    console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging. Rien n'est touche.`)
    process.exit(1)
  }
  const { data: existant } = await sb.storage.getBucket('property-photos')
  if (!existant) {
    const { error } = await sb.storage.createBucket('property-photos', REGLAGES)
    if (error) { console.error('ECHEC creation :', error.message); process.exit(1) }
    console.log('bucket property-photos CREE (public, jpeg, 2 Mo)')
    return
  }
  const taille = existant.file_size_limit ?? existant.fileSizeLimit ?? null
  const types = existant.allowed_mime_types ?? existant.allowedMimeTypes ?? null
  const conforme = existant.public === true
    && Number(taille) === REGLAGES.fileSizeLimit
    && Array.isArray(types) && types.length === 1 && types[0] === 'image/jpeg'
  if (!conforme) {
    // Public, taille ET types : un bucket cree a la main public mais sans la
    // limite 2 Mo laissait toute la garde au seul endpoint (releve en review).
    const { error } = await sb.storage.updateBucket('property-photos', REGLAGES)
    if (error) { console.error('ECHEC mise en conformite :', error.message); process.exit(1) }
    console.log(`bucket property-photos remis en conformite (public=${existant.public}, taille=${taille}, types=${JSON.stringify(types)})`)
    return
  }
  console.log('bucket property-photos conforme (public, jpeg, 2 Mo)')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
