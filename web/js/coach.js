'use strict';

/* ═══════════════════════════════════════════════════════════════════
   CoachChat – the AI-free coach chat panel on the Plan tab.
   Renders the persisted transcript (coach_messages), shows quick-reply
   buttons / a number field / a free-text box under the single most
   recent still-open coach prompt, and sends replies via window.sendWS
   (works identically on the local WS build and the web/Supabase build,
   since both wire window.sendWS to route 'coach_reply' etc. actions).
═══════════════════════════════════════════════════════════════════ */

class CoachChat {
  constructor() {
    this._messages = [];
    this._profile  = null;

    this._messagesEl = document.getElementById('coach-messages');
    this._repliesEl   = document.getElementById('coach-quick-replies');
    this._inputRow    = document.getElementById('coach-input-row');
    this._textInput   = document.getElementById('coach-text-input');
    this._textSend    = document.getElementById('coach-text-send');
    this._restartBtn  = document.getElementById('coach-restart-btn');
    this._clearBtn    = document.getElementById('coach-clear-btn');

    this._bindEvents();
  }

  // ── Public API ─────────────────────────────────────────────────────

  // Called once at startup with { profile, messages }.
  mount({ profile, messages } = {}) {
    this._profile  = profile || null;
    this._messages = messages || [];
    this._render();
  }

  // Called whenever a new message arrives (local: 'coach_message' WS push;
  // web: directly after CoachWeb.postMessage()).
  appendMessage(msg) {
    if (!msg) return;
    this._messages.push(msg);
    this._render();
  }

  // Called on 'coach_cleared' (local WS push) or right after clearing the
  // transcript (web build) — wipes the visible chat immediately, ahead of
  // whatever re-seeded prompt arrives next.
  reset() {
    this._messages = [];
    this._render();
  }

  // ── Rendering ──────────────────────────────────────────────────────

  _render() {
    if (!this._messagesEl) return;

    this._messagesEl.innerHTML = '';
    this._messages.forEach(msg => this._messagesEl.appendChild(this._renderBubble(msg)));
    this._scrollToBottom();

    const pending = this._pendingMessage();
    this._renderInteraction(pending);
  }

  _renderBubble(msg) {
    const bubble = document.createElement('div');
    bubble.className = `coach-bubble ${msg.role === 'user' ? 'user' : 'coach'}`;
    bubble.textContent = msg.text || '';
    return bubble;
  }

  // The single most recent coach message still awaiting a reply, or null.
  _pendingMessage() {
    if (!this._messages.length) return null;
    const last = this._messages[this._messages.length - 1];
    if (last.role === 'coach' && ['quick_reply', 'number_input', 'free_text'].includes(last.message_type)) {
      return last;
    }
    return null;
  }

  _renderInteraction(pending) {
    this._repliesEl.innerHTML = '';
    this._inputRow.style.display = 'none';

    if (!pending) return;

    if (pending.message_type === 'quick_reply') {
      (pending.payload.options || []).forEach(opt => {
        const btn = document.createElement('button');
        btn.className   = 'coach-quick-reply-btn';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => this._sendReply(pending, opt.value));
        this._repliesEl.appendChild(btn);
      });
      return;
    }

    if (pending.message_type === 'number_input') {
      this._inputRow.style.display = 'flex';
      this._textInput.type        = 'number';
      this._textInput.placeholder = pending.payload.placeholder || '';
      this._textInput.value       = '';
      this._pendingStep           = pending.payload.step;
      this._pendingKind           = 'number';
      return;
    }

    if (pending.message_type === 'free_text') {
      this._inputRow.style.display = 'flex';
      this._textInput.type        = 'text';
      this._textInput.placeholder = 'Type here, or Skip';
      this._textInput.value       = '';
      this._pendingStep           = pending.payload.step;
      this._pendingKind           = 'text';
    }
  }

  _sendReply(pending, value) {
    if (pending.payload.kind) {
      // Post-workout check-in
      window.sendWS({
        action:      'coach_checkin_reply',
        kind:        pending.payload.kind,
        activity_id: pending.payload.activity_id,
        feedback:    value,
      });
    } else {
      // Onboarding step
      window.sendWS({ action: 'coach_reply', step: pending.payload.step, value });
    }
    this._repliesEl.innerHTML = '';
    this._inputRow.style.display = 'none';
  }

  _submitTextInput() {
    if (!this._pendingStep) return;
    const raw = this._textInput.value.trim();
    const value = this._pendingKind === 'text' && !raw ? 'Skip' : raw;
    if (!value) return;
    window.sendWS({ action: 'coach_reply', step: this._pendingStep, value });
    this._textInput.value = '';
    this._inputRow.style.display = 'none';
  }

  _scrollToBottom() {
    if (this._messagesEl) this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
  }

  _bindEvents() {
    this._textSend?.addEventListener('click', () => this._submitTextInput());
    this._textInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._submitTextInput(); }
    });
    this._restartBtn?.addEventListener('click', () => {
      if (confirm("Redo your training profile? This won't touch your existing calendar until you generate a new plan.")) {
        window.sendWS({ action: 'coach_start_onboarding' });
      }
    });
    this._clearBtn?.addEventListener('click', () => {
      if (confirm('Clear the chat history? This only clears the conversation — your calendar is untouched.')) {
        window.sendWS({ action: 'clear_chat' });
      }
    });
  }
}

window.CoachChat = CoachChat;
