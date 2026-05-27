// api/channel-token.js
// Genere un one-time token pour iframe en marque blanche
// La cle API du channel manager ne doit JAMAIS apparaitre cote front

export default async function handler(req, res) {
  // 1. Methode HTTP - POST uniquement
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Lecture des variables d'environnement
  const apiKey = process.env.CHANNEL_API_KEY;
  const baseUrl = process.env.CHANNEL_BASE_URL;
  const propertyId = process.env.CHANNEL_TEST_PROPERTY_ID;

  if (!apiKey || !baseUrl || !propertyId) {
    console.error('Channel config missing', {
      hasApiKey: !!apiKey,
      hasBaseUrl: !!baseUrl,
      hasPropertyId: !!propertyId
    });
    return res.status(500).json({ error: 'Configuration incomplete' });
  }

  // 3. Appel au channel manager pour generer un token ephemere
  try {
    const response = await fetch(`${baseUrl}/auth/one_time_token`, {
      method: 'POST',
      headers: {
        'user-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ property_id: propertyId })
    });

    if (!response.ok) {
      console.error('Channel auth failed', {
        status: response.status,
        statusText: response.statusText
      });
      return res.status(response.status).json({ error: 'Auth failed' });
    }

    const data = await response.json();
    const token = data?.data?.attributes?.token;

    if (!token) {
      console.error('No token in response', { dataShape: Object.keys(data || {}), fullData: JSON.stringify(data) });
      return res.status(500).json({ error: 'Invalid response' });
    }

    // 4. Renvoyer le token + property_id au front
    return res.status(200).json({
      token,
      property_id: propertyId
    });

  } catch (error) {
    console.error('Internal error in channel-token', error.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
