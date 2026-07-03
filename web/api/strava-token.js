// Vercel serverless function: exchanges Strava OAuth codes / refresh tokens.
// Keeps STRAVA_CLIENT_SECRET server-side — never expose it to the browser.
// Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in Vercel → Settings → Environment Variables.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'strava_not_configured' });
  }

  const { code, refresh_token } = req.body || {};
  const params = { client_id: clientId, client_secret: clientSecret };

  if (code) {
    params.code       = code;
    params.grant_type = 'authorization_code';
  } else if (refresh_token) {
    params.refresh_token = refresh_token;
    params.grant_type    = 'refresh_token';
  } else {
    return res.status(400).json({ error: 'missing_code_or_refresh_token' });
  }

  const r = await fetch('https://www.strava.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  });
  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({ error: data.message || 'token_exchange_failed' });
  }

  // Return only what the client needs
  res.status(200).json({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    data.expires_at,
    athlete: data.athlete
      ? { id: data.athlete.id, firstname: data.athlete.firstname, lastname: data.athlete.lastname }
      : null,
  });
}
