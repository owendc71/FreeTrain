// Vercel serverless function: the FreeTrain AI coach.
//
// Keeps ANTHROPIC_API_KEY server-side — never expose it to the browser.
// Set these in Vercel → Settings → Environment Variables:
//   ANTHROPIC_API_KEY    (secret)
//   SUPABASE_URL         (same value as web/config.js supabaseUrl)
//   SUPABASE_ANON_KEY    (same value as web/config.js supabaseAnonKey — public)
//
// Design notes:
//  • The model, system prompt and tool schemas are pinned HERE, server-side.
//    The browser only supplies conversation history, so a leaked endpoint can't
//    be repurposed as a general-purpose Claude proxy on your billing account.
//  • Tools are *declared* here but *executed* in the browser (see
//    web/js/ai-coach-web.js) — that's where the plan engines and the
//    authenticated Supabase client already live, so nothing is duplicated.
//  • Every caller must present a valid Supabase session token.

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk';

const MODEL      = process.env.COACH_MODEL || 'claude-sonnet-5';
const EFFORT     = process.env.COACH_EFFORT || 'medium';   // low | medium | high | xhigh | max
const MAX_TOKENS = 8000;

// Abuse guards on the client-supplied history.
const MAX_MESSAGES   = 60;
const MAX_BODY_CHARS = 120_000;
const MAX_CTX_CHARS  = 8_000;

// Vercel: allow room for a thinking-enabled turn (Hobby plan caps at 60s).
export const config = { maxDuration: 60 };

const SYSTEM_PROMPT = `You are the FreeTrain coach — a knowledgeable, encouraging endurance coach built into a cycling and running training app. You are talking with one athlete about their own training.

## Voice
- Keep replies short and conversational: at most 1-3 short paragraphs. No headings, no bulleted walls of text. This is a chat window, not a document.
- Ask one question at a time. Never interrogate the athlete with a numbered list of questions.
- Be specific to this athlete's actual data. Generic advice they could get from any website is a failure.

## Honesty about data
Never invent numbers about their training. The athlete's profile and a summary of recent activity are provided to you in <athlete_context>. For anything more detailed, call get_recent_activity. If a fact isn't in your context or in a tool result, say you don't know rather than guessing.

## Building plans
When the athlete wants a training plan, gather what you need conversationally — discipline, goal, experience level, days per week, and either weekly hours (cycling) or weekly mileage (running) — then call create_cycling_plan or create_run_plan.

These tools run FreeTrain's own periodized 6-week plan generator, which handles progressive overload and recovery weeks correctly. ALWAYS build plans by calling the tool. Never write a week-by-week plan out as text instead — a plan you type into chat does not exist in the athlete's calendar.

Creating a plan REPLACES any existing plan for that discipline, so confirm with the athlete before calling the tool. Afterwards, briefly say what got scheduled.

Call save_profile whenever you learn something durable — goals, experience level, weekly availability, injuries, a target event and its date — so you still know it next session.

## Coaching judgment
- Honor the principles the plans are built on: progressive overload, recovery weeks, and no large jumps in weekly volume. If the athlete pushes for something reckless (doubling mileage, racing through an injury), say so plainly and offer a sane alternative.
- Soreness is normal; pain is not. If the athlete describes pain, joint problems, chest symptoms, or anything that sounds like an injury, tell them to back off and see a qualified professional. You are a training coach, not a medical provider — do not diagnose.
- For adjacent topics (nutrition, gear, recovery habits) give a brief practical answer and be honest about where your usefulness ends.`;

const TOOLS = [
  {
    name: 'create_cycling_plan',
    description:
      "Generate and save a 6-week periodized cycling plan using FreeTrain's own plan engine, " +
      'replacing any existing cycling plan. Writes real workouts into the athlete\'s calendar. ' +
      'Use this for any cycling/bike plan request instead of writing a plan out as text.',
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          enum: ['base_fitness', 'build_fitness', 'century', 'race_prep'],
          description:
            'base_fitness = general aerobic base; build_fitness = raise FTP/fitness; ' +
            'century = long-distance endurance event or all-day ride; race_prep = racing (road or XC/enduro).',
        },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        days_per_week: { type: 'integer', minimum: 3, maximum: 7 },
        weekly_hours: {
          type: 'number',
          description: 'Total hours per week the athlete can train. Used to size each session.',
        },
        ftp: {
          type: 'integer',
          description: 'Functional Threshold Power in watts, if known. Omit if unknown.',
        },
      },
      required: ['goal', 'level', 'days_per_week', 'weekly_hours'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_run_plan',
    description:
      "Generate and save a 6-week periodized running plan using FreeTrain's own run-plan engine, " +
      'replacing any existing run plan. Writes real runs into the athlete\'s calendar. ' +
      'Use this for any running plan request instead of writing a plan out as text.',
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          enum: ['base_mileage', 'five_k', 'ten_k', 'half_marathon', 'marathon', 'ultra'],
          description: 'base_mileage = build aerobic base; the rest target that race distance. ultra = 50K+.',
        },
        level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        days_per_week: { type: 'integer', minimum: 3, maximum: 6 },
        weekly_miles: {
          type: 'number',
          description: 'Target weekly mileage to build toward.',
        },
      },
      required: ['goal', 'level', 'days_per_week', 'weekly_miles'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_recent_activity',
    description:
      "Read the athlete's completed rides and/or runs, newest first, with distance, duration, " +
      'power/pace, and any subjective feedback they gave. Use this before analysing training or ' +
      'answering questions about how their training has actually been going.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['rides', 'runs', 'both'] },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many of each to return. Default 10.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_profile',
    description:
      'Persist durable facts about the athlete so you remember them in future sessions. ' +
      'Only pass the fields you actually learned; omitted fields are left unchanged.',
    input_schema: {
      type: 'object',
      properties: {
        bike_goal:  { type: 'string', enum: ['base_fitness', 'build_fitness', 'century', 'race_prep'] },
        bike_level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        bike_style: { type: 'string', enum: ['road', 'mountain'] },
        bike_days_per_week: { type: 'integer', minimum: 1, maximum: 7 },
        bike_weekly_hours:  { type: 'number' },
        bike_ftp:   { type: 'integer' },
        run_goal:   { type: 'string', enum: ['base_mileage', 'five_k', 'ten_k', 'half_marathon', 'marathon', 'ultra'] },
        run_level:  { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
        run_style:  { type: 'string', enum: ['road', 'trail'] },
        run_days_per_week: { type: 'integer', minimum: 1, maximum: 7 },
        run_weekly_miles:  { type: 'number' },
        notes: {
          type: 'string',
          description: 'Free-form durable context: injuries, target events and dates, constraints, preferences.',
        },
      },
      additionalProperties: false,
    },
  },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // The client falls back to the rule-based coach on this specific code.
    return res.status(503).json({ error: 'ai_coach_not_configured' });
  }

  const supaUrl  = process.env.SUPABASE_URL;
  const supaAnon = process.env.SUPABASE_ANON_KEY;
  if (!supaUrl || !supaAnon) {
    return res.status(500).json({ error: 'supabase_not_configured' });
  }

  // ── Require a real signed-in athlete ──────────────────────────────
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const who = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supaAnon },
    });
    if (!who.ok) return res.status(401).json({ error: 'invalid_token' });
  } catch {
    return res.status(502).json({ error: 'auth_check_failed' });
  }

  // ── Validate the client-supplied history ──────────────────────────
  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'missing_messages' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(413).json({ error: 'too_many_messages' });
  }
  if (JSON.stringify(messages).length > MAX_BODY_CHARS) {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') {
      return res.status(400).json({ error: 'bad_message_role' });
    }
  }

  const sent = messages.map(m => ({ role: m.role, content: m.content }));

  // Athlete context rides on the newest plain user turn rather than in `system`,
  // so it's always current without invalidating the cached system prefix.
  const last = sent[sent.length - 1];
  if (context && last.role === 'user' && typeof last.content === 'string') {
    last.content = [
      { type: 'text', text: `<athlete_context>\n${String(context).slice(0, MAX_CTX_CHARS)}\n</athlete_context>` },
      { type: 'text', text: last.content },
    ];
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      thinking:   { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools:  TOOLS,
      messages: sent,
    });

    return res.status(200).json({
      content:     response.content,
      stop_reason: response.stop_reason,
      usage:       response.usage,
    });
  } catch (err) {
    // Most specific first — AuthenticationError, RateLimitError and
    // APIConnectionError all extend APIError, so APIError must come last.
    if (err instanceof AuthenticationError) {
      console.error('coach-chat: ANTHROPIC_API_KEY rejected');
      return res.status(502).json({ error: 'ai_auth_failed' });
    }
    if (err instanceof RateLimitError) {
      return res.status(429).json({ error: 'ai_rate_limited' });
    }
    if (err instanceof APIConnectionError) {
      return res.status(504).json({ error: 'ai_unreachable' });
    }
    if (err instanceof APIError) {
      console.error(`coach-chat: API error ${err.status}:`, err.message);
      return res.status(502).json({ error: 'ai_api_error' });
    }
    console.error('coach-chat failed:', err);
    return res.status(500).json({ error: 'coach_chat_failed' });
  }
}
