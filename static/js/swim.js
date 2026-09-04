'use strict';

/* ═══════════════════════════════════════════════════════════════════
   Swim tab – career swim stats and the recent swims list. Swims are
   logged manually or imported from Strava (no local execution). Swim
   plan creation happens via the coach chat on the Plan tab.

   Swimming is metric by convention: distance in metres/km and pace in
   seconds per 100m, so this file deliberately does NOT reuse the
   mile-based helpers from run.js.
═══════════════════════════════════════════════════════════════════ */

// "850m" under a kilometre, otherwise "2.4km"
function fmtSwimDistance(m) {
  const meters = Number(m) || 0;
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function fmtSwimTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// pace stored as sec/100m -> "M:SS /100m"
function fmtSwimPace(secPer100m) {
  const p = Number(secPer100m) || 0;
  if (!p) return '—';
  const m = Math.floor(p / 60);
  const s = Math.round(p % 60);
  return `${m}:${String(s).padStart(2, '0')} /100m`;
}

function fmtSwimDate(date) {
  if (!date) return '—';
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

const SWIM_TYPE_LABELS = {
  recovery:  'Recovery',
  technique: 'Technique',
  easy:      'Easy',
  threshold: 'Threshold',
  intervals: 'Intervals',
  long:      'Long Swim',
};

const SWIM_STROKE_LABELS = {
  free:   'Freestyle',
  back:   'Backstroke',
  breast: 'Breaststroke',
  fly:    'Butterfly',
  mixed:  'Mixed',
  im:     'IM',
};

/* ═══════════════════════════════════════════════════════════════════
   Swim tab renderer
═══════════════════════════════════════════════════════════════════ */

class SwimTab {
  constructor() {
    this._swims = [];
  }

  update({ swims } = {}) {
    if (swims != null) this._swims = swims;
    this._renderSummary();
    this._renderList();
  }

  // newest first, without mutating the caller's array
  _sorted() {
    return this._swims.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }

  _renderSummary() {
    const el = document.getElementById('swim-summary');
    if (!el) return;
    if (!this._swims.length) { el.style.display = 'none'; return; }

    const totalDist = this._swims.reduce((s, w) => s + (Number(w.distance_m) || 0), 0);
    const totalTime = this._swims.reduce((s, w) => s + (Number(w.elapsed) || 0), 0);

    const nSwims = document.getElementById('ss-swims');
    const nDist  = document.getElementById('ss-distance');
    const nTime  = document.getElementById('ss-time');
    if (nSwims) nSwims.textContent = this._swims.length;
    if (nDist)  nDist.textContent  = fmtSwimDistance(totalDist);
    if (nTime)  nTime.textContent  = fmtSwimTime(totalTime);

    el.style.display = 'flex';
  }

  _renderList() {
    const list  = document.getElementById('swim-list');
    const empty = document.getElementById('swim-empty');
    const count = document.getElementById('swim-count');
    if (!list) return;

    list.innerHTML = '';
    if (count) {
      count.textContent = this._swims.length
        ? `${this._swims.length} swim${this._swims.length === 1 ? '' : 's'}`
        : '';
    }

    if (!this._swims.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    this._sorted().forEach(swim => {
      list.appendChild(this._buildCard(swim));
    });
  }

  _buildCard(swim) {
    const card = document.createElement('div');
    card.className = 'ride-card';

    // Header: name + date (textContent – never innerHTML for user values)
    const head = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'ride-card-title';
    title.textContent = swim.name || 'Swim';
    const date = document.createElement('div');
    date.className = 'ride-card-date';
    date.textContent = fmtSwimDate(swim.date);
    head.appendChild(title);
    head.appendChild(date);
    card.appendChild(head);

    const badge = document.createElement('span');
    badge.className = 'ride-card-badge completed';
    badge.textContent = swim.source === 'strava' ? 'Strava' : 'Logged';
    card.appendChild(badge);

    const strokeKey = String(swim.stroke || '').toLowerCase();
    const stats = document.createElement('div');
    stats.className = 'ride-card-stats';
    [
      [fmtSwimDistance(swim.distance_m), 'Distance'],
      [fmtSwimTime(swim.elapsed), 'Time'],
      [fmtSwimPace(swim.avg_pace_sec_per_100m), 'Pace'],
      [SWIM_STROKE_LABELS[strokeKey] || swim.stroke || '—', 'Stroke'],
    ].forEach(([value, label]) => {
      stats.appendChild(this._buildStat(value, label));
    });
    card.appendChild(stats);

    const actions = document.createElement('div');
    actions.className = 'ride-card-actions';
    if (swim.strava_id) {
      const link = document.createElement('a');
      link.className = 'strava-view';
      link.href = `https://www.strava.com/activities/${encodeURIComponent(swim.strava_id)}`;
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
    del.dataset.deleteSwim = swim.id;
    del.addEventListener('click', e => {
      const sid = e.currentTarget.dataset.deleteSwim;
      if (confirm('Delete this swim?')) window.sendWS({ action: 'delete_swim', swim_id: sid });
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

window.SwimTab = SwimTab;
