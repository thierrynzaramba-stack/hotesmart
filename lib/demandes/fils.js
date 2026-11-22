// lib/demandes/fils.js
// WRITER UNIQUE de `fils_provider` (dette 129, lot 1). Couche sync seulement :
// l'import des messages l'appelle pour chaque fil qu'il lit en entier.
// Spec : docs/specs/spec-demandes-airbnb.md §2-3.
//
// Un fil porte ce que ses messages ne portent pas : le NOM d'une demande
// (`titre`), la reservation que le provider lui a rattachee, l'etat ferme.
// Une ligne par (provider, fil) ; une ecriture la met a jour.
//
// ⚠ FAIL-SAFE ABSOLU, COMME `recordMessage` : ne leve jamais, n'emporte jamais
// l'import. Un fil non enregistre coute un nom manquant a l'ecran ; un import
// interrompu coute des messages.
//
// ⚠ UNE RESERVATION RATTACHEE NE SE DETACHE PAS. Le provider a pu rendre le fil
// sans `booking` une fois (lecture partielle, forme changeante) : ecraser une
// reservation connue par `null` ferait redevenir « demande » une conversation de
// sejour. On ecrit la reservation quand elle est connue, on ne l'efface jamais.

const { createClient } = require('@supabase/supabase-js')

let clientDuModule = null
function client () {
  if (!clientDuModule) clientDuModule = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  return clientDuModule
}

// Meme famille que `colonneCanalAbsente` de lib/record-message.js : la table
// arrive par une migration collee a la main ; entre le deploiement et ce geste,
// on le DIT au lieu d'echouer en boucle sans trace lisible.
function tableAbsente (error) {
  const t = `${error && error.code || ''} ${error && error.message || ''}`.toLowerCase()
  return t.includes('42p01') || t.includes('pgrst205') ||
    (t.includes('fils_provider') && (t.includes('does not exist') || t.includes('schema cache')))
}

/**
 * @param {object} p
 * @param {string} p.userId      compte proprietaire du bien
 * @param {string} p.provider    'channex'
 * @param {string} p.propertyId  cle provider du bien (texte)
 * @param {object} p.fil         { id, titre, booking, ota, ferme, derniere }
 * @param {object} [p.supabase]  client injecte (tests, outils)
 * @returns {{ ok: boolean, error?: string }}
 */
async function enregistrerFil (p) {
  const db = (p && p.supabase) || client()
  try {
    const { userId, provider, propertyId, fil } = p || {}
    if (!userId || !provider || !propertyId || !fil || !fil.id) {
      return { ok: false, error: 'missing_params' }
    }
    const ligne = {
      user_id: userId,
      provider,
      property_id: String(propertyId),
      provider_thread_id: String(fil.id),
      titre: fil.titre == null ? null : String(fil.titre).slice(0, 200),
      ota: fil.ota || null,
      ferme: fil.ferme === true,
      derniere: fil.derniere || null,
      maj_le: new Date().toISOString(),
    }
    if (fil.booking) ligne.booking_id = String(fil.booking)
    const { error } = await db.from('fils_provider')
      .upsert(ligne, { onConflict: 'provider,provider_thread_id' })
    if (error) {
      if (tableAbsente(error)) {
        console.error('[fils] table fils_provider absente — migration 2026-11-23-demandes-fils a appliquer')
      } else {
        console.error('[fils] ecriture echouee', error.message)
      }
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e) {
    console.error('[fils] exception', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { enregistrerFil }
