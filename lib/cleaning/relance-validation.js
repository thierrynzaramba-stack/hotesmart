// lib/cleaning/relance-validation.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// LES DEUX RELANCES D'UN MENAGE NON VALIDE (decision de Thierry, 14 octobre
// 2026) : la veille et le jour meme, a 9 h de Paris, tant qu'elle n'a pas
// touche « Vu » sur sa page.
//
// ⚠ POURQUOI CE MODULE EXISTE. Un menage ATTRIBUE D'OFFICE nait `accepted` :
// elle n'a rien a confirmer, personne ne lui demande rien, et rien ne garantit
// qu'elle l'a lu. L'hote, lui, le croit confie. La proposition, elle, a deja
// sa boucle (echeance, escalade, notification) ; l'attribution d'office
// n'avait RIEN entre l'assignation et le depart du voyageur.
//
// ⚠ CE QUE CE MODULE NE FAIT PAS. Il ne reassigne rien, n'escalade rien, ne
// retire rien a personne. Une relance est un rappel : seul l'hote decide de
// changer de prestataire, et il a pour cela l'alerte « Non valide » de sa
// bulle, avec le numero a appeler.
//
// ⚠ LA FENETRE EST LA GARDE D'ENVOI DE MASSE (REVIEW.md regle 2). On ne
// regarde que DEUX jours — aujourd'hui et demain — et chaque relance laisse sa
// marque SUR LE MENAGE. La premiere activation d'un compte ne peut donc pas
// produire un SMS par reservation de l'historique : au pire deux par menage
// qui part dans les 48 h, et jamais deux fois le meme.

const { createClient } = require('@supabase/supabase-js')
const { notifierValidationAttendue } = require('./notifier-prestataire')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ 9 H DE PARIS, PAS 9 H UTC. En heure d'ete, 9 h UTC est 11 h chez l'hote :
// la relance « du matin » arriverait apres le depart du voyageur sur un
// checkout a 10 h.
const HEURE_DE_RELANCE = 9

// Le plafond par cycle. Le cron tourne toutes les 5 minutes : ce qui depasse
// part au cycle suivant, et rien ne se perd — les marqueurs sont en base.
const MAX_PAR_CYCLE = 60

const jourParis = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)

const heureParis = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hour12: false
  }).format(d))

function jourPlus (iso, n) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ⚠ `maintenant` EST INJECTE : regle du depot — un test qui injecte le temps
// prend des dates figees, un test qui lit l'horloge prend des dates relatives.
async function relancerValidations (results = {}, { maintenant = new Date() } = {}) {
  const bilan = { examines: 0, relances: 0, muettes: 0, erreurs: 0, differe: false }

  // ⚠ AVANT 9 H, ON NE FAIT RIEN — ET ON NE MARQUE RIEN. Le cron repasse
  // toutes les 5 minutes ; c'est la seule chose a faire ici.
  // ⚠ ET « A PARTIR DE 9 H », PAS « A 9 H PILE ». Un cycle qui echoue a 9 h 00
  // doit rattraper a 9 h 05, et un menage attribue a 15 h pour demain doit
  // etre annonce tout de suite plutot qu'attendre le lendemain : la relance
  // sert a prevenir, pas a respecter une heure.
  if (heureParis(maintenant) < HEURE_DE_RELANCE) { bilan.differe = true; return bilan }

  const aujourdhui = jourParis(maintenant)
  const demain = jourPlus(aujourdhui, 1)

  // ⚠ CE QUE LA REQUETE DEMANDE, ET POURQUOI CHAQUE CLAUSE Y EST :
  //   - `provider_id not null` : un menage que personne ne porte n'a personne a
  //     relancer — c'est `non_assigne`, l'affaire de l'hote ;
  //   - `status = accepted` : une PROPOSITION a sa propre boucle, et la
  //     relancer ici lui dirait « validez » quand on attend « acceptez » ;
  //   - `vu_le is null` : elle n'a pas valide. C'est tout l'objet ;
  //   - deux jours seulement : la garde d'envoi de masse.
  const { data: rows, error } = await supabase.from('menages')
    .select('id, user_id, property_id, provider_id, departure_date, vu_le, relance_vu_j1_le, relance_vu_j0_le')
    .in('departure_date', [aujourdhui, demain])
    .eq('status', 'accepted')
    .not('provider_id', 'is', null)
    .is('vu_le', null)
    .order('departure_date', { ascending: true })
    .limit(MAX_PAR_CYCLE * 4)
  if (error) {
    console.error('[relance-validation] lecture echec:', error.message)
    if (results.errors) results.errors.push({ context: 'relance_validation', error: error.message })
    bilan.erreurs++
    return bilan
  }

  const aFaire = []
  for (const m of (rows || [])) {
    const j0 = m.departure_date === aujourdhui
    // Le marqueur de CETTE relance-la. Les deux sont separes : la veille et le
    // matin sont deux messages differents, et un seul marqueur aurait fait
    // sauter le second.
    if (j0 ? m.relance_vu_j0_le : m.relance_vu_j1_le) continue
    aFaire.push({ ...m, j0 })
  }
  bilan.examines = aFaire.length

  // Les noms de biens, en une seule lecture : un SMS sans le logement ne dit
  // pas lequel des trois menages de la journee est concerne.
  const nomParBien = new Map()
  const ids = [...new Set(aFaire.map(m => String(m.property_id)))]
  if (ids.length) {
    const { data: props } = await supabase.from('properties')
      .select('id, user_id, name').in('id', ids)
    // ⚠ LA CLE PORTE LE COMPTE. `properties.id` est unique, mais une clé qui
    // melange les comptes finirait par servir le nom du bien d'un autre hote
    // dans un SMS — le genre de fuite qui ne se voit qu'une fois partie.
    for (const p of (props || [])) nomParBien.set(`${p.user_id}|${String(p.id)}`, p.name || null)
  }

  const base = (process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')

  for (const m of aFaire) {
    if (bilan.relances >= MAX_PAR_CYCLE) break
    let notif = null
    try {
      notif = await notifierValidationAttendue({
        userId: m.user_id, providerId: m.provider_id,
        propertyName: nomParBien.get(`${m.user_id}|${String(m.property_id)}`) || null,
        propertyId: String(m.property_id),
        departureDate: m.departure_date, leJour: m.j0,
        lien: `${base}/apps/menages/public`
      })
    } catch (e) {
      console.error('[relance-validation] notification echec:', m.id, e.message)
      bilan.erreurs++
      continue
    }
    // ⚠ LE MARQUEUR SE POSE MEME QUAND RIEN N'EST PARTI, et c'est un choix.
    // Un profil sans numero ni e-mail, ou qui a decoche les deux canaux, ne
    // recevra JAMAIS rien : reessayer toutes les 5 minutes jusqu'au depart ne
    // lui apprendrait rien et ferait tourner la lecture pour rien. Le compte
    // `muettes` est ce qui le dit dans les logs — l'hote, lui, le lit dans sa
    // fiche (« Aucun canal actif »).
    if (!notif || (!notif.sms && !notif.email)) bilan.muettes++
    const champ = m.j0 ? 'relance_vu_j0_le' : 'relance_vu_j1_le'
    const { error: errMarq } = await supabase.from('menages')
      .update({ [champ]: new Date().toISOString() }).eq('id', m.id)
    if (errMarq) {
      // ⚠ UN MARQUEUR NON POSE EST UN SMS DE TROP AU PROCHAIN CYCLE. On le
      // crie : c'est le seul defaut de ce module qui se paie chez la
      // prestataire, pas chez nous.
      console.error('[relance-validation] marqueur NON POSE:', m.id, champ, errMarq.message)
      bilan.erreurs++
      continue
    }
    if (notif && (notif.sms || notif.email)) bilan.relances++
  }

  console.log(`[relance-validation] examines=${bilan.examines} relances=${bilan.relances} muettes=${bilan.muettes} erreurs=${bilan.erreurs}`)
  if (results && typeof results === 'object') results.relancesValidation = bilan.relances
  return bilan
}

module.exports = { relancerValidations, HEURE_DE_RELANCE, MAX_PAR_CYCLE }
