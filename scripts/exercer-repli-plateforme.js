// scripts/exercer-repli-plateforme.js
// Chantier « inbound e-mail » — etape 1.
//
// EXERCER LE CANAL PLATEFORME, QUI N'A JAMAIS SERVI.
//
// Deux mecanismes en dependent, et aucun des deux n'a ete eprouve :
//   - le REPLI de la confirmation de reservation (decide le 17 septembre) :
//     si la cle de l'hote echoue, on passe par la plateforme. Un voyageur qui
//     vient de payer en depend.
//   - les ALERTES FONDATEUR par e-mail, y compris celles que le chantier
//     precedent a ajoutees (`email_confirmation_repli`, `notif_hote_non_envoyee`).
//
// Le 17 septembre, le compte n'avait AUCUN expediteur verifie pour
// `alertes@hotesmart.fr` : les deux auraient rendu 400, en silence. Ce script
// verifie que ce n'est plus le cas — et il l'exerce pour de vrai, parce qu'une
// configuration lue n'est pas une configuration eprouvee.
//
// USAGE
//   node scripts/exercer-repli-plateforme.js              # verifie, n'envoie rien
//   node scripts/exercer-repli-plateforme.js --envoyer    # envoie un e-mail reel
//
// ⚠ IL ENVOIE A L'ADRESSE DU FONDATEUR (FOUNDER_EMAIL), jamais a un voyageur.

require('dotenv').config({ path: '.env.local', quiet: true })

const CLE = process.env.ALERT_BREVO_API_KEY
const EXPEDITEUR = process.env.ALERT_SENDER_EMAIL || 'alertes@hotesmart.fr'
const DESTINATAIRE = process.env.FOUNDER_EMAIL
const ENVOYER = process.argv.includes('--envoyer')

const masque = e => { const s = String(e || ''); const i = s.indexOf('@')
  return i < 1 ? '(vide)' : s.slice(0, 3) + '***@' + s.slice(i + 1) }

async function main () {
  console.log('=== CE QUE LE CODE UTILISERA ===')
  console.log(' ALERT_BREVO_API_KEY :', CLE ? `presente (${CLE.length} car)` : '⚠ ABSENTE')
  console.log(' expediteur          :', EXPEDITEUR)
  console.log(' destinataire (FOUNDER_EMAIL) :', DESTINATAIRE ? masque(DESTINATAIRE) : '⚠ ABSENT')

  if (!CLE) {
    console.error('\nSans la cle, rien a exercer. La copier DANS .env.local (hors depot).')
    process.exit(1)
  }

  const get = async p => {
    const r = await fetch('https://api.brevo.com/v3' + p, { headers: { 'api-key': CLE } })
    return { s: r.status, j: await r.json().catch(() => ({})) }
  }

  console.log('\n=== L\'EXPEDITEUR EST-IL VERIFIE ? ===')
  const s = await get('/senders')
  const senders = (s.j.senders || [])
  const direct = senders.some(x => String(x.email).toLowerCase() === EXPEDITEUR.toLowerCase())
  const dom = await get('/senders/domains')
  const domaineOk = (dom.j.domains || []).some(d =>
    d.authenticated && EXPEDITEUR.toLowerCase().endsWith('@' + String(d.domain_name).toLowerCase()))

  console.log(' sender declare nominativement :', direct ? 'OUI' : 'non')
  console.log(' domaine authentifie couvrant   :', domaineOk ? 'OUI' : 'non')
  if (!direct && !domaineOk) {
    console.error('\n⚠ NI L\'UN NI L\'AUTRE : Brevo refusera l\'envoi (400).')
    console.error('  C\'est exactement l\'etat du 17 septembre — le repli de la')
    console.error('  confirmation voyageur ne fonctionnerait pas, en silence.')
    process.exit(1)
  }

  if (!DESTINATAIRE) {
    console.error('\n⚠ FOUNDER_EMAIL absente : aucune alerte fondateur ne peut partir.')
    process.exit(1)
  }

  if (!ENVOYER) {
    console.log('\nConfiguration saine. --envoyer pour l\'exercer REELLEMENT.')
    return
  }

  // ⚠ ON PASSE PAR `sendPlatformEmail`, PAS PAR UN APPEL DIRECT A BREVO.
  // C'est cette fonction-la que le repli utilise : eprouver autre chose ne
  // prouverait rien d'elle. Meme lecon que le verificateur qui n'avait rien lu.
  const { sendPlatformEmail } = require('../lib/platform-notify')
  const quand = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const r = await sendPlatformEmail(DESTINATAIRE,
    `[HôteSmart] Canal plateforme — test du ${quand}`,
    `<h3>Le canal plateforme fonctionne</h3>`
    + `<p>Cet e-mail a été envoyé par <code>sendPlatformEmail</code>, la fonction sur laquelle `
    + `reposent deux mécanismes jamais exercés :</p><ul>`
    + `<li>le <strong>repli</strong> de la confirmation de réservation, quand la clé de l'hôte échoue ;</li>`
    + `<li>les <strong>alertes fondateur</strong> par e-mail.</li></ul>`
    + `<p>Le recevoir prouve que l'expéditeur <code>${EXPEDITEUR}</code> est accepté par Brevo.</p>`)

  console.log('\n=== RESULTAT ===')
  if (r.ok) {
    console.log(` ENVOYE (id ${r.id || '—'}) vers ${masque(DESTINATAIRE)}`)
    console.log(' Le repli de la confirmation voyageur a donc un socle reel.')
  } else {
    console.error(` ECHEC : ${r.error}`)
    console.error(' Le repli de la confirmation voyageur NE FONCTIONNE PAS.')
    process.exitCode = 1
  }
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
