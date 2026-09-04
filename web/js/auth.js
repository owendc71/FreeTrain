'use strict';

/* ═══════════════════════════════════════════════════════════════════
   AuthManager – Supabase-backed auth.
   Calls window.startApp(token, ftp) once the user is authenticated.
═══════════════════════════════════════════════════════════════════ */

const AuthManager = (() => {
  let _supabase = null;

  function _client() {
    if (!_supabase) {
      const { createClient } = window.supabase;
      _supabase = createClient(
        window.APP_CONFIG.supabaseUrl,
        window.APP_CONFIG.supabaseAnonKey,
      );
    }
    return _supabase;
  }

  // ── Overlay ────────────────────────────────────────────────────────
  function _show() { document.getElementById('auth-overlay').style.display = 'flex'; }
  function _hide() { document.getElementById('auth-overlay').style.display = 'none'; }

  function _setError(id, msg) {
    document.getElementById(id).textContent = msg;
  }

  // ── Header ─────────────────────────────────────────────────────────
  function _updateHeader(username) {
    const el   = document.getElementById('header-username');
    const info = document.getElementById('header-user-info');
    if (el)   el.textContent   = username;
    if (info) info.style.display = 'flex';
  }

  // ── Tab switching ──────────────────────────────────────────────────
  function _bindTabs() {
    document.getElementById('auth-login-tab').addEventListener('click', () => {
      document.getElementById('auth-login-tab').classList.add('active');
      document.getElementById('auth-register-tab').classList.remove('active');
      document.getElementById('auth-login-form').style.display    = 'flex';
      document.getElementById('auth-register-form').style.display = 'none';
      document.getElementById('auth-forgot-form').style.display   = 'none';
      _setError('auth-login-error', '');
    });

    document.getElementById('auth-register-tab').addEventListener('click', () => {
      document.getElementById('auth-register-tab').classList.add('active');
      document.getElementById('auth-login-tab').classList.remove('active');
      document.getElementById('auth-register-form').style.display = 'flex';
      document.getElementById('auth-login-form').style.display    = 'none';
      document.getElementById('auth-forgot-form').style.display   = 'none';
      _setError('auth-reg-error', '');
    });
  }

  // ── Login ──────────────────────────────────────────────────────────
  function _bindLogin() {
    document.getElementById('auth-login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      _setError('auth-login-error', '');

      const { data, error } = await _client().auth.signInWithPassword({
        email:    document.getElementById('auth-login-email').value.trim(),
        password: document.getElementById('auth-login-password').value,
      });

      btn.disabled = false; btn.textContent = 'Sign In';

      if (error) { _setError('auth-login-error', error.message); return; }

      const username = data.user.user_metadata?.username || data.user.email;
      _hide();
      _updateHeader(username);
      window.startApp(data.session.access_token);
    });
  }

  // ── Register ───────────────────────────────────────────────────────
  function _bindRegister() {
    document.getElementById('auth-register-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Creating account…';
      _setError('auth-reg-error', '');

      const username = document.getElementById('auth-reg-username').value.trim();
      const email    = document.getElementById('auth-reg-email').value.trim();
      const password = document.getElementById('auth-reg-password').value;

      const { data, error } = await _client().auth.signUp({
        email,
        password,
        options: { data: { username } },
      });

      btn.disabled = false; btn.textContent = 'Create Account';

      if (error) { _setError('auth-reg-error', error.message); return; }

      // Supabase may require email confirmation — handle both cases.
      if (!data.session) {
        _setError('auth-reg-error',
          'Check your email and click the confirmation link, then sign in.');
        document.getElementById('auth-login-tab').click();
        return;
      }

      _hide();
      _updateHeader(username);
      window.startApp(data.session.access_token);
    });
  }

  // ── Logout ─────────────────────────────────────────────────────────
  async function logout() {
    await _client().auth.signOut();
    location.reload();
  }

  // ── Forgot / reset password ──────────────────────────────────────
  // Supabase's reset email links back to redirectTo with recovery tokens
  // in the URL; supabase-js auto-detects them (detectSessionInUrl) and
  // fires PASSWORD_RECOVERY with a live recovery session already attached
  // to the client — so updateUser() below just works off that session.
  function _bindForgotPassword() {
    document.getElementById('auth-forgot-link').addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('auth-login-form').style.display     = 'none';
      document.getElementById('auth-forgot-form').style.display    = 'flex';
      document.getElementById('auth-forgot-success').style.display = 'none';
      _setError('auth-forgot-error', '');
    });

    document.getElementById('auth-forgot-cancel').addEventListener('click', e => {
      e.preventDefault();
      document.getElementById('auth-forgot-form').style.display = 'none';
      document.getElementById('auth-login-form').style.display  = 'flex';
    });

    document.getElementById('auth-forgot-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Sending…';
      _setError('auth-forgot-error', '');

      const email = document.getElementById('auth-forgot-email').value.trim();
      const { error } = await _client().auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });

      btn.disabled = false; btn.textContent = 'Send Reset Link';

      if (error) { _setError('auth-forgot-error', error.message); return; }
      document.getElementById('auth-forgot-success').style.display = 'block';
    });
  }

  function _showResetForm() {
    document.getElementById('auth-tabs').style.display          = 'none';
    document.getElementById('auth-login-form').style.display    = 'none';
    document.getElementById('auth-register-form').style.display = 'none';
    document.getElementById('auth-forgot-form').style.display   = 'none';
    document.getElementById('auth-reset-form').style.display    = 'flex';
    _show();
  }

  let _recoveryReady = false;

  function _bindResetPassword() {
    const form = document.getElementById('auth-reset-form');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!_recoveryReady) return;   // link not verified yet

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Saving…';
      _setError('auth-reset-error', '');

      const password = document.getElementById('auth-reset-password').value;
      const { data, error } = await _client().auth.updateUser({ password });

      btn.disabled = false; btn.textContent = 'Set New Password';

      if (error) { _setError('auth-reset-error', error.message); return; }

      // Strip the recovery tokens from the URL, then continue into the app.
      history.replaceState(null, '', window.location.pathname);
      const { data: { session } } = await _client().auth.getSession();
      const username = data.user.user_metadata?.username || data.user.email;
      _hide();
      _updateHeader(username);
      window.startApp(session.access_token);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────
  async function init() {
    _bindTabs();
    _bindLogin();
    _bindRegister();
    _bindForgotPassword();
    _bindResetPassword();

    // A reset link always carries type=recovery — in the hash (implicit
    // flow) or the query string (PKCE). Detecting it up front means this
    // branch never races the normal getSession() path below over which
    // one gets to own the initial UI.
    const isRecoveryLink =
      /type=recovery/.test(window.location.hash) ||
      /type=recovery/.test(window.location.search);

    if (isRecoveryLink) {
      _showResetForm();
      const btn = document.querySelector('#auth-reset-form button[type=submit]');
      btn.disabled = true; btn.textContent = 'Verifying link…';

      const { data: { subscription } } = _client().auth.onAuthStateChange(event => {
        if (event !== 'PASSWORD_RECOVERY') return;
        _recoveryReady = true;
        btn.disabled = false; btn.textContent = 'Set New Password';
        subscription.unsubscribe();
      });

      // Expired or already-used links never fire PASSWORD_RECOVERY. Fail
      // visibly rather than leaving the form stuck on "Verifying…".
      setTimeout(() => {
        if (_recoveryReady) return;
        subscription.unsubscribe();
        btn.textContent = 'Set New Password';
        _setError('auth-reset-error',
          'This reset link is invalid or has expired — request a new one from the sign-in page.');
      }, 8000);

      return;
    }

    // Restore existing session (supabase-js persists it in localStorage)
    const { data: { session } } = await _client().auth.getSession();
    if (session) {
      const username = session.user.user_metadata?.username || session.user.email;
      _hide();
      _updateHeader(username);
      window.startApp(session.access_token);
      return;
    }

    _show();
  }

  return { init, logout };
})();

window.AuthManager = AuthManager;

document.addEventListener('DOMContentLoaded', () => AuthManager.init());
