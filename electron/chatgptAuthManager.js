const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

// "Sign in with ChatGPT": OAuth 2.0 authorization-code + PKCE against
// auth.openai.com using the public Codex CLI client id. The resulting access
// token calls the ChatGPT backend (chatgpt.com/backend-api/codex) so a
// ChatGPT Plus/Pro subscription can be used instead of an OpenAI API key.

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // public Codex CLI client
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const SCOPE = 'openid profile email offline_access';
const PREFERRED_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REFRESH_LEAD_MS = 5 * 60 * 1000; // refresh when < 5 min of validity left
const MAX_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000; // force re-login after 8 days
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let saveSettingsCallback = null;
let loadSettingsCallback = null;
let loginInFlight = false;
let refreshInFlight = null;

function initialize(saveSettings, loadSettings) {
  saveSettingsCallback = saveSettings;
  loadSettingsCallback = loadSettings;
  console.log('[ChatGPTAuth] Initialized');
}

// Client-side-only JWT payload decode (no signature verification needed here)
function decodeIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    const authClaim = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || null,
      accountId: authClaim.chatgpt_account_id || null,
      planType: authClaim.chatgpt_plan_type || null,
    };
  } catch {
    return { email: null, accountId: null, planType: null };
  }
}

function isSignedIn(settings) {
  return !!(settings && settings.chatgptRefreshToken);
}

function getStatus(settings) {
  if (!isSignedIn(settings)) return { signedIn: false };
  return {
    signedIn: true,
    email: settings.chatgptEmail || null,
    planType: settings.chatgptPlanType || null,
    expiresAt: settings.chatgptTokenExpiresAt || null,
  };
}

function persistTokens(tokenResponse) {
  const settings = loadSettingsCallback();
  const identity = tokenResponse.id_token ? decodeIdToken(tokenResponse.id_token) : {};
  const updated = {
    ...settings,
    chatgptAccessToken: tokenResponse.access_token,
    // IMPORTANT: the refresh token rotates on every refresh — always store the
    // newest one or the next refresh fails with invalid_grant.
    chatgptRefreshToken: tokenResponse.refresh_token || settings.chatgptRefreshToken,
    chatgptIdToken: tokenResponse.id_token || settings.chatgptIdToken || '',
    chatgptTokenExpiresAt:
      Date.now() + (tokenResponse.expires_in ? tokenResponse.expires_in * 1000 : 3600 * 1000),
    chatgptLastRefreshAt: Date.now(),
  };
  if (identity.email) updated.chatgptEmail = identity.email;
  if (identity.accountId) updated.chatgptAccountId = identity.accountId;
  if (identity.planType) updated.chatgptPlanType = identity.planType;
  saveSettingsCallback(updated);
  return updated;
}

function signOut() {
  const settings = loadSettingsCallback();
  saveSettingsCallback({
    ...settings,
    chatgptAccessToken: '',
    chatgptRefreshToken: '',
    chatgptIdToken: '',
    chatgptTokenExpiresAt: 0,
    chatgptLastRefreshAt: 0,
    chatgptEmail: '',
    chatgptAccountId: '',
    chatgptPlanType: '',
  });
  console.log('[ChatGPTAuth] Signed out');
  return true;
}

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    let settleCallback;
    const callbackPromise = new Promise((res) => {
      settleCallback = res;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        error
          ? '<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>Sign-in failed</h2><p>You can close this tab and try again in Groq Desktop.</p></body></html>'
          : '<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>Signed in with ChatGPT</h2><p>You can close this tab and return to Groq Desktop.</p></body></html>'
      );
      settleCallback({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error,
        description: url.searchParams.get('error_description'),
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        // Preferred port busy — let the OS pick a free one
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });
    server.listen(PREFERRED_PORT, '127.0.0.1');
    server.on('listening', () => {
      resolve({ server, port: server.address().port, callbackPromise });
    });
  });
}

// Build query manually so spaces encode as %20 (not '+')
function buildQuery(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

async function startLogin() {
  if (loginInFlight) throw new Error('A ChatGPT sign-in is already in progress');
  loginInFlight = true;
  let server = null;
  try {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    const started = await startCallbackServer();
    server = started.server;
    const redirectUri = `http://localhost:${started.port}${CALLBACK_PATH}`;

    const authUrl = `${AUTHORIZE_URL}?${buildQuery({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
      state,
    })}`;

    console.log('[ChatGPTAuth] Opening browser for sign-in on port', started.port);
    await shell.openExternal(authUrl);

    const result = await Promise.race([
      started.callbackPromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Sign-in timed out after 5 minutes')), LOGIN_TIMEOUT_MS)
      ),
    ]);

    if (result.error) throw new Error(result.description || result.error);
    if (!result.code) throw new Error('No authorization code returned');
    if (result.state !== state) throw new Error('State mismatch — possible CSRF, aborting');

    // Authorization-code exchange uses form encoding (refresh uses JSON)
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code: result.code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const updated = persistTokens(await response.json());
    console.log('[ChatGPTAuth] Signed in as', updated.chatgptEmail || '(unknown email)');
    return {
      ok: true,
      email: updated.chatgptEmail || null,
      planType: updated.chatgptPlanType || null,
    };
  } finally {
    loginInFlight = false;
    if (server) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function refreshTokens() {
  const settings = loadSettingsCallback();
  if (!settings.chatgptRefreshToken) throw new Error('Not signed in with ChatGPT');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: settings.chatgptRefreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (/refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_grant/.test(text)) {
      signOut();
      throw new Error('ChatGPT session expired — please sign in again in Settings');
    }
    throw new Error(`ChatGPT token refresh failed (${response.status})`);
  }

  return persistTokens(await response.json());
}

/**
 * Returns { token, accountId }, refreshing lazily when the access token is
 * missing or expiring within 5 minutes. Concurrent callers share one refresh.
 */
async function getValidAccessToken(settings) {
  const current = settings || loadSettingsCallback();
  if (!current.chatgptRefreshToken) throw new Error('Not signed in with ChatGPT');

  const lastRefresh = current.chatgptLastRefreshAt || current.chatgptTokenExpiresAt || 0;
  if (lastRefresh && Date.now() - lastRefresh > MAX_REFRESH_AGE_MS) {
    signOut();
    throw new Error('ChatGPT session is stale — please sign in again in Settings');
  }

  if (
    current.chatgptAccessToken &&
    (current.chatgptTokenExpiresAt || 0) - Date.now() > REFRESH_LEAD_MS
  ) {
    return { token: current.chatgptAccessToken, accountId: current.chatgptAccountId || null };
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshTokens().finally(() => {
      refreshInFlight = null;
    });
  }
  const updated = await refreshInFlight;
  return { token: updated.chatgptAccessToken, accountId: updated.chatgptAccountId || null };
}

module.exports = {
  initialize,
  startLogin,
  signOut,
  getStatus,
  isSignedIn,
  getValidAccessToken,
  refreshTokens,
};
