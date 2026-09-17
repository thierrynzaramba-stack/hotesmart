// scripts/inbound-webhook-brevo.js
// Chantier « inbound e-mail » — etape 2.
//
// DECLARE (ou relit) LE WEBHOOK INBOUND BREVO.
//
// USAGE
//   node scripts/inbound-webhook-brevo.js            # etat, lecture seule
//   node scripts/inbound-webhook-brevo.js --creer    # cree le webhook
//   node scripts/inbound-webhook-brevo.js --supprimer <id>
//
// ⚠ LA CLE PLATEFORME, PAS CELLE D'UN HOTE. `ALERT_BREVO_API_KEY`, jamais
// `api_keys.brevo_api_key`. Les deux pointent AUJOURD'HUI sur le meme compte
// Brevo — il n'y en a qu'un — mais ce sont deux ROLES distincts : la cle d'un
// hote est une donnee client, qui vit en base et qu'il peut changer ; celle de
// la plateforme est une variable d'environnement que nous maitrisons. Les
// confondre marcherait ce mois-ci et serait faux au deuxieme hote.
//
// ⚠ LE DOMAINE ET L'URL SONT DES CONSTANTES, jamais des arguments.
// Regle 11 : un destinataire sortant se CONSTRUIT cote serveur. Un domaine
// inbound passe en parametre, c'est la possibilite de detourner le courrier de
// nos voyageurs vers l'endpoint de quelqu'un d'autre.

require('dotenv').config({ path: '.env.local', quiet: true })

const CLE = process.env.ALERT_BREVO_API_KEY
const DOMAINE_INBOUND = 'reply.hotesmart.fr'
const URL_WEBHOOK = 'https://hotesmart.vercel.app/api/inbound-email'

const CREER = process.argv.includes('--creer')
const iSupp = process.argv.indexOf('--supprimer')
const A_SUPPRIMER = iSupp >= 0 ? process.argv[iSupp + 1] : null

async function brevo (methode, chemin, corps) {
  const r = await fetch('https://api.brevo.com/v3' + chemin, {
    method: methode,
    headers: { 'api-key': CLE, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

async function main () {
  if (!CLE) {
    console.error('ALERT_BREVO_API_KEY absente de .env.local.')
    console.error('')
    console.error('Elle est presente en production. Pour travailler ici, la copier')
    console.error('DANS le fichier .env.local (hors depot) — sans la coller dans un')
    console.error('terminal ni dans une conversation : une cle affichee est une cle')
    console.error('a faire tourner.')
    process.exit(1)
  }

  const compte = await brevo('GET', '/account')
  console.log('compte Brevo :', compte.json.companyName, '| org', compte.json.organization_id)

  const dom = await brevo('GET', '/senders/domains')
  const trouve = (dom.json.domains || []).find(d => d.domain_name === 'hotesmart.fr')
  console.log('hotesmart.fr :', trouve
    ? `authentifie=${trouve.authenticated} verifie=${trouve.verified}`
    : '⚠ ABSENT de ce compte')

  const w = await brevo('GET', '/webhooks?type=inbound')
  const liste = Array.isArray(w.json) ? w.json : (w.json.webhooks || [])
  console.log(`\nwebhooks inbound : ${w.status === 400 ? 'aucun' : liste.length}`)
  for (const x of liste) console.log(`  id=${x.id} ${x.url} domaine=${x.domain || '—'} events=${(x.events||[]).join(',')}`)

  if (A_SUPPRIMER) {
    const r = await brevo('DELETE', `/webhooks/${A_SUPPRIMER}`)
    console.log(`\nsuppression ${A_SUPPRIMER} : HTTP ${r.status}`)
    return
  }

  if (!CREER) {
    console.log('\nLecture seule. --creer pour declarer le webhook.')
    return
  }

  const deja = liste.find(x => x.url === URL_WEBHOOK)
  if (deja) { console.log(`\ndeja declare (id=${deja.id}) — rien a faire`); return }

  console.log(`\ncreation : ${URL_WEBHOOK}  <-  *@${DOMAINE_INBOUND}`)
  const r = await brevo('POST', '/webhooks', {
    type: 'inbound',
    url: URL_WEBHOOK,
    domain: DOMAINE_INBOUND,
    events: ['inboundEmailProcessed'],
    description: 'HoteSmart — reponses des voyageurs (resas directes)'
  })
  console.log(`HTTP ${r.status}`, JSON.stringify(r.json).slice(0, 300))
  if (r.status >= 400) process.exitCode = 1
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
