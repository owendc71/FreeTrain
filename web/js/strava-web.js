'use strict';

/* ═══════════════════════════════════════════════════════════════════
   StravaManager – web version.
   OAuth via /api/strava-token serverless function (holds the secret);
   uploads TCX activities to Strava directly from the browser.
═══════════════════════════════════════════════════════════════════ */

class StravaManager {
  constructor(sb, userId) {
    this._sb     = sb;
    this._userId = userId;
    this._conn   = null;   // row from strava_connections
  }

  static isConfigured() {
    return !!(window.APP_CONFIG && window.APP_CONFIG.stravaClientId);
  }

  isConnected()   { return !!this._conn; }
  athleteName()   { return this._conn?.athlete_name || ''; }

  async init() {
    const { data } = await this._sb.from('strava_connections')
      .select('*').eq('user_id', this._userId).maybeSingle();
    this._conn = data || null;
    return this._conn;
  }

  // ── OAuth ─────────────────────────────────────────────────────────

  connect() {
    const clientId = window.APP_CONFIG.stravaClientId;
    const redirect = `${location.origin}/app`;
    location.href =
      'https://www.strava.com/oauth/authorize' +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      '&response_type=code' +
      '&approval_prompt=auto' +
      '&scope=read,activity:write';
  }

  // Handles ?code=... after Strava redirects back. Returns true if connected.
  // On failure, this.lastError holds a human-readable reason.
  async handleCallback() {
    const params = new URLSearchParams(location.search);
    const code   = params.get('code');
    if (params.get('error')) {
      history.replaceState({}, '', location.pathname);
      this.lastError = 'authorization was cancelled';
      return false;
    }
    if (!code) return false;

    // Clean the URL immediately so a reload doesn't reuse the code
    history.replaceState({}, '', location.pathname);

    let r;
    try {
      r = await fetch('/api/strava-token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code }),
      });
    } catch (e) {
      this.lastError = 'could not reach /api/strava-token — are you running the deployed site?';
      return false;
    }

    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      this.lastError = body.error === 'strava_not_configured'
        ? 'STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set in Vercel'
        : (body.error || `token exchange failed (HTTP ${r.status})`);
      console.error('Strava token exchange failed:', r.status, body);
      return false;
    }

    await this._saveTokens(body);
    return true;
  }

  async disconnect() {
    if (this._conn) {
      // Best-effort revoke on Strava's side
      try {
        await fetch(`https://www.strava.com/oauth/deauthorize?access_token=${this._conn.access_token}`,
          { method: 'POST' });
      } catch (_) {}
    }
    await this._sb.from('strava_connections').delete().eq('user_id', this._userId);
    this._conn = null;
  }

  async _saveTokens(tokens) {
    const athlete = tokens.athlete || {};
    const name    = `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim();
    const payload = {
      user_id:       this._userId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    tokens.expires_at,
    };
    if (athlete.id) payload.athlete_id = athlete.id;
    if (name)       payload.athlete_name = name;

    const { data } = await this._sb.from('strava_connections')
      .upsert(payload).select().single();
    this._conn = data || { ...this._conn, ...payload };
  }

  async _freshToken() {
    if (!this._conn) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this._conn.expires_at > now + 60) return this._conn.access_token;

    const r = await fetch('/api/strava-token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: this._conn.refresh_token }),
    });
    if (!r.ok) return null;
    await this._saveTokens(await r.json());
    return this._conn.access_token;
  }

  // ── Upload ────────────────────────────────────────────────────────

  // Returns the Strava activity id, or null on failure.
  async uploadRide(ride) {
    const token = await this._freshToken();
    if (!token) return null;

    const samples = ride.power_samples || [];
    if (samples.length < 30) return null;   // nothing meaningful to upload

    const startMs = Date.now() - (ride.elapsed || samples.length) * 1000;
    const name    = ride.workout_name || 'FreeTrain Workout';
    const tcx     = this._buildTCX(new Date(startMs), samples, name);

    const form = new FormData();
    form.append('file', new Blob([tcx], { type: 'application/xml' }), 'ride.tcx');
    form.append('data_type', 'tcx');
    form.append('name', name);
    form.append('trainer', '1');
    form.append('description', 'Recorded with FreeTrain');

    const up = await fetch('https://www.strava.com/api/v3/uploads', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
      body:    form,
    });
    if (!up.ok) return null;
    const { id: uploadId } = await up.json();

    // Poll until Strava finishes processing
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await fetch(`https://www.strava.com/api/v3/uploads/${uploadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!s.ok) return null;
      const body = await s.json();
      if (body.activity_id) return body.activity_id;
      if (body.error)       return null;
    }
    return null;
  }

  _buildTCX(start, samples, name) {
    const ts = sec => new Date(start.getTime() + sec * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');

    const points = samples.map((w, i) =>
      `<Trackpoint><Time>${ts(i)}</Time>` +
      `<Extensions><ns3:TPX><ns3:Watts>${Math.max(0, Math.round(w))}</ns3:Watts></ns3:TPX></Extensions>` +
      `</Trackpoint>`
    ).join('');

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return '<?xml version="1.0" encoding="UTF-8"?>' +
      '<TrainingCenterDatabase' +
      ' xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"' +
      ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">' +
      '<Activities><Activity Sport="Biking">' +
      `<Id>${ts(0)}</Id>` +
      `<Lap StartTime="${ts(0)}">` +
      `<TotalTimeSeconds>${samples.length}</TotalTimeSeconds>` +
      '<DistanceMeters>0</DistanceMeters>' +
      '<Calories>0</Calories>' +
      '<Intensity>Active</Intensity>' +
      '<TriggerMethod>Manual</TriggerMethod>' +
      `<Track>${points}</Track>` +
      '</Lap>' +
      `<Notes>${esc(name)}</Notes>` +
      '</Activity></Activities>' +
      '</TrainingCenterDatabase>';
  }
}

window.StravaManager = StravaManager;
