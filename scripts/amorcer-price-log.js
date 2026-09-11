// scripts/amorcer-price-log.js
// One-shot : ouvre une ligne courante par (bien, nuit tarifee ET ouverte)
// depuis `calendar_inventory`, pour que le journal des prix ne parte pas vide.
// Spec : docs/specs/spec-yieldflow-v1.md §4 — docs/kb/price-log.md
//
// ⚠ AUCUNE POUSSEE PROVIDER. Ce script ne parle qu'a Supabase. Il n'appelle ni
// Channex ni Beds24, ne modifie aucun prix affiche, ne touche pas
// `calendar_inventory`. Il ne fait que RECOPIER dans le journal ce qui est deja
// affiche.
//
// ⚠ CE QU'IL ECRIT N'EST PAS UNE MESURE, ET C'EST DIT DANS LA DONNEE.
// `created_at` portera la date du SEED, pas la date reelle du premier
// affichage : ces prix sont affiches depuis des semaines. Une ligne amorcee
// repond donc a « quel prix est affiche aujourd'hui », jamais a « depuis
// combien de temps ». Le marqueur `source = 'seed'` le rend explicite : toute
// analyse d'anciennete (« tenue a 120 pendant trois mois ») DOIT les exclure.
//
// Sans amorcage, `cloturerVente` fermerait dans le vide sur toutes les nuits
// deja tarifees : aucune vente ne serait mesuree avant le prochain changement
// de prix de chaque nuit.
//
// IDEMPOTENT : le writer n'ouvre que les nuits sans ligne courante. Relancer ne
// duplique rien.
//
// USAGE : node scripts/amorcer-price-log.js [--bien=<uuid>] [--jours=500] [--go]
// Sans --go : dry-run, aucune ecriture.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { enregistrerPrixPousses } = require('../lib/price-log')
const { canPushRates, estRelieAuCanal } = require('../lib/rate-sync')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const GO = process.argv.includes('--go')
const BIEN = (process.argv.find(a => a.startsWith('--bien=')) || '').split('=')[1] || null
const JOURS = Number((process.argv.find(a => a.startsWith('--jours=')) || '').split('=')[1] || 500)

// ⚠ MINUIT LOCAL, JAMAIS toISOString(). La fenetre poussee par runFullSync est
// calculee a minuit local : en Europe/Paris entre 00 h et 02 h, une fenetre UTC
// est decalee d'un jour et la derniere date n'est ni lue ni comptee.
function toLocalISO (d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const j = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

async function main () {
  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const fin = new Date(debut); fin.setDate(fin.getDate() + JOURS)
  const dDebut = toLocalISO(debut)
  const dFin = toLocalISO(fin)

  let q = supabase.from('properties')
    .select('id, user_id, name, provider, provider_property_id, base_price, rate_sync_mode')
  if (BIEN) q = q.eq('id', BIEN)
  const { data: biens, error } = await q
  if (error) throw new Error(`lecture properties : ${error.message}`)
  if (!biens?.length) { console.log('Aucun bien.'); return }

  console.log(`Amorcage du journal des prix — fenetre ${dDebut} → ${dFin}`)
  console.log(GO ? 'MODE ECRITURE (--go)\n' : 'DRY-RUN — aucune ecriture\n')

  let totalCandidates = 0
  let totalEcrites = 0

  for (const bien of biens) {
    // ⚠ ON N'AMORCE QUE CE QUI EST REELLEMENT AFFICHE.
    // Un bien en mode `keep` ne pousse pas ses tarifs : le prix du coeur n'est
    // pas celui que voit le voyageur. L'amorcer inventerait un prix affiche.
    if (!canPushRates(bien)) {
      console.log(`- ${bien.name} : ignore (mode « ${bien.rate_sync_mode || 'non defini'} », les tarifs ne partent pas)`)
      continue
    }
    // ⚠ ET LE BIEN DOIT ETRE CHEZ LE CANAL — releve en review.
    // `rate_sync_mode` dit « l'hote veut que nous poussions » ; `estRelieAuCanal`
    // dit « il y a un canal vers lequel pousser ». Un bien Beds24 en `managed`
    // passait la premiere garde alors que ni `api/calendar.js` ni `runFullSync`
    // ne lui envoient quoi que ce soit : le journal aurait demarre en affirmant
    // des prix que nous n'avons jamais affiches.
    if (!estRelieAuCanal(bien)) {
      console.log(`- ${bien.name} : ignore (provider « ${bien.provider} » : nous ne poussons pas ses tarifs)`)
      continue
    }
    // ⚠ `calendar_inventory` EST CLEE SUR L'UUID, pas sur la cle provider.
    // Exception a la regle 10, comme `price_display_log` : la table est ecrite
    // par nous (`api/calendar.js` y pose `property_id: bienId`), pas par la
    // couche sync. La premiere version de ce script interrogeait avec
    // `provider_property_id` et rendait « 500 nuits sans prix » sur les deux
    // biens qui vendent — sans la moindre erreur.
    const { data: inv, error: eInv } = await supabase
      .from('calendar_inventory')
      .select('date, rate, stop_sell, avail')
      .eq('property_id', bien.id)
      .gte('date', dDebut).lte('date', dFin)
    if (eInv) throw new Error(`calendrier de ${bien.name} : ${eInv.message}`)

    const parDate = new Map((inv || []).map(l => [l.date, l]))
    const nuits = {}
    let fermees = 0
    let sansPrix = 0

    for (let i = 0; i < JOURS; i++) {
      const d = new Date(debut); d.setDate(d.getDate() + i)
      const iso = toLocalISO(d)
      const l = parDate.get(iso)

      // ⚠ UNE NUIT SANS LIGNE DE CALENDRIER EST FERMEE — releve en review.
      // `runFullSync` calcule `availability = r ? Math.min(annonce, stock) : 0`
      // : l'absence de ligne vaut `availability: 0`. Les gardes precedentes
      // etaient prefixees `l &&`, donc une nuit sans ligne retombait sur
      // `base_price` et etait amorcee — le journal aurait demarre en affirmant
      // que des nuits invendables etaient affichees, jusqu'a 500 par bien.
      if (!l) { fermees++; continue }

      // Une nuit fermee n'est pas une nuit affichee (KB §4).
      if (l.stop_sell === true || l.avail === 0) { fermees++; continue }

      // ⚠ MEME REGLE QUE runFullSync, MOT POUR MOT.
      // Un `rate` nul ou <= 0 n'est pas un prix : c'est l'absence d'exception,
      // et on retombe sur le prix de base. Sans prix du tout, runFullSync
      // FERME la date : rien n'est affiche, donc rien a journaliser.
      const prixEur = (l.rate != null && Number(l.rate) > 0)
        ? Number(l.rate)
        : (Number(bien.base_price) > 0 ? Number(bien.base_price) : null)
      if (prixEur === null) { sansPrix++; continue }

      nuits[iso] = Math.round(prixEur * 100)
    }

    const n = Object.keys(nuits).length
    totalCandidates += n
    const dates = Object.keys(nuits).sort()
    console.log(`- ${bien.name} : ${n} nuit(s) a amorcer`
      + ` (${fermees} fermee(s), ${sansPrix} sans prix)`
      + (n ? `  ${dates[0]} → ${dates[dates.length - 1]}` : ''))
    if (n) {
      const echantillon = dates.slice(0, 3).map(d => `${d}=${(nuits[d] / 100).toFixed(2)}€`)
      console.log(`    echantillon : ${echantillon.join(', ')}`)
    }

    if (GO && n) {
      const bilan = await enregistrerPrixPousses(supabase, {
        userId: bien.user_id, propertyId: bien.id, nuits, source: 'seed'
      })
      totalEcrites += bilan.ouvertes
      console.log(`    ecrit : ${JSON.stringify(bilan)}`)
    }
  }

  console.log(`\n${totalCandidates} nuit(s) candidate(s)`)
  if (GO) {
    console.log(`${totalEcrites} ligne(s) ouverte(s) — les autres avaient deja une ligne courante.`)
    console.log(`Marquees source='seed' : leur created_at est la date du seed,`)
    console.log(`pas celle du premier affichage. A exclure de toute analyse d anciennete.`)
  } else {
    console.log('DRY-RUN — relancer avec --go pour ecrire.')
  }
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1) })
