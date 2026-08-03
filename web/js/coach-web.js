'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CoachEngineWeb – JS port of server/coach_engine.py.
   Pure computation, no I/O. See coach_engine.py's module docstring for
   the composeMessage() seam rationale — this file mirrors it exactly.
═══════════════════════════════════════════════════════════════════ */

const CoachEngineWeb = (() => {

  // bike_style/run_style ('road'|'mountain' and 'road'|'trail') are answered
  // right after picking the discipline and drive which goal options show up
  // next — indoor ERG training/mileage-target math is surface-agnostic, so
  // only the framing changes, not the engine.
  const ALL_STEPS = [
    'discipline',
    'bike_style', 'bike_goal', 'bike_level', 'bike_days', 'bike_hours', 'bike_ftp',
    'run_style', 'run_goal', 'run_level', 'run_days', 'run_miles',
    'notes',
    'confirm',
  ];

  const BIKE_STEPS = new Set(['bike_style', 'bike_goal', 'bike_level', 'bike_days', 'bike_hours', 'bike_ftp']);
  const RUN_STEPS  = new Set(['run_style', 'run_goal', 'run_level', 'run_days', 'run_miles']);

  const NUMERIC_STEPS = new Set(['bike_ftp', 'bike_days', 'bike_hours', 'run_days', 'run_miles']);

  function stepsFor(discipline) {
    return ALL_STEPS.filter(s => {
      if (BIKE_STEPS.has(s) && discipline === 'running') return false;
      if (RUN_STEPS.has(s) && discipline === 'cycling') return false;
      return true;
    });
  }

  function nextStep(discipline, currentStep) {
    const steps = stepsFor(discipline || 'both');
    if (currentStep == null) return steps[0];
    const i = steps.indexOf(currentStep);
    if (i === -1) return steps[0];
    return i + 1 < steps.length ? steps[i + 1] : null;
  }

  // Goal *values* are identical across styles — only the label wording
  // changes so the choice reads naturally for each style.
  const BIKE_GOALS_ROAD = [
    { value: 'base_fitness',  label: 'Base Fitness' },
    { value: 'build_fitness', label: 'Build Fitness' },
    { value: 'century',       label: 'Century / Gran Fondo' },
    { value: 'race_prep',     label: 'Race Prep' },
  ];
  const BIKE_GOALS_MTB = [
    { value: 'base_fitness',  label: 'Base Fitness' },
    { value: 'build_fitness', label: 'Build Fitness' },
    { value: 'century',       label: 'Endurance / All-Day Ride' },
    { value: 'race_prep',     label: 'XC / Enduro Race Prep' },
  ];
  const RUN_GOALS_ROAD = [
    { value: 'base_mileage',  label: 'Base Mileage' },
    { value: 'five_k',        label: '5K' },
    { value: 'ten_k',         label: '10K' },
    { value: 'half_marathon', label: 'Half Marathon' },
    { value: 'marathon',      label: 'Marathon' },
  ];
  const RUN_GOALS_TRAIL = [
    { value: 'base_mileage',  label: 'Base Mileage' },
    { value: 'half_marathon', label: 'Trail Half Marathon' },
    { value: 'marathon',      label: 'Trail Marathon' },
    { value: 'ultra',         label: 'Ultra (50K+)' },
  ];
  const LEVELS = [
    { value: 'beginner',     label: 'Beginner' },
    { value: 'intermediate', label: 'Intermediate' },
    { value: 'advanced',     label: 'Advanced' },
  ];
  const BIKE_DAYS  = [3, 4, 5, 6, 7].map(n => ({ value: String(n), label: String(n) }));
  const RUN_DAYS   = [3, 4, 5, 6].map(n => ({ value: String(n), label: String(n) }));   // matches generate_run_plan's cap
  const BIKE_HOURS = [3, 5, 7, 10].map(n => ({ value: String(n), label: `${n} hrs` }));
  const DISCIPLINE = [
    { value: 'cycling', label: 'Cycling' },
    { value: 'running', label: 'Running' },
    { value: 'both',    label: 'Both' },
  ];
  const BIKE_STYLE = [
    { value: 'road',     label: 'Road' },
    { value: 'mountain', label: 'Mountain' },
  ];
  const RUN_STYLE = [
    { value: 'road',  label: 'Road' },
    { value: 'trail', label: 'Trail' },
  ];

  const STEP_META = {
    discipline: { text: "Want a training plan? Let's set one up — cycling, running, or both?",
                  type: 'quick_reply', options: DISCIPLINE },
    bike_style: { text: 'Road or mountain biking?', type: 'quick_reply', options: BIKE_STYLE },
    bike_level: { text: "What's your cycling experience level?", type: 'quick_reply', options: LEVELS },
    bike_days:  { text: 'How many days a week do you want to ride?', type: 'quick_reply', options: BIKE_DAYS },
    bike_hours: { text: 'About how many hours a week can you train?', type: 'quick_reply', options: BIKE_HOURS },
    bike_ftp:   { text: "What's your current FTP, in watts? A rough guess is fine.",
                  type: 'number_input', unit: 'W', placeholder: 'e.g. 220' },
    run_style:  { text: 'Road or trail running?', type: 'quick_reply', options: RUN_STYLE },
    run_level:  { text: "What's your running experience level?", type: 'quick_reply', options: LEVELS },
    run_days:   { text: 'How many days a week do you want to run?', type: 'quick_reply', options: RUN_DAYS },
    run_miles:  { text: 'About how many miles a week do you want to target?',
                  type: 'number_input', unit: 'mi', placeholder: 'e.g. 15' },
    notes:      { text: "Anything else I should know — injuries, an upcoming event, a break "
                        + "you're returning from? Optional — type it, or say Skip.",
                  type: 'free_text' },
    confirm:    { text: 'Ready to generate your 6-week plan?', type: 'quick_reply',
                  options: [{ value: 'generate', label: 'Generate my plan' },
                            { value: 'restart',  label: 'Start over' }] },
  };

  function goalOptions(step, profilePartial) {
    if (step === 'bike_goal') {
      return profilePartial.bike_style === 'mountain' ? BIKE_GOALS_MTB : BIKE_GOALS_ROAD;
    }
    return profilePartial.run_style === 'trail' ? RUN_GOALS_TRAIL : RUN_GOALS_ROAD;
  }

  function stepPrompt(step, profilePartial) {
    if (step === 'bike_goal' || step === 'run_goal') {
      const rawText = step === 'bike_goal' ? "What's your cycling goal?" : "What's your running goal?";
      const text = composeMessage('onboarding_step', { step, text: rawText, profile: profilePartial });
      return { text, message_type: 'quick_reply', payload: { step, options: goalOptions(step, profilePartial) } };
    }

    const meta = STEP_META[step];
    const text = composeMessage('onboarding_step', { step, text: meta.text, profile: profilePartial });
    if (meta.type === 'quick_reply') {
      return { text, message_type: 'quick_reply', payload: { step, options: meta.options } };
    }
    if (meta.type === 'number_input') {
      return { text, message_type: 'number_input',
               payload: { step, unit: meta.unit, placeholder: meta.placeholder } };
    }
    return { text, message_type: 'free_text', payload: { step } };
  }

  const CHECKIN_OPTIONS = [
    { value: 'too_easy',   label: 'Too easy' },
    { value: 'just_right', label: 'Just right' },
    { value: 'too_hard',   label: 'Too hard' },
  ];

  function checkinPrompt(activityKind, activityName) {
    const label = activityKind === 'ride' ? 'ride' : 'run';
    const text = composeMessage('checkin_prompt', { kind: activityKind, name: activityName, label });
    return { text, message_type: 'quick_reply', payload: { kind: activityKind, options: CHECKIN_OPTIONS } };
  }

  // ── The AI swap-in seam (mirrors compose_message in coach_engine.py) ──
  function composeMessage(kind, context) {
    if (kind === 'onboarding_step') return context.text;
    if (kind === 'checkin_prompt')  return `How did ${context.name || `your ${context.label}`} feel?`;
    if (kind === 'adaptation_result') return context.message || '';
    return context.text || '';
  }

  return {
    nextStep, stepPrompt, checkinPrompt, composeMessage,
    CHECKIN_OPTIONS, NUMERIC_STEPS,
  };
})();

/* ═══════════════════════════════════════════════════════════════════
   CoachWeb – direct-Supabase I/O (the "server/main.py" twin for the
   web build, since there's no server to hold this logic separately).
═══════════════════════════════════════════════════════════════════ */

const CoachWeb = (() => {

  async function getProfile(sb, userId) {
    const { data } = await sb.from('athlete_profiles').select('*').eq('user_id', userId).maybeSingle();
    return data || null;
  }

  async function saveProfile(sb, userId, fields) {
    const payload = { ...fields, user_id: userId, updated_at: new Date().toISOString() };
    const { data } = await sb.from('athlete_profiles').upsert(payload, { onConflict: 'user_id' }).select().single();
    return data || payload;
  }

  async function getMessages(sb, userId, limit = 200) {
    const { data } = await sb.from('coach_messages').select('*')
      .eq('user_id', userId).order('created_at').limit(limit);
    return data || [];
  }

  // The single most recent coach_messages row, or null.
  async function getLatestMessage(sb, userId) {
    const { data } = await sb.from('coach_messages').select('*')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1);
    return (data && data[0]) || null;
  }

  async function clearMessages(sb, userId) {
    await sb.from('coach_messages').delete().eq('user_id', userId);
  }

  async function postMessage(sb, userId, role, text, messageType = 'plain', payload = {}) {
    const { data } = await sb.from('coach_messages').insert({
      user_id: userId, role, text, message_type: messageType, payload,
    }).select().single();
    return data || {};
  }

  async function setRideFeedback(sb, rideId, feedback) {
    await sb.from('rides').update({ feedback }).eq('id', rideId);
  }

  async function setRunFeedback(sb, runId, feedback) {
    await sb.from('runs').update({ feedback }).eq('id', runId);
  }

  async function ridesNeedingCheckin(sb, userId, since, limit = 1) {
    let q = sb.from('rides').select('*').eq('user_id', userId)
      .eq('completed', true).is('feedback', null).order('created_at').limit(limit);
    if (since) q = q.gte('created_at', since);
    const { data } = await q;
    return data || [];
  }

  async function runsNeedingCheckin(sb, userId, since, limit = 1) {
    let q = sb.from('runs').select('*').eq('user_id', userId)
      .is('feedback', null).order('created_at').limit(limit);
    if (since) q = q.gte('created_at', since);
    const { data } = await q;
    return data || [];
  }

  return {
    getProfile, saveProfile, getMessages, getLatestMessage, clearMessages, postMessage,
    setRideFeedback, setRunFeedback, ridesNeedingCheckin, runsNeedingCheckin,
  };
})();

window.CoachEngineWeb = CoachEngineWeb;
window.CoachWeb       = CoachWeb;
