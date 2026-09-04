'use strict';

/* ═══════════════════════════════════════════════════════════════════
   Strength tab – career strength stats and the recent sessions list.
   Sessions are recorded at session level (duration + focus + RPE)
   rather than per-exercise sets/reps, mirroring the schema in
   migrations/007_swim_strength.sql. Plan creation happens via the
   coach chat on the Plan tab.
═══════════════════════════════════════════════════════════════════ */

function fmtStrengthTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtStrengthDate(date) {
  if (!date) return '—';
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

const STRENGTH_FOCUS_LABELS = {
  upper: 'Upper Body',
  lower: 'Lower Body',
  full:  'Full Body',
  core:  'Core & Stability',
};

/* ═══════════════════════════════════════════════════════════════════
   Strength tab renderer
═══════════════════════════════════════════════════════════════════ */

class StrengthTab {
  constructor() {
    this._sessions = [];
  }

  update({ sessions } = {}) {
    if (sessions != null) this._sessions = sessions;
    this._renderSummary();
    this._renderList();
  }

  // newest first, without mutating the caller's array
  _sorted() {
    return this._sessions.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }

  // Average RPE over ONLY the sessions that recorded one. Returns '—'
  // when nobody logged an effort, so users never see NaN.
  _avgRpe() {
    const rated = this._sessions.filter(s => s.perceived_effort);
    if (!rated.length) return '—';
    const sum = rated.reduce((t, s) => t + (Number(s.perceived_effort) || 0), 0);
    return (sum / rated.length).toFixed(1);
  }

  _renderSummary() {
    const el = document.getElementById('strength-summary');
    if (!el) return;
    if (!this._sessions.length) { el.style.display = 'none'; return; }

    const totalTime = this._sessions.reduce((t, s) => t + (Number(s.elapsed) || 0), 0);

    const nSessions = document.getElementById('sts-sessions');
    const nTime     = document.getElementById('sts-time');
    const nRpe      = document.getElementById('sts-rpe');
    if (nSessions) nSessions.textContent = this._sessions.length;
    if (nTime)     nTime.textContent     = fmtStrengthTime(totalTime);
    if (nRpe)      nRpe.textContent      = this._avgRpe();

    el.style.display = 'flex';
  }

  _renderList() {
    const list  = document.getElementById('strength-list');
    const empty = document.getElementById('strength-empty');
    const count = document.getElementById('strength-count');
    if (!list) return;

    list.innerHTML = '';
    if (count) {
      count.textContent = this._sessions.length
        ? `${this._sessions.length} session${this._sessions.length === 1 ? '' : 's'}`
        : '';
    }

    if (!this._sessions.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    this._sorted().forEach(session => {
      list.appendChild(this._buildCard(session));
    });
  }

  _buildCard(session) {
    const card = document.createElement('div');
    card.className = 'ride-card';

    // Header: name + date (textContent – never innerHTML for user values)
    const head = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'ride-card-title';
    title.textContent = session.name || 'Strength Session';
    const date = document.createElement('div');
    date.className = 'ride-card-date';
    date.textContent = fmtStrengthDate(session.date);
    head.appendChild(title);
    head.appendChild(date);
    card.appendChild(head);

    const focusKey = String(session.focus || '').toLowerCase();
    const badge = document.createElement('span');
    badge.className = 'ride-card-badge completed';
    badge.textContent = STRENGTH_FOCUS_LABELS[focusKey] || session.focus || 'Strength';
    card.appendChild(badge);

    const stats = document.createElement('div');
    stats.className = 'ride-card-stats';
    stats.appendChild(this._buildStat(fmtStrengthTime(session.elapsed), 'Time'));
    if (session.perceived_effort) {
      stats.appendChild(this._buildStat(`${Number(session.perceived_effort) || 0}/10`, 'RPE'));
    }
    card.appendChild(stats);

    if (session.notes) {
      const notes = document.createElement('div');
      notes.className = 'ride-card-notes';
      notes.textContent = session.notes;
      card.appendChild(notes);
    }

    const actions = document.createElement('div');
    actions.className = 'ride-card-actions';
    if (session.strava_id) {
      const link = document.createElement('a');
      link.className = 'strava-view';
      link.href = `https://www.strava.com/activities/${encodeURIComponent(session.strava_id)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View on Strava ↗';
      actions.appendChild(link);
    }
    const del = document.createElement('button');
    del.className = 'btn btn-stop';
    del.style.fontSize = '12px';
    del.style.padding = '5px 12px';
    del.textContent = 'Delete';
    del.dataset.deleteStrength = session.id;
    del.addEventListener('click', e => {
      const sid = e.currentTarget.dataset.deleteStrength;
      if (confirm('Delete this session?')) window.sendWS({ action: 'delete_strength', session_id: sid });
    });
    actions.appendChild(del);
    card.appendChild(actions);

    return card;
  }

  _buildStat(value, label) {
    const wrap = document.createElement('div');
    wrap.className = 'ride-stat';
    const v = document.createElement('span');
    v.className = 'ride-stat-value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'ride-stat-label';
    l.textContent = label;
    wrap.appendChild(v);
    wrap.appendChild(l);
    return wrap;
  }
}

window.StrengthTab = StrengthTab;
