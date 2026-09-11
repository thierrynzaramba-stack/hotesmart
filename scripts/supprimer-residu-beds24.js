// scripts/supprimer-residu-beds24.js
// Supprime la FICHE HoteSmart d'un bien deja migre, dont l'historique est
// parti sous la cle du provider cible.
//
// ⚠ NE TOUCHE RIEN CHEZ LE PROVIDER. Le bien RESTE dans le compte Beds24 :
// c'est le filet de rollback tant qu'aucune reservation reelle n'a traverse la
// chaine Channex de bout en bout (decision de Thierry). Ce script ne parle
// qu'a Supabase.
//
// ⚠ LA CLE MIGREE N'EST PAS SUPPRIMEE, ET C'EST TOUT L'INTERET.
// `provider_keys_migrated` est ce qui empeche `materializeBeds24Properties` de
// recreer la fiche au cycle suivant. La supprimer « pour faire propre »
// rouvrirait exactement le defaut du 10 septembre 2026 : fiche recreee sous un
// nouvel uuid, `active_at` repose, bien refacture alors qu'il l'est deja sous
// sa fiche Channex.
//
// POURQUOI SUPPRIMER MALGRE TOUT. La fiche vide est inerte aujourd'hui, mais
// elle porte la cle `169567` : si la garde venait a tomber (table illisible —
// `clesMigrees` retombe volontairement OUVERT), le cron y rebrancherait un
// historique deja present sous la cle Channex, et toute agregation le
// compterait deux fois.
//
// USAGE : node scripts/supprimer-residu-beds24.js --bien=<uuid> [--go]
// Sans --go : simulation, aucune ecriture.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { estCleMigree } = require('../lib/cles-migrees')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BIEN = (process.argv.find(a => a.startsWith('--bien=')) || '').split('=')[1] || null
const GO = process.argv.includes('--go')

async function main () {
  if (!BIEN) throw new Error('--bien=<uuid> requis')

  const { data: fiche, error } = await supabase
    .from('properties').select('*').eq('id', BIEN).maybeSingle()
  if (error) throw new Error(`lecture fiche : ${error.message}`)
  if (!fiche) { console.log('Fiche absente — rien a faire.'); return }

  console.log(`Bien   : ${fiche.name} [${fiche.provider}/${fiche.provider_property_id}]`)
  console.log(`active_at : ${fiche.active_at || 'NULL'}   automation_paused : ${fiche.automation_paused}`)

  // ─── Garde 1 : la cle doit etre enregistree comme migree ──────────────────
  // Sans elle, supprimer la fiche est inutile ET dangereux : le cron la
  // recreerait au cycle suivant, avec un active_at neuf.
  const migree = await estCleMigree(
    supabase, fiche.user_id, fiche.provider_property_id, fiche.provider)
  if (!migree) {
    throw new Error(
      `REFUS : la cle ${fiche.provider_property_id} n'est PAS dans ` +
      `provider_keys_migrated pour ce compte. Supprimer la fiche maintenant la ` +
      `ferait recreer au prochain cycle (defaut du 10 septembre 2026). ` +
      `Enregistrer la cle d'abord (noterCleMigree).`)
  }
  console.log(`Cle migree enregistree : OUI`)

  // ─── Garde 2 : aucun enfant ne doit pointer sur cette fiche ───────────────
  // On verifie sur les DEUX formes de cle : l'uuid de la fiche et la cle
  // provider. Une table enfant oubliee ici deviendrait orpheline en silence.
  const parUuid = ['calendar_inventory', 'booking_links', 'booking_attempts',
    'ota_reviews', 'airbnb_connect_sessions', 'prestataire_periodes']
  const parCle = ['bookings_snapshot', 'menages', 'messages', 'conversations',
    'access_codes', 'property_status', 'property_locks', 'sms_logs',
    'property_channel_rate_plans', 'channel_sync_queue']
  const restes = []
  for (const [tables, valeur, colonnes] of [
    [parUuid, fiche.id, ['property_id', 'property_id_ref']],
    [parCle, String(fiche.provider_property_id), ['property_id']]
  ]) {
    for (const t of tables) {
      for (const c of colonnes) {
        const { count, error: e } = await supabase
          .from(t).select('*', { count: 'exact', head: true }).eq(c, valeur)
        // ⚠ ON NE CONFOND PAS « CETTE COLONNE N'EXISTE PAS » AVEC « LA LECTURE
        // A ECHOUE » — releve en review, sur un script DESTRUCTIF.
        // Un `continue` sur toute erreur lisait un timeout, un 503 PostgREST ou
        // un refus de permission comme « aucune reference » : le script aurait
        // affiche « Aucune ligne enfant rattachee : OK » puis supprime la fiche,
        // laissant les lignes orphelines. C'est le faux vert de la regle 13,
        // sur le chemin ou il coute le plus cher.
        if (e) {
          const code = String(e.code || '')
          const msg = String(e.message || '').toLowerCase()
          const colonneAbsente = code === '42703' || code === 'PGRST204' ||
            /does not exist|could not find/.test(msg)
          // Type incompatible (un uuid compare a '169567') : la colonne existe
          // mais ne peut PAS porter cette valeur — donc aucune reference.
          const typeIncompatible = code === '22P02' || /invalid input syntax/.test(msg)
          if (colonneAbsente || typeIncompatible) continue
          throw new Error(
            `REFUS : lecture de ${t}.${c} impossible (${e.code || 'sans code'} : ` +
            `${e.message}). On ne supprime pas une fiche sans avoir pu verifier ` +
            `qu'aucune ligne n'y pointe.`)
        }
        // `head: true` peut rendre un compte non numerique sur une table
        // absente sans lever d'erreur (mesure sur price_display_log).
        if (typeof count !== 'number') continue
        if (count > 0) restes.push(`${t}.${c} = ${count}`)
      }
    }
  }
  if (restes.length) {
    throw new Error(`REFUS : des lignes pointent encore sur ce bien —\n  ` +
      restes.join('\n  ') + `\nLes deplacer avant de supprimer la fiche.`)
  }
  console.log('Aucune ligne enfant rattachee : OK')

  if (!GO) {
    console.log('\nSIMULATION — aucune ecriture. Relancer avec --go pour supprimer.')
    return
  }

  // ─── Sauvegarde AVANT suppression, comme au transfert ─────────────────────
  // `rekeying_backup.bien_id` n'a PAS de contrainte de cle etrangere vers
  // `properties` (migrations/2026-09-10-rekeying.sql) : la sauvegarde survit
  // donc a la suppression de ce qu'elle sauvegarde. C'est voulu.
  const { error: bkErr } = await supabase.from('rekeying_backup').insert({
    bien_id:   fiche.id,
    source:    String(fiche.provider_property_id),
    cible:     '(suppression du residu, aucune cible)',
    nom_table: 'properties (residu supprime)',
    lignes:    [fiche]
  })
  if (bkErr) throw new Error(`sauvegarde impossible, on NE supprime pas : ${bkErr.message}`)
  console.log('Sauvegarde ecrite dans rekeying_backup')

  const { error: delErr } = await supabase.from('properties').delete().eq('id', fiche.id)
  if (delErr) throw new Error(`suppression : ${delErr.message}`)

  const { data: apres } = await supabase
    .from('properties').select('id').eq('id', fiche.id).maybeSingle()
  console.log(apres ? 'ECHEC : la fiche est toujours la' : 'Fiche supprimee')

  const { count: actifs } = await supabase
    .from('properties').select('id', { count: 'exact', head: true })
    .eq('user_id', fiche.user_id).not('active_at', 'is', null)
  console.log(`Biens factures (active_at non null) : ${actifs}`)
  console.log('\nRAPPEL : le bien reste dans le compte Beds24 — filet de rollback.')
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1) })
