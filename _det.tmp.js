const { createClient } = require('@supabase/supabase-js')
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
;(async () => {
  const { data } = await sb.from('ota_reviews')
    .select('statut, ai_clean_excerpt, content, received_at, booking_uid, stay_start, raw')
    .eq('source','message').order('received_at')
  console.log('=== ' + data.length + ' detections ===\n')
  for (const d of data) {
    console.log('•', (d.received_at||'').slice(0,10), '| statut:', d.statut,
                '| gravite:', d.raw?.gravite || '-', '| sejour:', d.stay_start || 'non rattache')
    console.log('  EXTRAIT :', JSON.stringify(d.ai_clean_excerpt))
    console.log('  message :', JSON.stringify((d.content||'').replace(/\s+/g,' ').slice(0,120)))
    console.log('')
  }
  const { count: conf } = await sb.from('ota_reviews').select('id',{count:'exact',head:true}).eq('statut','confirme')
  const { count: det } = await sb.from('ota_reviews').select('id',{count:'exact',head:true}).eq('statut','detecte')
  console.log('total base : confirme', conf, '| detecte', det)
})()
