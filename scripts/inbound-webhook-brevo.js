// scripts/inbound-webhook-brevo.js
// Chantier « inbound e-mail » — etape 2.
//
// DECLARE (ou relit) LE WEBHOOK INBOUND BREVO.
//
// USAGE
//   node scripts/inbound-webhook-brevo.js               # etat, lecture seule
//   node scripts/inbound-webhook-brevo.js --declarer    # declare le sous-domaine
//   node scripts/inbound-webhook-brevo.js --creer       # cree le webhook
//   node scripts/inbound-webhook-brevo.js --supprimer <id>
//
// ⚠ TROIS TEMPS, ET LES DEUX PREMIERS NE SUFFISENT PAS.
// Poser les MX ne suffit pas : Brevo veut que le SOUS-DOMAINE soit declare dans
// le compte (`POST /senders/domains`) ET AUTHENTIFIE par ses propres
// enregistrements DNS. Tant qu'il ne l'est pas, la creation du webhook rend
// « Domain is not found or is inactive » — un message qui ne dit ni lequel des
// deux manque, ni ou regarder. Mesure du 18 septembre 2026 : MX propages sur
// trois resolveurs publics, domaine declare, webhook refuse quand meme.
//
// `reply.hotesmart.fr` est pour Brevo un domaine A PART ENTIERE : authentifier
// `hotesmart.fr` ne l'authentifie pas.
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
const DECLARER = process.argv.includes('--declarer')
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

  // ─── Le sous-domaine inbound, et son authentification ──────────────────────
  const dInbound = (dom.json.domains || []).find(d => d.domain_name === DOMAINE_INBOUND)
  console.log(`${DOMAINE_INBOUND} :`, dInbound
    ? `declare, authentifie=${dInbound.authenticated} verifie=${dInbound.verified}`
    : 'NON DECLARE dans ce compte')

  if (DECLARER) {
    if (dInbound) {
      console.log('\ndeja declare — rien a faire')
    } else {
      const r = await brevo('POST', '/senders/domains', { name: DOMAINE_INBOUND })
      console.log(`\ndeclaration : HTTP ${r.status}`)
      if (r.status >= 400) { console.log(JSON.stringify(r.json).slice(0, 300)); process.exitCode = 1; return }
    }
    // Les enregistrements a poser, tels que Brevo les demande. On les REDEMANDE
    // plutot que de les recopier : ils sont propres au domaine, et une valeur
    // recopiee de memoire est une valeur qui finira par etre fausse.
    const detail = await brevo('GET', `/senders/domains/${DOMAINE_INBOUND}`)
    const dns = detail.json?.dns_records || detail.json
    console.log('\nA POSER CHEZ LE REGISTRAR :')
    for (const [nom, e] of Object.entries(dns || {})) {
      if (!e || !e.type) continue
      const ok = e.status === true ? '✓ deja en place' : '— a poser'
      console.log(`  ${String(e.type).padEnd(6)} ${String(e.host_name).padEnd(26)} ${e.value}   ${ok}`)
    }
    // ⚠ BREVO NE VALIDE PAS TOUT SEUL — en tout cas pas tout de suite.
    // Les trois enregistrements etaient en place et resolus par trois resolveurs
    // publics, et le domaine restait `authenticated: false` : la creation du
    // webhook echouait encore. C'est `PUT /senders/domains/<d>/authenticate` qui
    // declenche la verification, et elle a repondu dans la seconde.
    // Sans cet appel, on attend un cycle qu'on ne maitrise pas en croyant que le
    // DNS n'a pas propage.
    if (!dInbound || !dInbound.authenticated) {
      console.log('\nDeclenchement de la verification chez Brevo...')
      const v = await brevo('PUT', `/senders/domains/${DOMAINE_INBOUND}/authenticate`)
      console.log(`  HTTP ${v.status} ${String(v.json.message || JSON.stringify(v.json)).slice(0, 120)}`)
      if (v.status < 400) console.log('  Relancer --creer.')
      else console.log('  Les enregistrements ci-dessus ne sont pas encore vus : reessayer plus tard.')
    }
    return
  }

  if (A_SUPPRIMER) {
    const r = await brevo('DELETE', `/webhooks/${A_SUPPRIMER}`)
    console.log(`\nsuppression ${A_SUPPRIMER} : HTTP ${r.status}`)
    return
  }

  if (!CREER) {
    console.log('\nLecture seule. --creer pour declarer le webhook.')
    return
  }

  if (!dInbound || !dInbound.authenticated) {
    console.log('\n⚠ Le sous-domaine n\'est pas authentifie : Brevo refusera le webhook')
    console.log('  (« Domain is not found or is inactive »). Lancer --declarer pour voir')
    console.log('  les enregistrements DNS attendus.')
    process.exitCode = 1
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
