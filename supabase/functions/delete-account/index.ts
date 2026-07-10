// Edge Function: delete-account
// Supprime le compte de l'utilisateur authentifie apres verification
// du mot de passe actuel.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // 1. Recuperer le JWT de l'utilisateur depuis le header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Authorization manquante' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userJwt = authHeader.replace('Bearer ', '')

    // 2. Recuperer le password de confirmation depuis le body
    const body = await req.json().catch(() => ({}))
    const { password } = body
    if (!password || typeof password !== 'string') {
      return new Response(JSON.stringify({ error: 'Mot de passe requis' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3. Client public pour identifier l'utilisateur via son JWT
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Session invalide' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const user = userData.user
    const userEmail = user.email
    const userId = user.id

    if (!userEmail) {
      return new Response(JSON.stringify({ error: 'Email manquant sur le compte' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 4. Verifier le mot de passe en tentant un re-signin
    const { error: signErr } = await userClient.auth.signInWithPassword({
      email: userEmail,
      password,
    })
    if (signErr) {
      return new Response(JSON.stringify({ error: 'Mot de passe incorrect' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 5. Client admin (service_role) pour supprimer
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // 6. Purge des tables a user_id SANS FK vers auth.users : le ON DELETE CASCADE
    //    des FK ne les couvre pas, elles resteraient orphelines.
    //    Liste = resultat de la requete SQL "user_id sans FK" (dashboard) = ['messages'].
    //    Purge NON BLOQUANTE : une table absente / sans colonne user_id est loggee
    //    et ignoree, la suppression du compte se poursuit.
    const ORPHAN_TABLES = ['messages']
    for (const table of ORPHAN_TABLES) {
      const { error: purgeErr } = await adminClient.from(table).delete().eq('user_id', userId)
      if (purgeErr) {
        console.error(`[delete-account] purge ${table} echec: ${purgeErr.message}`)
      }
    }

    // 7. Supprimer l'utilisateur (les FK ON DELETE CASCADE purgent le reste)
    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(userId)
    if (deleteErr) {
      return new Response(JSON.stringify({ error: deleteErr.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
