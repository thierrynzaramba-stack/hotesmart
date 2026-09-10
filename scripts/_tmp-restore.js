require('dotenv').config({ path: '.env.local', quiet: true })
const BASE = process.env.CHANNEL_BASE_URL, KEY = process.env.CHANNEL_API_KEY
const CH = '224cbb66-0e3f-4f4d-9a27-3071629ab27c'
const BASE_RP = '5d35913a-3b86-4bb7-bcd1-7c9da2eb51a2'
const DER = '6b34530e-4e2c-4232-91ba-174040d44a2b'
const LISTING = '992723390568420450'
const dodo = (ms) => new Promise(r => setTimeout(r, ms))
async function appel (m, p, b, essais = 4) {
  for (let i = 1; i <= essais; i++) {
    try {
      const r = await fetch(`${BASE}${p}`, { method:m, headers:{'user-api-key':KEY,'Content-Type':'application/json'}, ...(b?{body:JSON.stringify(b)}:{}) })
      const t = await r.text(); let j=null; try{j=JSON.parse(t)}catch{}
      return { ok:r.ok, status:r.status, json:j, texte:t }
    } catch (e) {
      console.log(`   reseau KO (essai ${i}/${essais}) : ${e.cause?.code || e.message}`)
      if (i === essais) throw e
      await dodo(3000 * i)
    }
  }
}
;(async () => {
  const g = await appel('GET', `/channels/${CH}`)
  const rps = ((g.json?.data?.attributes?.rate_plans)||[])
  console.log(`etat : ${rps.length} mapping(s) -> ${rps.map(x=>x.rate_plan_id).join(', ') || 'AUCUN'}`)
  if (rps.length) return console.log('deja mappe, rien a faire')

  // ⚠ ON TENTE LE DERIVE D'ABORD : si le 500 precedent etait transitoire, on
  // obtient l'etat VOULU au lieu de restaurer un etat defectueux.
  console.log('\n1) le derive (l etat voulu)')
  let r = await appel('POST', `/channels/${CH}/mappings`, { mapping: {
    rate_plan_id: DER, settings: { listing_id: LISTING, primary_occ: true } } })
  console.log(`   HTTP ${r.status}  ${r.texte.slice(0,200)}`)
  if (!r.ok) {
    console.log('\n2) a defaut, la BASE : une annonce non mappee sur un canal actif est un etat casse')
    r = await appel('POST', `/channels/${CH}/mappings`, { mapping: {
      rate_plan_id: BASE_RP, settings: { listing_id: LISTING, primary_occ: true } } })
    console.log(`   HTTP ${r.status}  ${r.texte.slice(0,200)}`)
  }
  await dodo(6000)
  const g2 = await appel('GET', `/channels/${CH}`)
  const f = ((g2.json?.data?.attributes?.rate_plans)||[])
  console.log(`\nETAT FINAL : ${f.length} mapping(s)`)
  for (const x of f) console.log(`   ${x.rate_plan_id}${x.rate_plan_id===DER?'  <- DERIVE ✓':'  <- base'}`)
  if (!f.length) console.log('   ⚠⚠ TOUJOURS NON MAPPE — a traiter a la main')
})()
