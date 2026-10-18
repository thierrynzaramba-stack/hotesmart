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
const { colonneAbsente } = require('../colonne-absente')

// ⚠ UNE VALIDATION NE VAUT QUE POUR QUI L'A POSEE (constat de la revue de
// 20fb83d). La meme regle que `api/garde.js` et `api/menages-public.js` : un
// menage qui change de main perd la validation de la precedente.
function valideParLaPorteuse (m) {
  if (!m || !m.vu_le) return null
  if (!('vu_par' in m)) return m.vu_le || null
  if (!m.provider_id) return null
  return String(m.vu_par || '') === String(m.provider_id) ? m.vu_le : null
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ 9 H DE PARIS, PAS 9 H UTC. En heure d'ete, 9 h UTC est 11 h chez l'hote :
// la relance « du matin » arriverait apres le depart du voyageur sur un
// checkout a 10 h.
const HEURE_DE_RELANCE = 9

// Le plafond par cycle. Le cron tourne toutes les 5 minutes : ce qui depasse
// part au cycle suivant, et rien ne se perd — les marqueurs sont en base.
const MAX_PAR_CYCLE = 60
// Le plafond de LECTURE, par jour. Il est large : le filtre du marqueur est
// pose en base, donc ce lot ne contient que ce qui n'a pas encore ete relance.
const MAX_PAR_LOT = 500

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
  const bilan = { examines: 0, relances: 0, muettes: 0, erreurs: 0, differe: false,
                  faits: 0, horsPage: 0, lotPlein: false }

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
  //   - le MARQUEUR DU JOUR est nul : c'est la garde anti-repetition, et elle
  //     est posee EN BASE, pas en JS (constat de la revue de 20fb83d : filtree
  //     apres la limite, elle laissait les lignes deja relancees manger toutes
  //     les places, et les menages de DEMAIN n'etaient jamais lus) ;
  //   - un seul jour par requete, donc : chacun a son marqueur, et aucun des
  //     deux ne peut affamer l'autre ;
  //   - deux jours seulement : la garde d'envoi de masse.
  //
  // ⚠ `vu_le` NE SE FILTRE PLUS EN BASE : « valide » veut dire `vu_le` pose ET
  // `vu_par = provider_id`, et PostgREST ne compare pas deux colonnes. Le tri
  // se fait donc en JS, juste en dessous — sur un lot deja borne par le
  // marqueur.
  const jours = [{ jour: aujourdhui, j0: true, champ: 'relance_vu_j0_le' },
                 { jour: demain, j0: false, champ: 'relance_vu_j1_le' }]
  const aFaire = []
  for (const d of jours) {
    const { data: rows, error } = await supabase.from('menages')
      .select('id, user_id, property_id, provider_id, departure_date, vu_le, vu_par, booking_id')
      .eq('departure_date', d.jour)
      .eq('status', 'accepted')
      .not('provider_id', 'is', null)
      .is(d.champ, null)
      .limit(MAX_PAR_LOT)
    if (error) {
      const quoi = colonneAbsente(error)
        ? `migrations 2026-10-14-menage-vu-le / -vu-par non appliquees (${error.message})`
        : error.message
      console.error('[relance-validation] lecture echec:', quoi)
      if (results.errors) results.errors.push({ context: 'relance_validation', error: quoi })
      bilan.erreurs++
      return bilan
    }
    // ⚠ LA LIMITE ATTEINTE SE DIT. Silencieuse, elle laisserait une queue de
    // liste sans aucune relance et `examines` a l'air d'un cycle calme.
    if ((rows || []).length >= MAX_PAR_LOT) {
      console.warn(`[relance-validation] lot plein (${MAX_PAR_LOT}) sur ${d.jour} : des menages ne seront pas relances ce cycle`)
      bilan.lotPlein = true
    }
    for (const m of (rows || [])) {
      // ⚠ UNE VALIDATION D'UNE AUTRE PERSONNE NE COMPTE PAS : apres une
      // reassignation, celle qui porte le menage maintenant n'a rien lu.
      if (valideParLaPorteuse(m)) continue
      aFaire.push({ ...m, j0: d.j0, champ: d.champ })
    }
  }
  bilan.examines = aFaire.length

  // ⚠ UN MENAGE DEJA FAIT NE SE RELANCE PAS (constat de la revue de 20fb83d).
  // Le « fait » vit dans `menage_done`, pas dans `menages.status` : sans cette
  // lecture, elle finissait son menage a 8 h et recevait a 9 h « touchez Vu »
  // sur une page ou le bouton n'existe plus (`estAValider` exclut `m.done`).
  // Un SMS auquel on ne PEUT pas obeir est le plus sur moyen de lui apprendre
  // a ne plus les lire.
  if (aFaire.length) {
    const { data: faits, error: errFaits } = await supabase.from('menage_done')
      .select('property_id, booking_id, departure_date')
      .in('departure_date', [aujourdhui, demain])
      .limit(MAX_PAR_LOT * 2)
    if (errFaits) {
      // ⚠ ON NE RELANCE PAS DANS LE DOUTE. Ne pas pouvoir lire « fait » rend
      // chaque envoi potentiellement inutile : on repasse dans 5 minutes.
      console.error('[relance-validation] lecture des menages faits echec:', errFaits.message)
      if (results.errors) results.errors.push({ context: 'relance_validation', error: errFaits.message })
      bilan.erreurs++
      return bilan
    }
    const dejaFaits = new Set((faits || []).map(f =>
      `${String(f.property_id)}|${String(f.booking_id)}|${String(f.departure_date).slice(0, 10)}`))
    const restants = aFaire.filter(m =>
      !dejaFaits.has(`${String(m.property_id)}|${String(m.booking_id)}|${m.departure_date}`))
    bilan.faits = aFaire.length - restants.length
    aFaire.length = 0
    aFaire.push(...restants)
    bilan.examines = aFaire.length
  }

  // ⚠ ON NE RELANCE PAS SUR UN MENAGE QUI N'EST PAS SUR SA PAGE (constat de la
  // revue de 20fb83d). Une liaison `property_cleaning_providers` sur un bien
  // suffit a lui attribuer le menage, mais c'est `public_tokens.property_ids`
  // qui decide de ce que sa PAGE affiche — et les deux ont diverge dans ce
  // depot (ancien second writer de `property_ids`). Sans cette garde, elle
  // recevait « touchez Vu », ouvrait sa page, et n'y trouvait rien : un SMS
  // auquel on ne PEUT pas obeir.
  //
  // ⚠ UNE LISTE VIDE VEUT DIRE « TOUS LES BIENS », comme partout ici. Et un
  // profil SANS JETON n'a aucune page : rien a quoi l'envoyer.
  // ⚠ ON NE MARQUE RIEN DANS CE CAS : ce n'est pas une relance faite, c'est un
  // reglage a reparer. Le crier a chaque cycle est le seul signal qui existe.
  if (aFaire.length) {
    const profils = [...new Set(aFaire.map(m => String(m.provider_id)))]
    const { data: lignes, error: errProf } = await supabase.from('profiles')
      .select('id, pwa_token').in('id', profils)
    if (errProf) {
      console.error('[relance-validation] lecture des profils echec:', errProf.message)
      if (results.errors) results.errors.push({ context: 'relance_validation', error: errProf.message })
      bilan.erreurs++
      return bilan
    }
    const jetonDe = new Map((lignes || []).map(l => [String(l.id), l.pwa_token || null]))
    const jetons = [...new Set([...jetonDe.values()].filter(Boolean))]
    let perimetreDe = new Map()
    if (jetons.length) {
      const { data: pts, error: errPt } = await supabase.from('public_tokens')
        .select('token, property_ids').in('token', jetons)
      if (errPt) {
        console.error('[relance-validation] lecture des perimetres echec:', errPt.message)
        if (results.errors) results.errors.push({ context: 'relance_validation', error: errPt.message })
        bilan.erreurs++
        return bilan
      }
      perimetreDe = new Map((pts || []).map(x => [String(x.token), (x.property_ids || []).map(String)]))
    }
    const joignables = aFaire.filter(m => {
      const jeton = jetonDe.get(String(m.provider_id))
      if (!jeton) return false
      const ids = perimetreDe.get(String(jeton))
      if (!ids) return false
      return !ids.length || ids.includes(String(m.property_id))
    })
    bilan.horsPage = aFaire.length - joignables.length
    if (bilan.horsPage) {
      console.warn(`[relance-validation] ${bilan.horsPage} menage(s) non relance(s) : absents de la page de leur prestataire (lien supprime, ou bien hors de public_tokens.property_ids)`)
    }
    aFaire.length = 0
    aFaire.push(...joignables)
    bilan.examines = aFaire.length
  }

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
    if (bilan.relances + bilan.muettes >= MAX_PAR_CYCLE) break

    // ⚠ LE MARQUEUR SE POSE AVANT L'ENVOI, ET C'EST L'ORDRE QUI COMPTE
    // (constat de la revue de 20fb83d). Pose APRES, un echec durable de
    // l'UPDATE — droit, verrou, colonne absente parce que la migration n'est
    // passee qu'a moitie — laissait la ligne eligible au cycle suivant : le
    // MEME SMS repartait toutes les 5 minutes, jusqu'a 288 par jour et par
    // menage, sur la cle Brevo de l'hote, et rien ne sonnait nulle part.
    //
    // Ce que cet ordre coute, et c'est assume : si le marqueur passe et que
    // l'envoi echoue, ce rappel-la est perdu. Il en reste un second (la veille
    // puis le matin), et l'alerte « Non valide » de l'hote, elle, ne depend pas
    // de l'envoi. Entre un rappel perdu et une boucle de SMS chez quelqu'un
    // qui travaille, le choix n'est pas difficile.
    const { error: errMarq } = await supabase.from('menages')
      .update({ [m.champ]: new Date().toISOString() }).eq('id', m.id)
      .is(m.champ, null)
    if (errMarq) {
      console.error('[relance-validation] marqueur NON POSE, envoi annule:', m.id, m.champ, errMarq.message)
      bilan.erreurs++
      // ⚠ ON S'ARRETE LA POUR CE CYCLE. Si l'UPDATE echoue sur une ligne, il
      // echouera sur les suivantes (meme table, meme colonne) : continuer
      // n'enverrait que des messages qu'on ne sait pas marquer.
      break
    }

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
    // ⚠ UN PROFIL MUET N'EST PAS UNE ERREUR. Sans numero ni e-mail, ou les deux
    // canaux decoches, rien ne partira jamais : le marqueur est deja pose, on
    // ne reessaiera pas. Le compte `muettes` le dit dans les logs — l'hote, lui,
    // le lit dans sa fiche (« Aucun canal actif »).
    if (!notif || (!notif.sms && !notif.email)) bilan.muettes++
    else bilan.relances++
  }

  console.log(`[relance-validation] examines=${bilan.examines} relances=${bilan.relances} muettes=${bilan.muettes} faits=${bilan.faits} hors_page=${bilan.horsPage} erreurs=${bilan.erreurs}`)
  if (results && typeof results === 'object') results.relancesValidation = bilan.relances
  return bilan
}

module.exports = { relancerValidations, HEURE_DE_RELANCE, MAX_PAR_CYCLE }
