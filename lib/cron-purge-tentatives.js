// lib/cron-purge-tentatives.js
// DOC : docs/kb/moteur-reservation.md §11.7 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §5.2 bis et §6.6
//
// PURGE DES TENTATIVES DE RESERVATION — decision Thierry, 7 septembre 2026.
//
//   jamais payee (`pending`, `failed`, `expired`) -> ANONYMISATION a 30 jours
//   payee (`paid`, `booked`, `refunded`)          -> conservation comptable
//
// ⚠ ANONYMISATION, PAS SUPPRESSION. La ligne survit — dates, montant, lien
// d'origine, statut — seuls les quatre champs personnels sont ecrases. On garde
// de quoi mesurer les abandons (combien, sur quel lien, a quel prix) sans garder
// de quoi identifier qui que ce soit. Supprimer la ligne perdrait la statistique
// EN MEME TEMPS que la donnee personnelle.
//
// ⚠ UNE TENTATIVE PAYEE N'EST JAMAIS TOUCHEE PAR CE CHEMIN. Elle porte une
// transaction, et sa duree de conservation releve du comptable, pas de nous.

const JOURS = 30

// Les statuts qui n'ont JAMAIS donne lieu a un encaissement. Liste FERMEE et
// explicite : un `.not('status', 'in', ...)` anonymiserait tout statut ajoute
// plus tard, y compris un statut payant.
const JAMAIS_PAYEE = ['pending', 'failed', 'expired']

const ANONYME = {
  guest_first_name: '—',
  guest_last_name: '—',
  guest_email: 'anonymise@invalide.local',
  guest_phone: '—'
}

// ⚠ CADENCE QUOTIDIENNE, par marqueur `cron_logs` — meme mecanique que le poll
// des avis. Le cycle tourne toutes les 5 minutes ; balayer la table 288 fois par
// jour pour anonymiser ce qui a 30 jours n'a aucun sens, et le filtre
// `status in (...)` n'est couvert par aucun index (celui de la table ne porte que
// `paid` et `refunded`). Une fois par jour suffit largement.
//
// Le marqueur est pose APRES le travail : si la purge echoue, le passage suivant
// la retente. C'est l'inverse du poll des avis, ou le marqueur est pose AVANT
// pour eviter qu'un travail long ne reparte a chaque tick — ici le travail est
// court et borne, et une purge sautee est une donnee personnelle gardee un jour
// de trop.
const MARQUEUR = 'purge-tentatives'

async function aDejaTourneAujourdhui (supabase, maintenant) {
  const { data } = await supabase.from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
  if (!data || !data.last_run) return false
  return (maintenant || Date.now()) - new Date(data.last_run).getTime() < 24 * 60 * 60 * 1000
}

async function purgerSiDue (supabase, options = {}) {
  if (await aDejaTourneAujourdhui(supabase, options.maintenant)) return { anonymisees: 0, saute: true }
  const bilan = await purgerTentatives(supabase, options)
  // ⚠ COLONNES COMPLETES ET `onConflict`, comme tous les autres marqueurs du
  // depot (cron-overbooking, cron-alerting, cron-channel-reviews…) : elles sont
  // passees « pour couvrir un eventuel NOT NULL ». Et l'erreur est TESTEE —
  // constat de review : un marqueur non ecrit en silence fait repartir le
  // balayage a chaque tick de 5 minutes, soit 288 fois par jour, sans trace.
  const { error } = await supabase.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(options.maintenant || Date.now()).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (error) console.error('[purge-tentatives] marqueur non ecrit :', error.message)
  return bilan
}

async function purgerTentatives (supabase, { jours = JOURS, maintenant } = {}) {
  const limite = new Date((maintenant || Date.now()) - jours * 24 * 60 * 60 * 1000).toISOString()

  // On lit d'abord pour savoir CE QU'ON TOUCHE : un update aveugle ne dirait pas
  // combien de lignes ont bouge, et cette purge doit etre verifiable.
  // ⚠ Le filtre exclut les lignes DEJA anonymisees, sinon chaque passage les
  // reecrirait et `updated_at` mentirait sur la date de la derniere anonymisation.
  const { data, error } = await supabase
    .from('booking_attempts')
    .select('id')
    .in('status', JAMAIS_PAYEE)
    .lt('created_at', limite)
    .neq('guest_email', ANONYME.guest_email)
    .limit(500)
  if (error) throw new Error(`lecture booking_attempts : ${error.message}`)

  const ids = (data || []).map(r => r.id)
  if (!ids.length) return { anonymisees: 0 }

  const { error: eMaj } = await supabase
    .from('booking_attempts')
    .update({ ...ANONYME, updated_at: new Date().toISOString() })
    .in('id', ids)
  if (eMaj) throw new Error(`anonymisation : ${eMaj.message}`)

  console.log(`[purge-tentatives] ${ids.length} tentative(s) anonymisee(s) (> ${jours} j, jamais payees)`)
  return { anonymisees: ids.length }
}

module.exports = { JOURS, JAMAIS_PAYEE, ANONYME, MARQUEUR, purgerTentatives, purgerSiDue }
