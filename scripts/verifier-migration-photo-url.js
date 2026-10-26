#!/usr/bin/env node
// scripts/verifier-migration-photo-url.js — la migration
// migrations/2026-10-10-photo-url.sql est-elle appliquee ? Meme methode que
// verifier-migration-taxes-sejour.js : empreinte de la base en tete (5 biens =
// production, 3 = staging), colonne lue par son NOM — un `create ... if not
// exists` qui reussit en silence ne prouve rien (regle du depot).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-photo-url.js
//
// ⚠ LECTURE SEULE.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Base ${base} · biens = ${count}`)
  // ⚠ L'EMPREINTE EST LA REFERENCE DU PROJET, ET ELLE REFUSE (26 octobre 2026).
  // Ce script imprimait « biens = N (5 = production, 3 = staging) » puis
  // continuait sur n'importe quelle base designee par l'environnement. Deux
  // defauts dans une ligne : la legende est FAUSSE depuis que staging porte
  // quatre biens, et une legende n'est pas une garde — elle se lit apres coup,
  // dans une sortie que personne ne relit quand tout s'est bien passe.
  if (base === 'INCONNUE') {
    console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging.`)
    console.error(`Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.`)
    process.exit(1)
  }
  const { error: e } = await sb.from('properties').select('photo_url').limit(0)
  if (e) { console.error(`  ✖ properties.photo_url : ${e.message}`); console.error('ECHEC : migration absente.'); process.exit(2) }
  console.log('  ✔ properties.photo_url lisible par son nom')
  // Le bucket fait partie du lot (scripts/creer-bucket-photos.js) : absent ou
  // prive, l'endpoint rend 500 ou des URL publiques qui repondent 400 — c'est
  // un ECHEC, pas une remarque (releve en review).
  const { data: b } = await sb.storage.getBucket('property-photos').catch(() => ({ data: null }))
  if (!b) { console.error('  ✖ bucket property-photos ABSENT — lancer scripts/creer-bucket-photos.js'); process.exit(2) }
  if (b.public !== true) { console.error('  ✖ bucket property-photos PRIVE — lancer scripts/creer-bucket-photos.js'); process.exit(2) }
  const taille = b.file_size_limit ?? b.fileSizeLimit ?? null
  const types = b.allowed_mime_types ?? b.allowedMimeTypes ?? null
  if (Number(taille) !== 2 * 1024 * 1024 || !Array.isArray(types) || types.join() !== 'image/jpeg') {
    console.error(`  ✖ bucket property-photos MAL REGLE (taille=${taille}, types=${JSON.stringify(types)}) — lancer scripts/creer-bucket-photos.js`)
    process.exit(2)
  }
  console.log('  ✔ bucket property-photos present, public, jpeg, 2 Mo')
  console.log('Migration 2026-10-10-photo-url : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
