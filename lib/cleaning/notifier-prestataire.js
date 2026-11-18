// lib/cleaning/notifier-prestataire.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Prevenir une prestataire qu'un menage lui est attribue — ou propose.
//
// ⚠ POURQUOI CE MODULE EXISTE. L'assignation directe est le geste d'URGENCE de
// l'hote : il l'utilise a deux heures du depart, quand quelqu'un se decommande.
// Le menage apparait aussitot dans la PWA — mais personne ne regarde sa PWA
// toutes les cinq minutes. Sans notification, le geste d'urgence est muet, et le
// logement n'est pas prepare alors que l'hote croit l'avoir confie.
//
// ⚠ UNE PROPOSITION EST DANS LE MEME CAS, EN PIRE : elle a une ECHEANCE. Muette,
// elle expire sans que la personne ait jamais su qu'on lui demandait quelque
// chose — et le menage retombe sur sa porteuse, qui n'avait rien demande.
//
// ⚠ BEST-EFFORT, ET C'EST VOULU. L'ecriture est deja faite en base quand on
// arrive ici : un envoi qui echoue ne doit ni la defaire ni faire echouer la
// requete. La verite reste la base ; le SMS n'est qu'un rappel.
//
// ⚠ LA NOTIFICATION D'ABORD, LE SMS SEULEMENT SI AUCUN TELEPHONE NE L'A RECUE
// (PWA lot 3, decisions Q40 a Q42 de Thierry ; spec
// docs/specs/spec-pwa-lot3-prestataires.md §5-§6 ; KB docs/kb/pwa.md §13).
// 1. La notification part a tous ses appareils abonnes, a toute heure.
// 2. Le SMS ne part que si AUCUN ne l'a recue — aucun abonne, tous morts, tous
//    en echec, ou notifications non configurees —, et toujours sous ses deux
//    conditions : un numero, et `notify_sms` non decoche par l'hote.
// 3. L'e-mail ne change pas.
// Le bilan dit `push: n` (le nombre d'appareils qui l'ont recue) a cote de
// `sms` et `email` : ce qui est REELLEMENT parti.

const { createClient } = require('@supabase/supabase-js')
const { sendSms } = require('../../api/sms')
const { sendPlatformEmail } = require('../platform-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le nom d'un bien vient du compte, pas d'un client — mais il finit dans un
// `innerHTML` d'email : un « & » ou un « < » y casserait le rendu.
function esc (t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function jourLisible (date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return String(date || '')
  // ⚠ En UTC : `departure_date` est une date de calendrier, pas un instant.
  // La lire en heure locale la decale d'un jour a l'ouest de Greenwich.
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  })
}

// L'echeance d'une proposition, telle qu'on la dit a quelqu'un.
//
// ⚠ EN HEURE DE PARIS, pas en UTC. `offer_expires_at` est un INSTANT : l'afficher
// en UTC annonce 16 h a quelqu'un qui a jusqu'a 18 h, et fait passer une
// proposition de fin de journee pour deja perdue.
function echeanceLisible (iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Paris'
  })
}

// Le profil a prevenir, ou `null`.
//
// ⚠ `access_mode = 'lien'` ICI AUSSI. Ce module est une lib reutilisable : sa
// garde ne doit pas etre plus faible que celle de ses appelants.
async function profilNotifiable (userId, providerId) {
  const { data: prof, error } = await supabase.from('profiles')
    // ⚠ `notify_sms` / `notify_email` SE LISENT ICI, avec les coordonnees.
    // Les oublier ferait retomber l'envoi sur la seule coordonnee — le
    // comportement d'avant — et le reglage de la fiche serait sans effet :
    // l'hote decocherait « SMS » et le SMS partirait quand meme.
    .select('first_name, phone, email, active, pwa_token, notify_sms, notify_email')
    .eq('id', providerId).eq('account_user_id', userId).eq('access_mode', 'lien')
    .maybeSingle()
  if (error || !prof || prof.active === false) return null
  return prof
}

// L'envoi lui-meme. Rend `{ sms, email }` : ce qui est REELLEMENT parti, pour que
// l'appelant puisse le dire a l'hote plutot que de promettre.
//
// ⚠ NI `sendSms` NI `sendPlatformEmail` NE LEVENT.
// Cle Brevo absente, `brevo_enabled` a false, numero invalide, erreur Brevo :
// tout ressort en `{ success: false }` / `{ ok: false }`. Le `try/catch`
// n'attrapait donc RIEN, et le bilan valait `{ sms: !!phone, email: !!email }`
// quoi qu'il arrive — l'ecran affichait « Elle a ete prevenue » a un hote sans
// Brevo configure, qui croyait avoir confie son logement. C'est la promesse
// centrale de ce module : elle se verifie sur la VALEUR DE RETOUR.
// ⚠ UN CANAL DEMANDE UNE INTENTION **ET** UNE COORDONNEE (15 septembre 2026).
// Avant, le canal se DEDUISAIT de la coordonnee : renseigner un numero, c'etait
// accepter de le faire sonner, et le seul moyen de ne pas notifier etait
// d'effacer le numero — donc de perdre le moyen de l'APPELER. Les deux sont
// maintenant distincts.
//
// ⚠ `!== false`, PAS `=== true`. La colonne est `not null default true`, mais
// un appelant qui construit un profil a la main (un test, un futur chemin) ne
// portera pas forcement le champ : `undefined` doit valoir « oui », jamais
// « non ». Une notification qu'on cesse d'envoyer par omission est exactement
// le genre de silence que ce module existe pour empecher.
function canalOuvert (prof, canal) {
  const coordonnee = canal === 'sms' ? prof.phone : prof.email
  const intention = canal === 'sms' ? prof.notify_sms : prof.notify_email
  return !!coordonnee && intention !== false
}

// La page de la prestataire, SANS jeton : c'est ce que le toucher ouvre.
// ⚠ L'EXPEDITEUR EST LA VRAIE GARANTIE (review de l'etape 2, constat 3) : sur
// iPhone 18.4+, le systeme ouvre le message declaratif SANS passer par son
// service worker. Donc ici : un chemin sous `/apps/menages/`, jamais le repli
// `/dashboard` de l'hote, jamais `token` ni `apercu`. C'est une constante.
const PAGE_PRESTATAIRE = '/apps/menages/public.html'

// Une notification par menage : la suivante remplace la precedente sur
// l'ecran (meme `tag`) — et elle SONNE quand meme (`rappel`) : chacune demande
// quelque chose a la personne.
function sujetDuMenage (propertyId, departureDate) {
  return `menage-${String(propertyId || '')}-${String(departureDate || '')}`.slice(0, 64)
}

// Rend le nombre d'appareils qui l'ont recue. Ne leve jamais.
// ⚠ `envoyer.js` EST CHARGE ICI, PAS EN TETE : ce module est requis par l'API
// de la page de la prestataire (`api/menages-public.js`), dont le demarrage a
// froid ne doit pas payer `web-push` (review de l'etape 1, constat 7).
async function notifierAppareils (providerId, { corps, sujet }) {
  try {
    const envoi = require('../push/envoyer')
    const message = envoi.messageDeclaratif({
      titre: 'HôteSmart', corps, chemin: PAGE_PRESTATAIRE, sujet, rappel: true, langue: 'fr'
    })
    const r = await envoi.envoyerAPrestataire({ profilId: providerId, message, db: supabase })
    return r && r.ok ? r.envoyes : 0
  } catch (e) {
    console.error('[notifier-prestataire] notification echec:', e.message)
    return 0
  }
}

async function envoyer (prof, { userId, providerId, propertyId, texte, sujet, etiquette, notification }) {
  const bilan = { push: 0, sms: false, email: false }
  if (notification) bilan.push = await notifierAppareils(providerId, notification)
  // ⚠ LE SMS SEULEMENT SI AUCUN APPAREIL NE L'A RECUE (decision Q41).
  if (bilan.push === 0 && canalOuvert(prof, 'sms')) {
    try {
      const r = await sendSms(prof.phone, texte, propertyId || null, etiquette, userId)
      bilan.sms = !!(r && r.success)
    } catch (e) { console.error('[notifier-prestataire] sms echec:', e.message) }
  }
  if (canalOuvert(prof, 'email')) {
    try {
      const r = await sendPlatformEmail(prof.email, sujet,
        `<p>Bonjour ${esc(prof.first_name || '')},</p><p>${esc(texte)}</p>`)
      bilan.email = !!(r && r.ok !== false)
    } catch (e) { console.error('[notifier-prestataire] email echec:', e.message) }
  }
  return bilan
}

// Le lien de la PWA, avec son jeton.
//
// ⚠ LE LIEN PORTE SON JETON. Sans `?token=`, la PWA affiche « Lien invalide »
// sur tout appareil qui ne l'a pas deja en localStorage — c'est-a-dire le
// telephone ou elle ouvre le SMS pour la premiere fois, ou le navigateur
// integre de l'app SMS. Le geste d'urgence serait alors muet, ce que ce module
// existe precisement pour empecher.
function lienAvecJeton (lien, prof) {
  return lien && prof.pwa_token ? `${lien}?token=${prof.pwa_token}` : null
}

// ⚠ Tiret SIMPLE partout, pas cadratin : « — » n'est pas dans GSM-7 et fait
// basculer TOUT le message en UCS-2, soit 67 caracteres par segment au lieu de
// 160. Mesure : 2 a 3 SMS par notification au lieu d'un, sur la cle Brevo de
// l'hote.
function suffixeBien (propertyName) {
  return propertyName ? ` - ${propertyName}` : ''
}

// UN MENAGE VIENT DE LUI ETRE ATTRIBUE (elle le porte, rien a confirmer).
async function notifierAssignation ({ userId, providerId, propertyName, propertyId, departureDate, lien }) {
  const bilan = { push: 0, sms: false, email: false }
  if (!userId || !providerId) return bilan
  const prof = await profilNotifiable(userId, providerId)
  if (!prof) return bilan

  const quand = jourLisible(departureDate)
  const ou = suffixeBien(propertyName)
  const url = lienAvecJeton(lien, prof)
  const texte = `Nouveau menage vous est attribue : ${quand}${ou}.` +
                (url ? ` Votre planning : ${url}` : '')
  return envoyer(prof, { userId, providerId, propertyId, texte,
                         sujet: `Menage du ${quand}${ou}`, etiquette: 'menage-assignation',
                         notification: { corps: `Nouveau ménage : ${quand}${ou}.`,
                                         sujet: sujetDuMenage(propertyId, departureDate) } })
}

// UN MENAGE LUI EST PROPOSE : elle doit repondre, et avant une date.
//
// ⚠ L'ECHEANCE EST DANS LE MESSAGE. Une proposition sans terme annonce n'est pas
// une demande, c'est une information : on ne peut pas reprocher a quelqu'un de
// n'avoir pas repondu a temps a un delai qu'on ne lui a pas dit.
async function notifierProposition ({ userId, providerId, propertyName, propertyId,
                                      departureDate, expireLe, lien }) {
  const bilan = { push: 0, sms: false, email: false }
  if (!userId || !providerId) return bilan
  const prof = await profilNotifiable(userId, providerId)
  if (!prof) return bilan

  const quand = jourLisible(departureDate)
  const ou = suffixeBien(propertyName)
  const url = lienAvecJeton(lien, prof)
  const avant = echeanceLisible(expireLe)
  const texte = `Menage a confirmer : ${quand}${ou}.` +
                (avant ? ` Repondez avant le ${avant}.` : '') +
                (url ? ` Repondre : ${url}` : '')
  return envoyer(prof, { userId, providerId, propertyId, texte,
                         sujet: `Menage a confirmer : ${quand}${ou}`,
                         etiquette: 'menage-proposition',
                         notification: { corps: `Ménage à confirmer : ${quand}${ou}.` +
                                                (avant ? ` Répondez avant le ${avant}.` : ''),
                                         sujet: sujetDuMenage(propertyId, departureDate) } })
}

// ON ATTEND SON « VU » SUR UN MENAGE QUI EST DEJA LE SIEN (14 octobre 2026).
//
// ⚠ CE N'EST PAS UNE DEMANDE DE CONFIRMATION, et le texte ne doit pas le
// laisser croire : le menage lui est attribue, il ne se refuse pas ici. On lui
// demande un ACCUSE DE LECTURE — « ouvrez votre page et touchez Vu » — parce
// que c'est la seule chose qui dise a l'hote qu'elle l'a lu.
//
// ⚠ LE MOT EST « VU », JAMAIS « VALIDER » (vocabulaire fixe par Thierry,
// recette du 14 octobre) : le SMS doit nommer EXACTEMENT le bouton qu'elle
// cherchera sur sa page. Un message qui dit « validez » devant un bouton qui
// dit « Vu » lui fait chercher autre chose.
//
// ⚠ LE TEXTE EST CELUI DE THIERRY, au mot pres. La seule chose qui varie est
// le rappel du jour meme, qui dit « aujourd'hui » : a 9 h du matin, le dernier
// rappel avant le depart du voyageur ne se lit pas comme celui de la veille.
async function notifierValidationAttendue ({ userId, providerId, propertyName, propertyId,
                                             departureDate, leJour = false, lien }) {
  const bilan = { push: 0, sms: false, email: false }
  if (!userId || !providerId) return bilan
  const prof = await profilNotifiable(userId, providerId)
  if (!prof) return bilan

  const quand = jourLisible(departureDate)
  // « a La bulle », et rien du tout quand le nom du bien manque : « a  » serait
  // une phrase cassee dans un SMS.
  const ou = propertyName ? ` a ${propertyName}` : ''
  const url = lienAvecJeton(lien, prof)
  // ⚠ Tiret SIMPLE et guillemets droits, comme partout ici : un cadratin ou un
  // chevron fait basculer tout le SMS en UCS-2, donc 67 caracteres par segment
  // au lieu de 160.
  const texte = `Un menage vous a ete attribue le ${quand}${ou}.` +
    (leJour ? ' C\'est aujourd\'hui.' : '') +
    ' Ouvrez votre page et touchez Vu.' +
    (url ? ` ${url}` : '')
  // ⚠ LA NOTIFICATION DIT LE MEME BOUTON QUE LE SMS : « Vu ».
  const ouN = propertyName ? ` à ${propertyName}` : ''
  return envoyer(prof, { userId, providerId, propertyId, texte,
                         sujet: `Menage du ${quand}${ou}`,
                         etiquette: leJour ? 'menage-relance-jour' : 'menage-relance-veille',
                         notification: { corps: `Ménage du ${quand}${ouN} : ouvrez votre page et touchez Vu.` +
                                                (leJour ? ' C’est aujourd’hui.' : ''),
                                         sujet: sujetDuMenage(propertyId, departureDate) } })
}

module.exports = { notifierAssignation, notifierProposition, notifierValidationAttendue,
                   jourLisible, echeanceLisible, canalOuvert, PAGE_PRESTATAIRE }
