// lib/property-snapshot.js
// DOC : docs/kb/coeur-de-donnees.md (modif = MEME COMMIT)
// Migration : migrations/2026-09-08-property-snapshots.sql
//
// LE WRITER UNIQUE DE `property_snapshots` — etape 1B du chantier
// « migration Channex ».
//
// Il conserve la FICHE DE BIEN telle que le provider la sert, integrale.
// Meme forme que `bookings_snapshot.raw` : un payload brut, une empreinte pour
// savoir s'il a bouge sans le rapatrier, un seul ecrivain.
//
// ⚠ CE QU'IL NE FAIT PAS, ET C'EST VOLONTAIRE : il ne normalise rien, ne
// remplit aucune colonne de `properties`, ne decide de rien. Le rapatriement
// (1B) et la structuration (etape 2) sont deux gestes distincts — melanger les
// deux, c'est perdre le brut le jour ou la structure change d'avis.
//
// ⚠ CE PAYLOAD PORTE DES DONNEES DE COMPTE : emails, telephones, reglages de
// passerelle de paiement, identifiants de webhook. La table est en RLS fermee,
// et RIEN ICI NE LE JOURNALISE. On loge des comptes et des empreintes, jamais
// le contenu.

const { empreinte } = require('./bookings-snapshot')

// `fetched_at` bouge a chaque passage : c'est la preuve que le provider a
// repondu. `updated_at` ne bouge que si le CONTENU a change — meme semantique
// que `bookings_snapshot`, pour qu'un lecteur n'ait pas deux regles en tete.
async function savePropertySnapshot (supabase, { userId, provider, propertyId, raw } = {}) {
  const out = { ok: false, change: false, raison: null }

  if (!userId || !provider || !propertyId) { out.raison = 'cle_incomplete'; return out }
  // Un payload vide n'ecrase JAMAIS un brut connu. Vecu sur les annulations
  // Channex a payload vide (regression du commit 5f1777d) : le provider peut
  // rendre `{}` sans que rien ne soit casse chez lui.
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) {
    out.raison = 'payload_vide'
    return out
  }

  const hash = empreinte(raw)
  const maintenant = new Date().toISOString()

  const { data: existante, error: eLire } = await supabase
    .from('property_snapshots')
    .select('id, raw_hash')
    .eq('user_id', userId).eq('provider', provider).eq('property_id', String(propertyId))
    .maybeSingle()
  // ⚠ postgrest-js NE THROW PAS. Une garde qui ne lit pas `error` est du code
  // mort — la lecon a coute une fenetre de surreservation sur le moteur.
  if (eLire) { out.raison = `lecture : ${eLire.message}`; return out }

  if (existante && existante.raw_hash === hash) {
    // Contenu identique : on note seulement qu'on a bien interroge le provider.
    const { error } = await supabase
      .from('property_snapshots')
      .update({ fetched_at: maintenant })
      .eq('id', existante.id)
    if (error) { out.raison = `fetched_at : ${error.message}`; return out }
    out.ok = true
    return out
  }

  const { error } = await supabase
    .from('property_snapshots')
    .upsert({
      user_id: userId,
      provider,
      property_id: String(propertyId),
      raw,
      raw_hash: hash,
      fetched_at: maintenant,
      updated_at: maintenant
    }, { onConflict: 'user_id,provider,property_id' })
  if (error) { out.raison = `ecriture : ${error.message}`; return out }

  out.ok = true
  out.change = true
  return out
}

module.exports = { savePropertySnapshot }
