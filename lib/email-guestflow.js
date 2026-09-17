// lib/email-guestflow.js
// DOC : docs/kb/guestflow.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-canal-email-resa-directe.md — etape 3
//
// L'ENVOI E-MAIL AU VOYAGEUR, AVEC LA CLE DE L'HOTE.
//
// ⚠ MULTI-TENANT STRICT, AUCUN REPLI SUR L'ENV. La cle Brevo est celle du compte
// PROPRIETAIRE du bien (`api_keys.brevo_api_key`), jamais `process.env`. C'est la
// meme regle que `api/sms.js` : ce sont les credits de l'hote, son domaine, sa
// reputation d'expediteur. Un repli sur une cle plateforme ferait partir les
// messages de tous les hotes depuis la meme adresse — et un seul spam signale les
// couperait tous.
//
// ⚠ CE MODULE NE CONNAIT NI LE CRON NI LES TEMPLATES. Il recoit un destinataire,
// un sujet, un texte, et rend un envoi. `lib/email-voyageur.js` (confirmation de
// reservation du moteur) le rejoindra a l'etape 5 : les deux construisent
// aujourd'hui leur propre enveloppe, et c'est une convergence a faire, pas un
// oubli a laisser.
//
// ⚠ UN ECHEC N'EST PAS L'AUTRE. Le retour porte `permanent` :
//   - 4xx Brevo (adresse invalide, expediteur non verifie) -> rien ne changera au
//     prochain essai. Retenter toutes les 5 minutes est une boucle, pas une
//     resilience : l'appelant abandonne, ecrit son journal et PREVIENT l'hote.
//   - 5xx, reseau, 429 (quota) -> transitoire. On ne note rien, on repassera.
// Compter les tentatives sans distinguer les deux aurait fait attendre cinq
// echecs a une adresse qui ne marchera jamais, et abandonne un quota qui se
// retablit tout seul a minuit.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const BREVO_EMAIL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_SENDERS = 'https://api.brevo.com/v3/senders'

// ─── L'expediteur ────────────────────────────────────────────────────────────
// ⚠ BREVO N'ENVOIE QU'AU NOM D'UN EXPEDITEUR VERIFIE. Une adresse saisie
// librement rend 400 a l'envoi, pas a la configuration : l'hote croirait avoir
// regle son adresse et ne verrait l'echec qu'au premier message rate.
//
// L'hote choisit son adresse sur l'ecran des connexions, qui ne lui propose que
// les expediteurs verifies de SON compte (`api_keys.brevo_sender_email`). Tant
// qu'il n'a rien choisi, on prend le PREMIER expediteur ACTIF — c'est-a-dire une
// adresse dont Brevo garantit deja qu'elle peut envoyer. Ce repli n'est pas
// provisoire : il reste le defaut propre que la spec demande.
//
// ⚠ LE CACHE NE PORTE QUE LA LISTE BREVO, JAMAIS LE CHOIX DE L'HOTE.
// Il existe pour epargner un aller-retour RESEAU EXTERNE par message, pas une
// lecture Supabase. Y ranger la configuration serait une fausse economie et une
// vraie surprise : apres un changement d'adresse dans /connexions, toute instance
// Vercel chaude aurait continue d'envoyer sous l'ancienne pendant dix minutes —
// l'hote teste, voit l'ancienne adresse, et conclut que son reglage n'a pas pris.
// Constat de review.
//
// Le cache vit dans le process, pas au-dela : un expediteur ajoute chez Brevo est
// vu au prochain demarrage, et une invalidation fine ne vaudrait pas sa complexite.
const CACHE_MS = 10 * 60 * 1000
const cacheExpediteur = new Map()

// ⚠ NE LEVE JAMAIS. L'appelant peut avoir un repli a jouer (la confirmation de
// reservation en a un) : une exception qui traverse le prive de ce repli, et un
// voyageur qui vient de payer se retrouve sans rien pour un hoquet de Supabase.
// Tout ce qui peut lever ici est ANTERIEUR a l'envoi, donc rien n'est parti.
async function configDuCompte (userId) {
  try {
    return await lireConfigDuCompte(userId)
  } catch (e) {
    console.error('[email-guestflow] lecture de configuration impossible', e.message)
    return { ok: false, raison: `config_illisible: ${e.message}`, transitoire: true }
  }
}

async function lireConfigDuCompte (userId) {
  if (!userId) return { ok: false, raison: 'compte_inconnu' }

  // ⚠ LES COLONNES D'EXPEDITEUR PEUVENT MANQUER. Elles arrivent par une migration
  // collee a la main dans Supabase : entre le deploiement et ce geste, un SELECT
  // qui les nomme echoue en entier — donc plus aucun e-mail, alors que la cle et
  // les expediteurs verifies sont la. On retombe sur le strict necessaire, et le
  // defaut (premier expediteur actif) reprend la main.
  let { data, error } = await supabase
    .from('api_keys')
    .select('brevo_api_key, brevo_enabled, brevo_sender_email, brevo_sender_name')
    .eq('user_id', userId)
    .maybeSingle()
  if (error && /brevo_sender|pgrst204|schema cache/i.test(`${error.code || ''} ${error.message || ''}`)) {
    console.error('[email-guestflow] colonnes d\'expediteur absentes, repli sur le defaut'
      + ' — migration 2026-09-17 a appliquer')
    ;({ data, error } = await supabase
      .from('api_keys')
      .select('brevo_api_key, brevo_enabled')
      .eq('user_id', userId)
      .maybeSingle())
  }

  // ⚠ UNE PANNE DE LECTURE N'EST PAS UNE ABSENCE DE CONFIGURATION.
  // Rendre « non configure » sur un timeout ferait dire a l'hote qu'il n'a rien
  // regle, et surtout : c'est un echec PERMANENT pour l'appelant, donc un message
  // abandonne pour de bon. On rend transitoire, et on ne met rien en cache.
  if (error) return { ok: false, raison: 'lecture_config_impossible', transitoire: true }
  if (!data || !data.brevo_api_key) return { ok: false, raison: 'brevo_non_configure' }
  if (data.brevo_enabled === false)  return { ok: false, raison: 'brevo_desactive' }

  // ⚠ LE CHOIX DE L'HOTE D'ABORD, LE DEFAUT ENSUITE.
  // `brevo_sender_email` est pose par l'ecran des connexions, qui ne propose que
  // des expediteurs VERIFIES et les REVERIFIE cote serveur avant d'ecrire. On
  // peut donc s'y fier sans redemander la liste a Brevo a chaque message — c'est
  // un aller-retour reseau economise sur le chemin d'envoi, et la seule facon de
  // respecter le choix de l'hote quand son compte en porte plusieurs.
  //
  // ⚠ ET SI CE CHOIX CESSE D'ETRE VALIDE ? Un expediteur supprime chez Brevo fait
  // rendre 400 A L'ENVOI, que l'appelant traite en echec PERMANENT : l'hote est
  // prevenu une fois et rouvre l'ecran. Retomber ici en silence sur un autre
  // expediteur ferait partir ses messages sous une identite qu'il n'a pas choisie
  // — pire que l'echec, parce que personne ne le verrait.
  if (data.brevo_sender_email) {
    // Choix explicite : aucun appel Brevo, donc rien a mettre en cache.
    return { ok: true, cle: data.brevo_api_key,
             email: data.brevo_sender_email,
             nom: data.brevo_sender_name || data.brevo_sender_email }
  }

  // Defaut : c'est ICI qu'on interroge Brevo, et c'est donc ici — et seulement
  // ici — que le cache a un sens.
  const enCache = cacheExpediteur.get(String(userId))
  const expediteur = (enCache && Date.now() - enCache.pose < CACHE_MS)
    ? enCache.valeur
    : await premierExpediteurActif(data.brevo_api_key)
  if (!expediteur.ok) return expediteur
  cacheExpediteur.set(String(userId), { pose: Date.now(), valeur: expediteur })

  return { ok: true, cle: data.brevo_api_key, email: expediteur.email, nom: expediteur.nom }
}

async function premierExpediteurActif (cle) {
  let r
  try {
    r = await fetch(BREVO_SENDERS, { headers: { 'api-key': cle } })
  } catch (e) {
    return { ok: false, raison: `senders_injoignable: ${e.message}`, transitoire: true }
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, raison: `senders_${r.status}`, transitoire: r.status >= 500 || r.status === 429 }
  }
  const actifs = (j.senders || []).filter(s => s.active !== false && s.email)
  if (!actifs.length) return { ok: false, raison: 'aucun_expediteur_verifie' }
  return { ok: true, email: actifs[0].email, nom: actifs[0].name || actifs[0].email }
}

function _viderCacheExpediteur () { cacheExpediteur.clear() }

// ─── Le corps ────────────────────────────────────────────────────────────────
function esc (v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ⚠ LE TEXTE DU TEMPLATE PART TEL QUEL — la spec dit « pas de refonte des
// templates ». On l'echappe (c'est du texte, pas du HTML : une apostrophe ou un
// « < » ne doit pas casser la page ni ouvrir une injection dans la boite du
// voyageur), puis on rend les sauts de ligne visibles. Un paragraphe par ligne
// vide, un <br> par saut simple : c'est ce que l'hote a tape, et c'est ce qu'il
// verra.
function texteVersHtml (texte) {
  return String(texte || '')
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// ⚠ MARQUE BLANCHE. Le seul nom qui apparait est celui du BIEN. Aucun logo, aucune
// mention HoteSmart : pour le voyageur, ce message vient de son hote.
function enveloppe (corpsHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;`
    + `max-width:560px;margin:0 auto;color:#1f1e1c;line-height:1.6;font-size:15px">`
    + corpsHtml + `</div>`
}

// ─── Le sujet ────────────────────────────────────────────────────────────────
// ⚠ UN TEMPLATE N'A PAS DE SUJET, ET ON N'EN AJOUTE PAS UN (« pas de refonte des
// templates », spec §4). On le derive donc de l'evenement et du nom du bien.
//
// ⚠ EN FRANCAIS, PARCE QUE LE CORPS L'EST. Le texte du template est ecrit par
// l'hote, dans sa langue, et il part tel quel : un sujet traduit devant un corps
// francais serait un faux service. Le jour ou les templates seront multilingues,
// ce sont les deux qui suivront la langue du voyageur (`customer.language` est
// dans le coeur), pas le sujet seul.
const SUJETS = {
  booking_confirmed: b => `Votre réservation à ${b}`,
  arrival:           b => `Votre arrivée à ${b}`,
  arrival_code:      b => `Votre code d'accès — ${b}`,
  departure:         b => `Votre départ de ${b}`,
  menage_done:       b => `Votre logement est prêt — ${b}`
}

function sujetPour (eventType, bienNom) {
  const bien = String(bienNom || '').trim()
  const f = SUJETS[String(eventType || '').trim()]
  if (!bien) return f ? f('votre séjour') : 'Un message de votre hôte'
  return f ? f(bien) : `${bien} — un message de votre hôte`
}

// ─── L'envoi ─────────────────────────────────────────────────────────────────
// Rend { ok, id } ou { ok:false, raison, permanent }.
// Le texte d'un template GuestFlow : echappe et mis en forme ici.
async function envoyerEmailVoyageur ({ userId, destinataire, sujet, texte, propertyId, propertyName }) {
  if (!texte) return { ok: false, raison: 'texte_vide', permanent: true }
  return await envoyerHtml({
    userId, destinataire, sujet, propertyId, propertyName,
    html: enveloppe(texteVersHtml(texte))
  })
}

// ⚠ MEME CANAL, HTML DEJA CONSTRUIT. La confirmation de reservation
// (`lib/email-voyageur.js`) compose un corps riche et trilingue : tableau des
// dates, politique d'annulation, contact de l'hote. Elle a besoin du MEME envoi
// — cle de l'hote, expediteur verifie, reply-to, classement des echecs — sans
// repasser par la mise en forme du texte brut.
//
// ⚠ LE NOM NE DIT PLUS « VOYAGEUR », ET C'EST VOULU. Depuis la notification de
// nouvelle reservation, le destinataire peut etre l'HOTE lui-meme. Ce que cette
// fonction garantit n'a jamais ete « ca part au voyageur » mais « ca part avec
// la cle et sous l'identite de CE compte » — le nom le dit enfin.
//
// C'est le seul chemin vers Brevo pour tout ce qui sort d'un compte hote.
async function envoyerHtml ({ userId, destinataire, sujet, html, propertyId, propertyName }) {
  if (!destinataire) return { ok: false, raison: 'destinataire_manquant', permanent: true }
  if (!sujet)        return { ok: false, raison: 'sujet_manquant', permanent: true }
  if (!html)         return { ok: false, raison: 'corps_vide', permanent: true }

  const config = await configDuCompte(userId)
  if (!config.ok) {
    // Une configuration absente est PERMANENTE : aucun nombre de tentatives ne la
    // fera apparaitre. C'est un geste de l'hote qu'il faut, donc on le lui demande
    // une fois — au lieu de reessayer toutes les cinq minutes en silence.
    return { ok: false, raison: config.raison, permanent: !config.transitoire }
  }

  let r
  try {
    r = await fetch(BREVO_EMAIL, {
      method: 'POST',
      headers: { 'api-key': config.cle, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender:  { email: config.email, name: config.nom },
        // ⚠ REPLY-TO = L'ADRESSE D'EXPEDITION (decision de Thierry, 16 septembre
        // 2026). Le voyageur repond, l'hote recoit dans SA boite. L'ingestion de
        // ces reponses dans la messagerie HoteSmart est un chantier separe : tant
        // qu'il n'existe pas, un reply-to qui pointerait ailleurs ferait disparaitre
        // les reponses.
        replyTo: { email: config.email, name: config.nom },
        to:      [{ email: String(destinataire) }],
        subject: sujet,
        htmlContent: html
      })
    })
  } catch (e) {
    // ⚠ ISSUE INCERTAINE, ET ELLE NE SE REJOUE PAS AVEUGLEMENT.
    // Le `fetch` a leve : la coupure a pu survenir APRES que Brevo a accepte la
    // requete. On ne sait pas si le voyageur a recu le message. Un appelant qui
    // a un repli (la confirmation de reservation) doit s'abstenir plutot que de
    // risquer un DOUBLE envoi — c'est la meme regle que le POST CRS d'issue
    // incertaine du moteur : on ne rejoue pas ce dont on ignore s'il a abouti.
    // Les moteurs de templates, eux, ont `message_sent_log` pour trancher.
    return { ok: false, raison: `brevo_injoignable: ${e.message}`,
             permanent: false, incertain: true }
  }

  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    // 5xx et 429 : l'envoi peut reussir plus tard, on ne condamne pas le message.
    // 4xx : l'adresse ou l'expediteur est en cause, aucun essai n'y changera rien.
    // ⚠ 402 EST UN QUOTA, DONC TRANSITOIRE. Il etait classe permanent — et comme
    // l'appelant teste `permanent` AVANT `quota`, un hote a court de credits
    // voyait son message condamne DEFINITIVEMENT, alors qu'il recharge le
    // lendemain. Constat de review : deux lignes qui se contredisaient, dont une
    // seule etait lue.
    const quota = r.status === 429 || r.status === 402
    const transitoire = r.status >= 500 || quota
    if (quota) {
      // Un quota epuise coupe SMS ET e-mails. On le signale par un autre canal
      // que celui qui vient d'echouer — meme geste que lib/platform-notify.js.
      try {
        // ⚠ AVEC LE COMPTE CONCERNE, et c'est le premier appelant pour qui ca
        // change tout : les autres signalements de facturation portent sur des
        // cles PLATEFORME, celui-ci sur la cle d'UN hote. Sans contexte,
        // l'incident part avec `property_id: null`, et l'anti-spam de 24 h par
        // (type, bien) ferait taire le second hote a court de credits — son
        // quota epuise n'alerterait personne, et le libelle laisserait croire a
        // une panne generale. Constat de review.
        const { signalerSiPanneFacturation } = require('./incident-facturation')
        await signalerSiPanneFacturation('Brevo (e-mails voyageur)',
          { status: r.status, message: data.message || '' },
          { userId, propertyId, propertyName })
      } catch (e) { console.error('[email-guestflow] signalement facturation impossible', e.message) }
    }
    return {
      ok: false,
      raison: `brevo_${r.status}: ${String(data.message || data.code || '').slice(0, 200)}`,
      permanent: !transitoire,
      // ⚠ LE QUOTA NE COMPTE PAS DANS LE PLAFOND DE TENTATIVES, et c'est voulu.
      // Un forfait Brevo journalier epuise rend 429 toute la journee : avec un tick
      // toutes les 5 minutes, un plafond de 5 abandonnerait le message en 25
      // minutes, alors que le quota se retablit a minuit et que le sejour, lui,
      // dure encore. Le quota a deja son propre signalement (ci-dessus), qui ne
      // sonne qu'une fois.
      quota
    }
  }

  return { ok: true, id: data.messageId || null, expediteur: config.email }
}

// ─── Le plafond de tentatives ────────────────────────────────────────────────
// ⚠ COMPTE DANS `automation_incidents`, SANS NOUVELLE TABLE. Les migrations de ce
// depot se collent a la main dans l'editeur Supabase : en demander une pour un
// compteur retarderait tout le chantier sur un geste humain. On reutilise donc le
// journal d'incidents, avec une cle unique dans le `detail` — c'est exact (la cle
// porte deux identifiants), au prix d'un `ilike`. Le jour ou ce comptage devient
// chaud, il merite sa colonne.
const MAX_TENTATIVES_EMAIL = 5
const FENETRE_TENTATIVES_MS = 24 * 3600 * 1000
const TYPE_ECHEC_EMAIL = 'email_voyageur_echec'

const cleEchec = (bookingId, templateId) => `EMAILKEY:${bookingId}:${templateId}`

// Nombre d'echecs deja consignes pour CE message. Fail-safe : une lecture en
// echec rend 0 — on prefere une tentative de trop a un message abandonne par une
// panne de lecture.
async function compterEchecs (bookingId, templateId) {
  const depuis = new Date(Date.now() - FENETRE_TENTATIVES_MS).toISOString()
  try {
    const { data, error } = await supabase
      .from('automation_incidents')
      .select('id')
      .eq('type', TYPE_ECHEC_EMAIL)
      // ⚠ `detail->>message`, PAS `detail`. La colonne est du JSONB et
      // `reportIncident` y range une chaine sous la forme `{ message: "..." }`
      // (lib/founder-notify.js) : un ILIKE sur la colonne entiere fait lever
      // Postgres (`operator does not exist: jsonb ~~*`), l'erreur est avalee par
      // le fail-safe ci-dessous, le compte rend 0 — et LE PLAFOND N'EST JAMAIS
      // ATTEINT. Une ligne de plus toutes les 5 minutes, indefiniment, jusqu'a
      // reveiller la sonde `table_growth`. Constat de review ; rien ne
      // l'exercait, le test remplacait `ilike` par un passe-plat.
      .ilike('detail->>message', `%${cleEchec(bookingId, templateId)}%`)
      .gte('created_at', depuis)
      .limit(MAX_TENTATIVES_EMAIL + 1)
    if (error) {
      console.error('[email-guestflow] comptage des tentatives impossible', error.message)
      return 0
    }
    return (data || []).length
  } catch (e) {
    console.error('[email-guestflow] comptage des tentatives impossible', e.message)
    return 0
  }
}

// Consigne un echec transitoire. `threshold` tres haut : cette ligne SERT A
// COMPTER, elle ne doit reveiller personne — c'est l'abandon au plafond qui
// alerte, une fois, avec ce qu'il faut pour agir.
async function noterEchecEmail ({ userId, propertyId, propertyName, bookingId, templateId, raison }) {
  try {
    const { reportIncident } = require('./founder-notify')
    await reportIncident(TYPE_ECHEC_EMAIL, {
      userId, propertyId: propertyId != null ? String(propertyId) : null, propertyName,
      threshold: 9999,
      detail: `${cleEchec(bookingId, templateId)} — ${raison}`
    })
  } catch (e) { console.error('[email-guestflow] echec non consigne', e.message) }
}

module.exports = {
  envoyerEmailVoyageur,
  envoyerHtml,
  MAX_TENTATIVES_EMAIL,
  TYPE_ECHEC_EMAIL,
  cleEchec,
  compterEchecs,
  noterEchecEmail,
  sujetPour,
  SUJETS,
  configDuCompte,
  texteVersHtml,
  enveloppe,
  _viderCacheExpediteur
}
