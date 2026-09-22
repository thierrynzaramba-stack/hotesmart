// lib/prix-hote.js — LE PRIX DE L'HOTE SUR UN BIEN PILOTE (lot 4.6.4 bis).
// SEUL WRITER AUTORISE des tables `prix_hote` et `prix_hote_journal`.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, arbitrage A bis (22 sept. 2026).
// Migration : migrations/2026-09-22-prix-hote.sql
// DOC : docs/kb/coeur-de-donnees.md (modif = MEME COMMIT)
//
// CE QUE C'EST. Sur un bien pilote par YieldFlow, l'hote fixe lui-meme le prix
// d'une nuit depuis « Prix jour par jour ». Ce prix devient le prix retenu
// (ecrit par le writer du calendrier, journalise source 'host'), et LE MOTEUR
// NE L'ECRASE PAS : il saute ces nuits, a l'ouverture comme a l'entretien.
//
// ⚠ CE N'EST PAS UNE SECONDE MEMOIRE DU PRIX. Le prix affiche vit dans
// `calendar_inventory`, ecrit par le writer unique. Cette table dit QUELLES
// nuits portent la main de l'hote, et a quel prix il l'a posee — pour que
// l'ecran montre « votre prix » a cote de ce que YieldFlow proposait.
//
// JUSQU'A QUAND. Un prix de l'hote tient jusqu'a ce que la nuit soit passee
// (purge quotidienne) ou que l'hote le retire (« revenir au prix YieldFlow »).
// Il n'expire jamais seul : une main posee est une decision, pas un essai.
//
// ⚠ DESACTIVER LE PILOTE NE L'EFFACE PAS (dette 22, decision (a) de Thierry,
// 23 septembre 2026). Le premier dessin videait la table au retour en
// calendrier : a la reactivation, le moteur ecrasait des prix que l'hote
// croyait encore les siens, sans que rien ne l'ait dit — vecu en recette, sur
// deux nuits. Desactiver n'est pas un geste sur les prix. Les marques
// survivent donc ; a la reactivation, `recalerPrixHote` aligne chacune sur le
// prix affiche au calendrier (l'hote a pu le changer entre-temps, et c'est ce
// prix-la qu'il a vu en dernier).
//
// ⚠ LA VIE D'UNE MARQUE SE TRACE (`prix_hote_journal`, append-only). Le
// 22 septembre, la cause de la perte n'a ete etablie que par deduction : cette
// table ne gardait que l'etat courant. Chaque pose, remplacement, retrait,
// annulation, recalage et purge y laisse une ligne, avec son geste. Une trace
// perdue ne bloque pas le geste de l'hote — elle est une trace, pas la
// decision — mais elle se CRIE dans les logs (`TRACE PERDUE`), jamais en
// silence.
//
// ⚠ TABLE ABSENTE = AUCUN PRIX DE L'HOTE, comme pour les fermetures : une base
// deployee avant la migration ne bloque rien. Une vraie panne de lecture LEVE :
// un vide par erreur ferait ecraser un prix de l'hote par le moteur.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
const estJour = v => JOUR_RE.test(String(v || '')) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

const TABLE_ABSENTE_RE = /PGRST205|42P01|schema cache|does not exist/i
function tableAbsente (error) {
  return !!error && (error.code === 'PGRST205' || error.code === '42P01' ||
    (TABLE_ABSENTE_RE.test(error.message || '') && /prix_hote/.test(error.message || '')))
}
let absenceDite = false
let absenceJournalDite = false

const EVENEMENTS = ['posee', 'remplacee', 'retiree', 'annulee', 'recalee', 'purgee']
const GESTES = ['saisie_hote', 'retrait_hote', 'refus_ecriture', 'reactivation_pilote', 'nuit_passee']

// Une ligne par evenement et par nuit. Rend true si la trace est ecrite.
async function tracer (supabase, lignes) {
  if (!lignes.length) return true
  for (const l of lignes) {
    if (!EVENEMENTS.includes(l.evenement) || !GESTES.includes(l.geste)) throw new Error(`[prix_hote] trace invalide : ${l.evenement} / ${l.geste}`)
  }
  const { error } = await supabase.from('prix_hote_journal').insert(lignes.map(l => ({
    user_id: l.user_id, property_id: l.property_id, stay_date: l.stay_date, evenement: l.evenement, geste: l.geste,
    rate_cents: l.rate_cents == null ? null : l.rate_cents, rate_cents_avant: l.rate_cents_avant == null ? null : l.rate_cents_avant
  })))
  if (error && tableAbsente(error)) {
    if (!absenceJournalDite) { absenceJournalDite = true; console.warn('[prix_hote] journal absent : la migration 2026-09-23-prix-hote-journal.sql n est pas appliquee — aucune trace') }
    return false
  }
  if (error) {
    console.error(`[prix_hote] TRACE PERDUE (${lignes.length} evenement(s) ${lignes[0].evenement}/${lignes[0].geste}, bien ${lignes[0].property_id}) : ${error.message}`)
    return false
  }
  return true
}

// Les nuits de [debut, fin] dont l'hote a fixe le prix : Map date -> centimes.
async function prixHoteDuBien (supabase, propertyId, debut, fin) {
  if (!supabase || !UUID_RE.test(String(propertyId || ''))) throw new Error('[prix_hote] supabase et propertyId (uuid) requis')
  if (!estJour(debut) || !estJour(fin) || fin < debut) throw new Error('[prix_hote] periode invalide')
  const { data, error } = await supabase.from('prix_hote')
    .select('stay_date, rate_cents').eq('property_id', propertyId).gte('stay_date', debut).lte('stay_date', fin)
  if (tableAbsente(error)) {
    if (!absenceDite) { absenceDite = true; console.warn('[prix_hote] table absente : la migration 2026-09-22-prix-hote.sql n est pas appliquee — aucun prix de l hote') }
    return new Map()
  }
  if (error) throw new Error(`[prix_hote] lecture : ${error.message}`)
  return new Map((data || []).map(l => [l.stay_date, Number(l.rate_cents)]))
}

// Poser (ou remplacer) le prix de l'hote sur des nuits. `nuits` :
// [{ date, cents }]. Rend { ok, posees, avant } ou { ok: false, raison, message }.
// `avant` (Map date -> centimes) : les marques que cette pose REMPLACE. C'est
// ce que `annulerPose` restaure si le writer refuse ensuite — sans lui,
// l'annulation supprimait aussi une marque posee AVANT, et l'hote perdait un
// prix qu'il n'avait pas touche (meme famille que la dette 22).
async function poserPrixHote (supabase, { userId, propertyId, nuits }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  }
  // Une nuit, une ligne : deux segments d'une meme sauvegarde qui couvrent la
  // meme date faisaient viser deux fois la meme ligne par l'upsert, donc un
  // 503 (releve en review). Le dernier segment l'emporte, comme au calendrier.
  const parNuit = new Map()
  for (const n of nuits || []) {
    const cents = Math.round(Number(n && n.cents))
    if (!n || !estJour(n.date) || !Number.isInteger(cents) || cents <= 0) {
      return { ok: false, raison: 'nuit_invalide', message: `Nuit ou prix invalide : ${n && n.date} / ${n && n.cents}.` }
    }
    parNuit.set(n.date, { user_id: userId, property_id: propertyId, stay_date: n.date, rate_cents: cents, updated_at: new Date().toISOString() })
  }
  const lignes = [...parNuit.values()]
  if (!lignes.length) return { ok: true, posees: 0, avant: new Map() }
  // ⚠ UNE LECTURE EN ECHEC REFUSE : poser sans savoir ce qu'on remplace
  // rendrait l'annulation aveugle.
  const { data: exist, error: eLu } = await supabase.from('prix_hote').select('stay_date, rate_cents')
    .eq('user_id', userId).eq('property_id', propertyId).in('stay_date', lignes.map(l => l.stay_date))
  if (eLu) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${eLu.message}` }
  const avant = new Map((exist || []).map(l => [l.stay_date, Number(l.rate_cents)]))
  const { error } = await supabase.from('prix_hote').upsert(lignes, { onConflict: 'property_id,stay_date' })
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Enregistrement impossible : ${error.message}` }
  await tracer(supabase, lignes.map(l => ({ user_id: userId, property_id: propertyId, stay_date: l.stay_date,
    evenement: avant.has(l.stay_date) ? 'remplacee' : 'posee', geste: 'saisie_hote',
    rate_cents: l.rate_cents, rate_cents_avant: avant.has(l.stay_date) ? avant.get(l.stay_date) : null })))
  return { ok: true, posees: lignes.length, avant }
}

// Defaire une pose que le writer a refusee : une marque qui existait AVANT
// retrouve son prix, une marque neuve disparait. `nuits` = ce qui a ete
// pose ; `avant` = ce que `poserPrixHote` a rendu.
//
// ⚠ SEULEMENT SI LA MARQUE PORTE ENCORE CE QUI A ETE POSE (releve en review).
// `avant` est une photo prise avant la pose : deux onglets sur la meme nuit —
// A pose 5 € (refuse), B pose 180 € (accepte) — et restaurer sans condition
// remettait 150 € par-dessus les 180 € de B. Chaque nuit se defait donc par
// une ecriture CONDITIONNELLE (`rate_cents` = le montant pose) ; une nuit que
// quelqu'un a reposee entre-temps n'est pas touchee. Chaque nuit se trace
// selon son propre resultat : une annulation a moitie faite se lit a moitie.
// Rend { ok, echecs } — `echecs` : les nuits qu'on n'a pas pu defaire.
async function annulerPose (supabase, { userId, propertyId, nuits, avant }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) return { ok: false, echecs: [] }
  const av = avant instanceof Map ? avant : new Map()
  const posees = new Map((nuits || []).filter(n => n && estJour(n.date)).map(n => [n.date, Math.round(Number(n.cents))]))
  const faites = []
  const echecs = []
  for (const [j, pose] of posees) {
    const q = av.has(j)
      ? supabase.from('prix_hote').update({ rate_cents: av.get(j), updated_at: new Date().toISOString() })
      : supabase.from('prix_hote').delete()
    const { data, error } = await q.eq('user_id', userId).eq('property_id', propertyId).eq('stay_date', j).eq('rate_cents', pose)
      .select('stay_date')
    if (error) { echecs.push(j); console.error('[prix_hote] annulation', propertyId, j, error.message); continue }
    // Rien de touche : la marque a change entre-temps, elle n'est plus la notre.
    if ((data || []).length) faites.push(j)
  }
  await tracer(supabase, faites.map(j => ({ user_id: userId, property_id: propertyId, stay_date: j, evenement: 'annulee',
    geste: 'refus_ecriture', rate_cents: av.has(j) ? av.get(j) : null, rate_cents_avant: posees.get(j) })))
  return { ok: !echecs.length, echecs }
}

// Retirer la main de l'hote sur des nuits : le moteur les reprendra au
// passage suivant. Le compte et le bien sont dans le WHERE.
async function retirerPrixHote (supabase, { userId, propertyId, dates }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || ''))) {
    return { ok: false, raison: 'parametres_invalides', message: 'Compte et logement requis.' }
  }
  const jours = [...new Set((dates || []).filter(estJour))]
  if (!jours.length) return { ok: false, raison: 'nuit_invalide', message: 'Aucune nuit valide.' }
  const { data, error } = await supabase.from('prix_hote').delete()
    .eq('user_id', userId).eq('property_id', propertyId).in('stay_date', jours).select('stay_date, rate_cents')
  if (error) return { ok: false, raison: 'ecriture_impossible', message: `Retrait impossible : ${error.message}` }
  await tracer(supabase, (data || []).map(l => ({ user_id: userId, property_id: propertyId, stay_date: l.stay_date,
    evenement: 'retiree', geste: 'retrait_hote', rate_cents: null, rate_cents_avant: l.rate_cents == null ? null : Number(l.rate_cents) })))
  return { ok: true, retirees: (data || []).map(l => l.stay_date) }
}

// Les nuits passees ne portent plus de main : purge, par le pilote quotidien.
async function purgerPrixHotePasses (supabase, propertyId, aujourdHui) {
  if (!UUID_RE.test(String(propertyId || '')) || !estJour(aujourdHui)) return { ok: false }
  const { data, error } = await supabase.from('prix_hote').delete().eq('property_id', propertyId).lt('stay_date', aujourdHui)
    .select('user_id, stay_date, rate_cents')
  if (error && !tableAbsente(error)) console.error('[prix_hote] purge', propertyId, error.message)
  if (!error) {
    await tracer(supabase, (data || []).map(l => ({ user_id: l.user_id, property_id: propertyId, stay_date: l.stay_date,
      evenement: 'purgee', geste: 'nuit_passee', rate_cents: null, rate_cents_avant: l.rate_cents == null ? null : Number(l.rate_cents) })))
  }
  return { ok: !error }
}

// A LA REACTIVATION DU PILOTE (dette 22) : les marques ont survecu a la
// desactivation. Chacune reprend le prix AFFICHE au calendrier — pendant la
// desactivation, l'hote tenait ses prix a la main et a pu changer celui-ci ;
// c'est le dernier qu'il a vu, donc le sien. Une nuit sans prix au calendrier
// garde la marque telle quelle : on ne remplace pas une decision par un vide.
// Les nuits passees sont purgees d'abord (le pilote quotidien ne l'a pas fait
// pendant la desactivation). Rend { ok, nuits, recalees } — `nuits` = les
// marques a venir, ce que la confirmation annonce.
async function recalerPrixHote (supabase, { userId, propertyId, aujourdHui }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || '')) || !estJour(aujourdHui)) {
    return { ok: false, message: 'parametres invalides' }
  }
  await purgerPrixHotePasses(supabase, propertyId, aujourdHui)
  const { data: marques, error } = await supabase.from('prix_hote').select('stay_date, rate_cents')
    .eq('user_id', userId).eq('property_id', propertyId).gte('stay_date', aujourdHui)
  if (tableAbsente(error)) return { ok: true, nuits: 0, recalees: 0 }
  if (error) return { ok: false, message: error.message }
  if (!(marques || []).length) return { ok: true, nuits: 0, recalees: 0 }
  const { data: cal, error: eCal } = await supabase.from('calendar_inventory').select('date, rate')
    .eq('property_id', propertyId).in('date', marques.map(m => m.stay_date))
  if (eCal) return { ok: false, nuits: marques.length, message: eCal.message }
  const affiche = new Map((cal || []).filter(l => l.rate != null && Number(l.rate) > 0).map(l => [l.date, Math.round(Number(l.rate) * 100)]))
  const aRecaler = marques.filter(m => affiche.has(m.stay_date) && affiche.get(m.stay_date) !== Number(m.rate_cents))
  if (aRecaler.length) {
    const { error: eUp } = await supabase.from('prix_hote').upsert(aRecaler.map(m => ({ user_id: userId, property_id: propertyId,
      stay_date: m.stay_date, rate_cents: affiche.get(m.stay_date), updated_at: new Date().toISOString() })), { onConflict: 'property_id,stay_date' })
    if (eUp) return { ok: false, nuits: marques.length, message: eUp.message }
    await tracer(supabase, aRecaler.map(m => ({ user_id: userId, property_id: propertyId, stay_date: m.stay_date, evenement: 'recalee',
      geste: 'reactivation_pilote', rate_cents: affiche.get(m.stay_date), rate_cents_avant: Number(m.rate_cents) })))
  }
  return { ok: true, nuits: marques.length, recalees: aRecaler.length }
}

// Combien de nuits A VENIR portent la main de l'hote : ce que les deux
// confirmations du pilote annoncent. Table absente = 0 ; panne = null (« je
// ne sais pas » n'est pas « aucune » — l'ecran se tait plutot que d'annoncer 0).
async function compterPrixHote (supabase, { userId, propertyId, aujourdHui }) {
  if (!UUID_RE.test(String(userId || '')) || !UUID_RE.test(String(propertyId || '')) || !estJour(aujourdHui)) return null
  const { count, error } = await supabase.from('prix_hote').select('stay_date', { count: 'exact', head: true })
    .eq('user_id', userId).eq('property_id', propertyId).gte('stay_date', aujourdHui)
  if (tableAbsente(error)) return 0
  if (error) { console.error('[prix_hote] compte', propertyId, error.message); return null }
  return count || 0
}

module.exports = { prixHoteDuBien, poserPrixHote, annulerPose, retirerPrixHote, purgerPrixHotePasses, recalerPrixHote, compterPrixHote }
