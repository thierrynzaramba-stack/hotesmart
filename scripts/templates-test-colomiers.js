// scripts/templates-test-colomiers.js
// Etape 6 du chantier « canal e-mail pour les reservations directes ».
//
// LES TEMPLATES DE TEST SUR COLOMIERS.
//
// Colomiers n'en a AUCUN : sans template, aucun message de parcours ne peut
// partir, quel que soit le canal — le test de bout en bout serait vide et on
// conclurait a tort que le canal e-mail ne marche pas.
//
// HORS CRON. Idempotent : ne cree que ce qui manque.
//
// USAGE
//   node scripts/templates-test-colomiers.js [--execute] [--supprimer]
//     par defaut : DRY RUN
//     --supprimer : retire les templates poses par ce script (repli propre)
//
// ⚠ LE SCRIPT REFUSE DE POSER CES TEMPLATES SI LE BIEN N'EST PAS EN MODE TEST.
// La premiere version se contentait d'AFFICHER le mode en affirmant « aucun envoi
// immediat, c'est verifie plus bas » — il ne l'etait pas. En mode `auto`, le
// template `arrival` (offset -1) devient immediatement eligible pour tout sejour
// EN COURS, par le rattrapage de `checkAndSendTemplate` : un voyageur deja sur
// place recevrait « votre sejour commence demain ». Constat de review.
// `--force-auto` leve le refus, pour qui sait ce qu'il fait.
//
// ⚠ AUCUN ENVOI IMMEDIAT, et c'est desormais verifie pour de bon.
//   - `booking_confirmed` part sur l'EVENEMENT `new` : les reservations deja en
//     base ont leur evenement consomme, seule une NOUVELLE reservation le
//     declenchera. C'est exactement le test voulu.
//   - `arrival` est rejoue par le cron, mais sa date cible est future pour les
//     deux reservations Offline en cours (20 et 22 septembre).
//   - Et Colomiers est en MODE TEST : meme eligible, un message y devient une
//     tache a valider, jamais un envoi. C'est la ceinture.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')
const SUPPRIMER = process.argv.includes('--supprimer')
const FORCE_AUTO = process.argv.includes('--force-auto')

// ⚠ LA MARQUE QUI DIT « CE TEMPLATE VIENT DU SCRIPT ». Sans elle, `--supprimer`
// se fiait au seul `event_type` et emportait donc un template que l'hote aurait
// pose lui-meme — d'autant plus surement que la creation, elle, SAUTE l'existant :
// on ne l'avait pas cree, et on le detruisait. Constat de review.
const MARQUE = '[[test-canal-email]]'

const COMPTE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const COLOMIERS = '0544fd9a-6579-44e7-b75e-19c63a2019ba'

// ⚠ TEXTES SANS PLACEHOLDER EXOTIQUE. `generateAutoMessage` rend `null` — donc
// n'envoie RIEN — quand un placeholder n'a pas de valeur dans la connaissance du
// bien, et alerte le fondateur. Colomiers n'a qu'un `telephone_hote` : on s'en
// tient a `{prenom}` et `{arrivee}`, qui viennent de la reservation elle-meme.
const TEMPLATES = [
  {
    event_type: 'booking_confirmed', reference: 'booking',
    offset_days: 0, offset_value: '5min', send_time: '10:00',
    template_text: 'Bonjour {prenom},\n\nNous avons bien reçu votre réservation pour le '
      + '{arrivee} et nous sommes ravis de vous accueillir à Colomiers.\n\n'
      + 'Vous recevrez les informations pratiques quelques jours avant votre arrivée.\n\n'
      + 'À très bientôt !'
  },
  {
    event_type: 'arrival', reference: 'arrival',
    offset_days: -1, offset_value: '', send_time: '11:00',
    template_text: 'Bonjour {prenom},\n\nVotre séjour à Colomiers commence demain.\n\n'
      + 'Nous vous souhaitons un excellent voyage, et restons joignables si besoin.\n\n'
      + 'À demain !'
  }
]

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

async function main () {
  log(SUPPRIMER ? 'MODE SUPPRESSION' : (EXECUTE ? 'MODE ECRITURE' : 'DRY RUN'))
  console.log('')

  const { data: bien, error: eb } = await supabase.from('properties')
    .select('id, name, user_id, automation_paused')
    .eq('provider_property_id', COLOMIERS).eq('user_id', COMPTE).maybeSingle()
  if (eb) throw new Error(`lecture bien : ${eb.message}`)
  if (!bien) throw new Error('Colomiers introuvable sur ce compte')
  log(`bien : ${bien.name} (kill switch ${bien.automation_paused ? 'ACTIF' : 'inactif'})`)

  const { data: cfg } = await supabase.from('agent_alert_config')
    .select('config').eq('user_id', COMPTE).maybeSingle()
  const mode = cfg?.config?.[COLOMIERS]?.mode || 'test'
  log(`mode : ${mode}${mode === 'test' ? ' — un message devient une tache a valider, jamais un envoi' : ''}`)
  if (!SUPPRIMER && mode !== 'test' && !FORCE_AUTO) {
    log('')
    log(`⚠ Le bien est en mode « ${mode} », pas « test ».`)
    log('  Le template `arrival` (offset -1) deviendrait immediatement eligible pour')
    log('  tout sejour EN COURS : un voyageur deja sur place recevrait « votre sejour')
    log('  commence demain ». ARRET. Ajouter --force-auto en connaissance de cause.')
    process.exit(1)
  }
  console.log('')

  const { data: existants, error: ee } = await supabase.from('message_templates')
    .select('id, event_type, active, template_text').eq('user_id', COMPTE).eq('property_id', COLOMIERS)
  if (ee) throw new Error(`lecture templates : ${ee.message}`)

  if (SUPPRIMER) {
    // On ne retire QUE ce qu'on a pose : la marque, pas le type d'evenement.
    const aRetirer = (existants || []).filter(x => String(x.template_text || '').includes(MARQUE))
    const gardes = (existants || []).filter(x => !String(x.template_text || '').includes(MARQUE))
    if (gardes.length) {
      log(`${gardes.length} template(s) de l'hote conserve(s) : ${gardes.map(x => x.event_type).join(', ')}`)
    }
    log(`${aRetirer.length} template(s) a retirer`)
    for (const x of aRetirer) {
      console.log(`  ${x.id} ${x.event_type}`)
      if (EXECUTE) {
        const { error } = await supabase.from('message_templates').delete().eq('id', x.id)
        log(error ? `⚠ ${error.message}` : `  supprime`)
      }
    }
    if (!EXECUTE) log('\nDRY RUN — ajouter --execute pour supprimer.')
    return
  }

  for (const m of TEMPLATES) {
    const deja = (existants || []).find(x => x.event_type === m.event_type)
    if (deja) { log(`— ${m.event_type} existe deja (${deja.id}) — inchange`); continue }

    console.log(`  ${m.event_type} (ref=${m.reference}, offset=${m.offset_days}, ${m.send_time})`)
    console.log(m.template_text.split('\n').map(l => '      ' + l).join('\n'))
    console.log('')

    if (!EXECUTE) continue
    const { data, error } = await supabase.from('message_templates').insert({
      user_id: COMPTE, property_id: COLOMIERS, active: true,
      send_anyway: false, require_ready_status: false, earliest_send_time: null, ...m,
      // ⚠ LA MARQUE VIT DANS LE TEXTE, donc elle PARTIRA au voyageur. C'est
      // assume : ces templates sont des templates de TEST, sur un bien en mode
      // test, et savoir lesquels retirer vaut mieux qu'un pied de message propre.
      // Le jour ou ils deviendraient definitifs, on retire la marque a la main.
      template_text: `${m.template_text}\n\n${MARQUE}`
    }).select('id').maybeSingle()
    if (error) { log(`⚠ creation refusee : ${error.message}`); continue }
    log(`  cree : ${data.id}`)
  }

  if (!EXECUTE) {
    console.log('')
    log('DRY RUN termine. Relancer avec --execute pour creer.')
    return
  }

  // Le controle d'apres, qui doit pouvoir echouer.
  const { data: apres, error: ea } = await supabase.from('message_templates')
    .select('id, event_type, active').eq('user_id', COMPTE).eq('property_id', COLOMIERS)
  if (ea) { log(`⚠ controle impossible : ${ea.message}`); process.exitCode = 1; return }
  console.log('')
  log(`controle : ${(apres || []).length} template(s) sur Colomiers`)
  for (const x of apres || []) console.log(`  ${x.id} ${x.event_type} actif=${x.active}`)
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
