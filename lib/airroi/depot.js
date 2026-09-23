// lib/airroi/depot.js — OU LE CLIENT AIRROI RANGE SES REPONSES ET SES DEPENSES.
//
// Deux depots, une seule interface :
//   - `depotSupabase` : la production (tables airroi_cache, airroi_appels,
//     migration 2026-09-24-marche-airroi.sql). Cle service, serveur seulement.
//   - `depotFichier`  : scripts et verifications locales (un dossier). Il
//     existe pour que le cache fonctionne DES LE PREMIER APPEL, meme avant que
//     la migration soit collee : relancer un script ne repaie pas.
//
// ⚠ LA REPONSE EST GARDEE EN TEXTE BRUT : un jsonb relu par le client
// JavaScript arrondirait les identifiants d'annonce (lib/airroi/json.js).
// ⚠ AUCUNE CLE N'EST JAMAIS RANGEE ICI : ni dans la cle de cache (endpoint +
// parametres metier), ni dans le journal.

const fs = require('fs')
const path = require('path')

function depotSupabase (supabase) {
  if (!supabase) throw new Error('[airroi] depot : client supabase requis')
  return {
    async lireCache (cle) {
      const { data, error } = await supabase.from('airroi_cache')
        .select('cle, endpoint, reponse, recupere_le, cout_usd').eq('cle', cle).maybeSingle()
      if (error) throw new Error(`[airroi] lecture du cache : ${error.message}`)
      return data || null
    },
    async ecrireCache ({ cle, endpoint, parametres, reponse, cout, recupereLe }) {
      const { error } = await supabase.from('airroi_cache').upsert({
        cle, endpoint, parametres, reponse, cout_usd: cout, recupere_le: recupereLe
      }, { onConflict: 'cle' })
      if (error) throw new Error(`[airroi] ecriture du cache : ${error.message}`)
    },
    async journaliser (ligne) {
      const { error } = await supabase.from('airroi_appels').insert({
        endpoint: ligne.endpoint, cle: ligne.cle, cout_usd: ligne.cout,
        user_id: ligne.userId || null, property_id: ligne.propertyId || null,
        statut: ligne.statut, http: ligne.http ?? null, created_at: ligne.le
      })
      if (error) throw new Error(`[airroi] journal des appels : ${error.message}`)
    },
    // Les appels payants depuis une date, filtres par compte ou par bien.
    async appelsDepuis ({ depuis, userId = null, propertyId = null }) {
      const out = []
      for (let from = 0; ; from += 1000) {
        let q = supabase.from('airroi_appels').select('cout_usd, created_at, endpoint')
          .gte('created_at', depuis).order('created_at').range(from, from + 999)
        if (userId) q = q.eq('user_id', userId)
        if (propertyId) q = q.eq('property_id', propertyId)
        const { data, error } = await q
        if (error) throw new Error(`[airroi] lecture du journal : ${error.message}`)
        out.push(...(data || []))
        if (!data || data.length < 1000) break
      }
      return out
    }
  }
}

function depotFichier (dossier) {
  fs.mkdirSync(dossier, { recursive: true })
  const nom = cle => path.join(dossier, `${require('crypto').createHash('sha256').update(cle).digest('hex').slice(0, 32)}.json`)
  const journal = path.join(dossier, 'appels.jsonl')
  const lignes = () => fs.existsSync(journal)
    ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return {
    async lireCache (cle) {
      const f = nom(cle)
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
    },
    async ecrireCache ({ cle, endpoint, parametres, reponse, cout, recupereLe }) {
      fs.writeFileSync(nom(cle), JSON.stringify({ cle, endpoint, parametres, reponse, cout_usd: cout, recupere_le: recupereLe }))
    },
    async journaliser (ligne) {
      fs.appendFileSync(journal, JSON.stringify({
        endpoint: ligne.endpoint, cle: ligne.cle, cout_usd: ligne.cout, user_id: ligne.userId || null,
        property_id: ligne.propertyId || null, statut: ligne.statut, http: ligne.http ?? null, created_at: ligne.le
      }) + '\n')
    },
    async appelsDepuis ({ depuis, userId = null, propertyId = null }) {
      return lignes().filter(l => l.created_at >= depuis &&
        (!userId || l.user_id === userId) && (!propertyId || l.property_id === propertyId))
    }
  }
}

module.exports = { depotSupabase, depotFichier }
