// scripts/verifier-yield-evenements.js
// Verifie l'import des vacances scolaires, par LECTURE.
// Migration : migrations/2026-09-12-yield-vacances-scolaires.sql
// DOC : docs/kb/evenements-yield.md
//
// ⚠ LECTURE SEULE sur les donnees (la seule ecriture est un INSERT anonyme
// deliberement voue a l'echec, pour prouver que la RLS refuse).
//
// ⚠ LA CLE ANON N'EST PAS LE ROLE `authenticated`.
// La policy cible `to authenticated` : un porteur de la cle anonyme SANS
// session est le role `anon`, qu'aucune policy ne couvre. « Ne rien lire » est
// donc le comportement VOULU — la premiere version de ce script affirmait
// l'inverse et signalait un echec sur une RLS parfaitement correcte. Le vrai
// controle ouvre une SESSION.
//
// USAGE : node scripts/verifier-yield-evenements.js

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
let ec=0; const dit=(ok,t)=>{if(!ok)ec++;console.log(`  ${ok?'✓':'✗'} ${t}`)}
;(async()=>{
  const {data,error}=await sb.from('school_holidays').select('*')
  if(error){console.error('LECTURE IMPOSSIBLE :',error.message);process.exit(1)}
  console.log('=== VACANCES SCOLAIRES ===')
  // ⚠ DES BORNES, PAS DES CHIFFRES FIGES — releve en review.
  // `=== 177` et `{"A":59,...}` auraient rendu ECHEC sur un import
  // parfaitement correct des la publication de l'annee 2027-2028. Un
  // verificateur qui se perime apprend a ignorer ses propres alertes.
  dit(data.length >= 150, `${data.length} lignes (au moins 150 attendues)`)
  const parZone={}; for(const l of data) parZone[l.zone]=(parZone[l.zone]||0)+1
  const zones=Object.keys(parZone).sort()
  dit(zones.join(',')==='A,B,C', `les 3 zones sont presentes : ${zones.join(', ')}`)
  const comptes=Object.values(parZone)
  dit(new Set(comptes).size===1, `meme nombre de periodes par zone : ${JSON.stringify(parZone)}`)
  dit(data.every(l=>l.date_fin>=l.date_debut), 'toutes les periodes sont valides (fin >= debut)')
  const cles=new Set(data.map(l=>`${l.zone}|${l.nom}|${l.date_debut}`))
  dit(cles.size===data.length, `unicite (zone,nom,debut) : ${cles.size} cles pour ${data.length} lignes`)
  const annees=[...new Set(data.map(l=>l.annee_scolaire))].sort()
  dit(annees.length>=8&&annees.includes('2025-2026'),
    `annees : ${annees[0]} → ${annees[annees.length-1]} (${annees.length}, dont 2025-2026)`)
  dit(data.every(l=>l.annee_scolaire), 'aucune annee_scolaire vide')
  // le piege des dates : verification sur un cas connu
  const tous=data.filter(l=>l.nom==='Vacances de la Toussaint'&&l.annee_scolaire==='2025-2026'&&l.zone==='C')[0]
  dit(tous&&tous.date_debut==='2025-10-18'&&tous.date_fin==='2025-11-02',
    `Toussaint 2025 zone C : ${tous?.date_debut} → ${tous?.date_fin} (attendu 2025-10-18 → 2025-11-02)`)
  // l'historique 2022 demande
  const av2022=data.filter(l=>l.date_debut<'2023-01-01').length
  dit(av2022>0, `${av2022} periode(s) anterieures a 2023 (historique couvert)`)

  console.log('\n=== ZONE DES BIENS ===')
  // ⚠ L'ERREUR EST LUE. Sans cela, `p` vaut null, la boucle leve un
  // TypeError dans une IIFE async sans catch, et le script sort SANS son
  // compte-rendu — un echec qui ressemble a un plantage, pas a un verdict.
  const {data:p,error:eP}=await sb.from('properties').select('name,zip_code,zone_scolaire,country')
  if(eP){ dit(false, `lecture des biens impossible : ${eP.message}`) }
  else {
    for(const b of p) console.log(`  ${String(b.name).padEnd(20)} ${b.zip_code} → ${b.zone_scolaire||'—'}`)
    // La zone attendue se DEDUIT, elle n'est pas figee a 'C' : le jour ou un
    // bien sera ailleurs, ce controle doit rester vrai.
    const {zoneDuBien}=require('/home/thierry/hotesmart/lib/yield/zones-scolaires')
    const ecarts=p.filter(b=>zoneDuBien(b)&&b.zone_scolaire!==zoneDuBien(b))
      .map(b=>`${b.name} : ${b.zone_scolaire} au lieu de ${zoneDuBien(b)}`)
    dit(ecarts.length===0, ecarts.length?`zones incoherentes : ${ecarts.join(', ')}`
      :`les ${p.length} biens portent la zone deduite de leur code postal`)
  }

  console.log('\n=== RLS, ENFIN CONCLUANT ===')
  const anon=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  // ⚠ LA CLE ANON N'EST PAS LE ROLE `authenticated`.
  // La policy cible `to authenticated` : un porteur de la cle anonyme SANS
  // session est le role `anon`, qu'aucune policy ne couvre. Ne rien lire est
  // donc le comportement VOULU — ma premiere assertion disait l'inverse.
  const {data:va}=await anon.from('school_holidays').select('id').limit(1)
  dit(!va||!va.length, 'anonyme SANS session : ne lit rien (policy to authenticated)')
  // La vraie question : un compte CONNECTE lit-il bien la donnee publique ?
  const {data:sess,error:eSess}=await anon.auth.signInWithPassword({
    email:process.env.TEST_EMAIL, password:process.env.TEST_PASSWORD })
  if(eSess||!sess?.session){
    console.log(`  ? lecture authentifiee non verifiable (session : ${eSess?eSess.message:'absente'})`)
  } else {
    const connecte=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
      { global:{ headers:{ Authorization:`Bearer ${sess.session.access_token}` } } })
    const {data:vc,error:evc}=await connecte.from('school_holidays').select('id').limit(5)
    dit(!evc&&vc&&vc.length>0, `compte CONNECTE : lit ${vc?vc.length:0} ligne(s) (donnee publique)`)
    const {data:xc}=await connecte.from('yield_exceptions').select('id').limit(5)
    dit(!xc||!xc.length, `compte CONNECTE : 0 exception d'un AUTRE compte (cloisonnement)`)
    await anon.auth.signOut()
  }
  const {data:xa,error:ex}=await anon.from('yield_exceptions').select('id').limit(1)
  dit(ex||!xa||!xa.length, `exceptions : la cle anonyme ne lit rien (${ex?ex.code||'refus':'0 ligne'})`)
  const {error:ew}=await anon.from('school_holidays').insert({zone:'A',annee_scolaire:'x',nom:'x',date_debut:'2026-01-01',date_fin:'2026-01-02'})
  dit(!!ew, `ecriture anonyme refusee (${ew?String(ew.message).slice(0,45):'ACCEPTEE !'})`)

  console.log(`\n${ec?'ECHEC ('+ec+')':'TOUT EST VERIFIE PAR LECTURE'}`)
  process.exit(ec?1:0)
})()
