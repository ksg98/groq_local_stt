// Model definitions for non-Groq providers (Anthropic, OpenAI).
//
// Models are fetched dynamically from each provider's API (mirroring how Groq
// models are fetched in shared/models.js) and cached for 5 minutes. The static
// maps below are fallbacks used when no API key is configured or a fetch fails.
//
// Each model entry may carry a `reasoning` object describing thinking/effort
// support so the UI can render an effort selector only for models that support
// it, and providers can send the right API parameters:
//   reasoning: {
//     supported: true,
//     mode: 'adaptive' | 'budget' | 'effort',
//     efforts: ['none', 'low', 'medium', 'high', ...],
//   }

const https = require('https');

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Effort levels Anthropic's Models API reports under capabilities.effort
const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Static fallbacks (used when the provider API can't be reached)
const ANTHROPIC_MODELS = {
  'claude-haiku-4-5': {
    displayName: 'Claude Haiku 4.5',
    context: 200000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'anthropic',
    max_tokens_default: 8192,
    reasoning: { supported: true, mode: 'budget', efforts: ['none', 'low', 'medium', 'high'] },
  },
  'claude-sonnet-4-6': {
    displayName: 'Claude Sonnet 4.6',
    context: 200000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'anthropic',
    max_tokens_default: 64000,
    reasoning: { supported: true, mode: 'adaptive', efforts: ['none', 'low', 'medium', 'high', 'max'] },
  },
};

const OPENAI_MODELS = {
  'gpt-5.4': {
    displayName: 'GPT-5.4',
    context: 1000000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.4-mini': {
    displayName: 'GPT-5.4 Mini',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
    reasoning: { supported: true, mode: 'effort', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.4-nano': {
    displayName: 'GPT-5.4 Nano',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
    reasoning: { supported: true, mode: 'effort', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
};

// Models served by the ChatGPT backend when signed in with a ChatGPT
// subscription (OAuth). Namespaced with a 'chatgpt:' prefix so they can sit in
// the picker alongside the API-key models; the provider strips the prefix
// before calling the backend. The backend has no /v1/models, so this list is
// static.
const CHATGPT_MODEL_PREFIX = 'chatgpt:';
const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_CLIENT_VERSION = '0.143.0'; // codex CLI version we present as

// Static fallback when the live catalog can't be fetched (values verified
// against the live /models response, July 2026). The real list comes from
// fetchChatgptModels below — the same catalog endpoint the Codex CLI uses.
const CHATGPT_MODELS = {
  'chatgpt:gpt-5.5': {
    displayName: 'GPT-5.5 (ChatGPT)',
    context: 272000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  'chatgpt:gpt-5.4': {
    displayName: 'GPT-5.4 (ChatGPT)',
    context: 272000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  'chatgpt:gpt-5.4-mini': {
    displayName: 'GPT-5.4 Mini (ChatGPT)',
    context: 272000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  'chatgpt:gpt-5.3-codex-spark': {
    displayName: 'GPT-5.3 Codex Spark (ChatGPT)',
    context: 128000,
    vision_supported: false, // text-only research preview
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
};

/**
 * Fetch the live model catalog served to Codex clients signed in with a
 * ChatGPT subscription: GET {codex backend}/models?client_version=X with the
 * same auth headers as /responses. Returns { 'chatgpt:<slug>': config }.
 */
async function fetchChatgptModels({ token, accountId }) {
  const response = await fetch(
    `${CHATGPT_CODEX_BASE_URL}/models?client_version=${CHATGPT_CLIENT_VERSION}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        originator: 'codex_cli_rs',
        'User-Agent': `codex_cli_rs/${CHATGPT_CLIENT_VERSION}`,
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
    }
  );
  if (!response.ok) {
    throw new Error(`ChatGPT models fetch failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const models = {};
  for (const model of data.models || []) {
    if (!model.slug) continue;
    if (model.visibility && model.visibility !== 'list') continue; // internal/hidden
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((level) => (typeof level === 'string' ? level : level.effort))
          .filter(Boolean)
      : [];
    models[`${CHATGPT_MODEL_PREFIX}${model.slug}`] = {
      displayName: `${model.display_name || model.slug} (ChatGPT)`,
      context: model.context_window || 272000,
      vision_supported: true,
      builtin_tools_supported: false,
      provider: 'openai',
      max_tokens_default: 32768,
      ...(efforts.length > 0
        ? { reasoning: { supported: true, mode: 'effort', efforts } }
        : {}),
    };
  }
  if (Object.keys(models).length === 0) {
    throw new Error('ChatGPT models list came back empty');
  }
  return models;
}

// Local OpenAI-compatible LLM server (LM Studio, Ollama, mlx_lm.server, …).
// Its own base-URL slot so it works ALONGSIDE Groq instead of replacing the
// Groq endpoint like customApiBaseUrl does. Models are namespaced 'local:' and
// served through the Groq chat-completions path with the local base URL.
const LOCAL_MODEL_PREFIX = 'local:';

async function fetchLocalLlmModels(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: apiKey && apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Local model server returned HTTP ${response.status}`);
  }
  const json = await response.json();
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const models = {};
  for (const m of list) {
    const id = typeof m === 'string' ? m : m?.id;
    if (!id) continue;
    models[`${LOCAL_MODEL_PREFIX}${id}`] = {
      displayName: `${id} (Local)`,
      context: 32768, // /v1/models doesn't report context; override via Custom Models if needed
      vision_supported: false,
      builtin_tools_supported: false,
      provider: 'local',
      max_tokens_default: 8192,
      reasoning: null,
    };
  }
  if (Object.keys(models).length === 0) {
    throw new Error('Local model server returned no models');
  }
  console.log(`[ProviderModels] Loaded ${Object.keys(models).length} models from local server`);
  return models;
}

async function getLocalLlmModels(settings) {
  const baseUrl = (settings.localLlmBaseUrl || '').trim();
  if (!settings.localLlmEnabled || !baseUrl) return {};

  const cache = providerCaches.localLlm;
  const now = Date.now();
  if (cache.models && cache.key === baseUrl && now - cache.ts < CACHE_DURATION) {
    return cache.models;
  }
  try {
    cache.models = await fetchLocalLlmModels(baseUrl, settings.localLlmApiKey);
    cache.ts = now;
    cache.key = baseUrl;
    return cache.models;
  } catch (err) {
    console.error('[ProviderModels] Failed to fetch local LLM models:', err.message);
    return cache.key === baseUrl && cache.models ? cache.models : {};
  }
}

function isValidKey(key) {
  return (
    typeof key === 'string' &&
    key.trim() !== '' &&
    !key.includes('<replace me>') &&
    !key.startsWith('your_')
  );
}

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`API returned status ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Anthropic — GET /v1/models returns per-model capabilities (context window,
// output cap, vision, thinking modes, supported effort levels), so everything
// is derived from the API rather than hardcoded.
// ---------------------------------------------------------------------------

function mapAnthropicModel(m) {
  const caps = m.capabilities || {};
  const thinkingTypes = (caps.thinking && caps.thinking.types) || {};
  const adaptive = !!(thinkingTypes.adaptive && thinkingTypes.adaptive.supported);
  const budget = !!(thinkingTypes.enabled && thinkingTypes.enabled.supported);
  // Thinking can be turned off unless the API explicitly says otherwise
  // (e.g. models where thinking is always on reject {type: 'disabled'})
  const disabledOk = !(thinkingTypes.disabled && thinkingTypes.disabled.supported === false);

  const effortCaps = caps.effort || {};
  const apiEfforts = ANTHROPIC_EFFORT_LEVELS.filter(
    (level) => effortCaps[level] && effortCaps[level].supported
  );

  let reasoning = null;
  if (adaptive || budget) {
    let efforts = adaptive && apiEfforts.length ? apiEfforts : ['low', 'medium', 'high'];
    if (disabledOk) {
      efforts = ['none', ...efforts];
    }
    reasoning = { supported: true, mode: adaptive ? 'adaptive' : 'budget', efforts };
  }

  return {
    displayName: m.display_name || m.id,
    context: m.max_input_tokens || 200000,
    max_tokens_default: Math.min(m.max_tokens || 8192, 64000),
    vision_supported: caps.image_input ? !!caps.image_input.supported : true,
    builtin_tools_supported: false,
    provider: 'anthropic',
    reasoning,
  };
}

async function fetchAnthropicModels(apiKey) {
  const json = await httpsGetJson('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  });
  if (!json?.data || !Array.isArray(json.data)) {
    throw new Error('Invalid Anthropic models API response');
  }
  const models = {};
  json.data.forEach((m) => {
    models[m.id] = mapAnthropicModel(m);
  });
  console.log(`[ProviderModels] Loaded ${json.data.length} Anthropic models from API`);
  return models;
}

// ---------------------------------------------------------------------------
// OpenAI — GET /v1/models only returns IDs, so capabilities are inferred from
// the model family. Reasoning effort support (per OpenAI docs): `none` from
// gpt-5.1 onward, `xhigh` from gpt-5.2 onward, gpt-5-pro is high-only,
// pre-5.1 gpt-5 models use minimal..high, o-series use low..high.
// ---------------------------------------------------------------------------

const OPENAI_EXCLUDE_PATTERNS = [
  'embedding', 'whisper', 'tts', 'dall-e', 'davinci', 'babbage', 'audio',
  'realtime', 'image', 'moderation', 'transcribe', '-search', 'instruct',
  'computer-use', 'deep-research', 'sora', 'codex',
];

function isOpenAIChatModel(id) {
  const lower = id.toLowerCase();
  if (!/^(gpt-|chatgpt-|o\d)/.test(lower)) return false;
  if (OPENAI_EXCLUDE_PATTERNS.some((p) => lower.includes(p))) return false;
  // Skip dated snapshots (e.g. gpt-4o-2024-08-06) — keep the alias ids
  if (/-\d{4}-\d{2}-\d{2}$/.test(lower) || /-\d{4}$/.test(lower)) return false;
  return true;
}

function openAIEffortsForModel(id) {
  if (/^o\d/.test(id)) return ['low', 'medium', 'high'];
  if (!id.startsWith('gpt-5')) return null;
  if (id.includes('chat')) return null; // gpt-5-chat-latest is non-reasoning
  const minorMatch = id.match(/^gpt-5\.(\d+)/);
  const minor = minorMatch ? parseInt(minorMatch[1], 10) : 0;
  if (id.includes('-pro')) {
    // Pro models run at high effort only (xhigh available from gpt-5.2 on)
    return minor >= 2 ? ['high', 'xhigh'] : ['high'];
  }
  if (minor >= 2) return ['none', 'low', 'medium', 'high', 'xhigh'];
  if (minor === 1) return ['none', 'low', 'medium', 'high']; // gpt-5.1
  return ['minimal', 'low', 'medium', 'high']; // gpt-5, gpt-5-mini (pre-5.1)
}

function openAIContextForModel(id) {
  if (id.startsWith('gpt-5')) {
    return id.includes('mini') || id.includes('nano') ? 400000 : 1000000;
  }
  if (id.startsWith('gpt-4.1')) return 1000000;
  if (/^o[34]/.test(id)) return 200000;
  return 128000;
}

function openAIVisionForModel(id) {
  return (
    id.startsWith('gpt-5') || id.startsWith('gpt-4o') || id.startsWith('gpt-4.1') ||
    id.startsWith('chatgpt-') || /^o[34]/.test(id)
  );
}

function prettifyOpenAIModelId(id) {
  const name = id
    .split('-')
    .map((part) => {
      if (/^gpt/i.test(part)) return part.toUpperCase();
      if (/^o\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
  return name.replace(/^GPT (\d)/, 'GPT-$1').replace(/^CHATGPT/, 'ChatGPT');
}

function mapOpenAIModel(id) {
  const efforts = openAIEffortsForModel(id);
  return {
    displayName: prettifyOpenAIModelId(id),
    context: openAIContextForModel(id),
    max_tokens_default: 16384,
    vision_supported: openAIVisionForModel(id),
    builtin_tools_supported: false,
    provider: 'openai',
    reasoning: efforts ? { supported: true, mode: 'effort', efforts } : null,
  };
}

async function fetchOpenAIModels(apiKey) {
  const json = await httpsGetJson('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });
  if (!json?.data || !Array.isArray(json.data)) {
    throw new Error('Invalid OpenAI models API response');
  }
  const models = {};
  json.data
    .filter((m) => isOpenAIChatModel(m.id))
    .forEach((m) => {
      models[m.id] = mapOpenAIModel(m.id);
    });
  console.log(`[ProviderModels] Loaded ${Object.keys(models).length} OpenAI chat models from API`);
  return models;
}

// ---------------------------------------------------------------------------
// Audio models (STT whisper + TTS) — fetched live from each provider's models
// API, same as the chat models. Static lists below are offline fallbacks only.
// ---------------------------------------------------------------------------

const AUDIO_FALLBACKS = {
  sttGroq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
  sttOpenai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  ttsOpenai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  sttLocal: [
    'mlx-community/whisper-large-v3-turbo',
    'mlx-community/whisper-large-v3-mlx',
    'mlx-community/whisper-medium-mlx',
    'mlx-community/whisper-small-mlx',
    'mlx-community/whisper-base-mlx',
    'mlx-community/whisper-tiny',
  ],
};

// The speech API has no voices endpoint; this is the documented voice set.
const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse',
];

async function fetchGroqAudioModels(apiKey) {
  const json = await httpsGetJson('https://api.groq.com/openai/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });
  const ids = (json?.data || [])
    .map((m) => m.id)
    .filter((id) => id.toLowerCase().includes('whisper'))
    .sort();
  if (ids.length === 0) throw new Error('no whisper models in Groq response');
  console.log(`[ProviderModels] Loaded ${ids.length} Groq whisper models from API`);
  return ids;
}

async function fetchOpenAIAudioModels(apiKey) {
  const json = await httpsGetJson('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });
  const ids = (json?.data || []).map((m) => m.id);
  const stt = ids
    .filter((id) => /whisper|transcribe/i.test(id) && !/realtime/i.test(id))
    .sort();
  const tts = ids.filter((id) => /tts/i.test(id) && !/realtime/i.test(id)).sort();
  if (stt.length === 0 && tts.length === 0) {
    throw new Error('no audio models in OpenAI response');
  }
  console.log(`[ProviderModels] Loaded ${stt.length} OpenAI STT + ${tts.length} TTS models from API`);
  return { stt, tts };
}

// Local whisper catalog: everything mlx-whisper can run, straight from the
// mlx-community org on HuggingFace, most-downloaded first.
async function fetchLocalWhisperModels() {
  const json = await httpsGetJson(
    'https://huggingface.co/api/models?author=mlx-community&search=whisper&sort=downloads&direction=-1&limit=50',
    { 'User-Agent': 'groq-desktop' }
  );
  const ids = (Array.isArray(json) ? json : [])
    .map((m) => m.id)
    .filter((id) => id && id.toLowerCase().includes('whisper'));
  if (ids.length === 0) throw new Error('empty HuggingFace model list');
  console.log(`[ProviderModels] Loaded ${ids.length} mlx-community whisper models from HuggingFace`);
  return ids;
}

// Exact download size for a local model, straight from the HuggingFace tree
// API (sums the real file sizes — repo usedStorage overcounts). Cached per id.
const localModelInfoCache = new Map();

async function fetchLocalModelInfo(modelId) {
  if (localModelInfoCache.has(modelId)) return localModelInfoCache.get(modelId);
  const files = await httpsGetJson(
    `https://huggingface.co/api/models/${modelId}/tree/main`,
    { 'User-Agent': 'groq-desktop' }
  );
  const sizeBytes = (Array.isArray(files) ? files : []).reduce(
    (sum, f) => sum + (f && typeof f.size === 'number' ? f.size : 0),
    0
  );
  const info = { sizeBytes };
  localModelInfoCache.set(modelId, info);
  return info;
}

async function getCachedAudioList(cacheKey, fetcher, fallback) {
  const cache = providerCaches[cacheKey];
  const now = Date.now();
  if (cache.models && now - cache.ts < CACHE_DURATION) return cache.models;
  try {
    cache.models = await fetcher();
    cache.ts = now;
    return cache.models;
  } catch (err) {
    console.error(`[ProviderModels] Failed to fetch ${cacheKey} models:`, err.message);
    return cache.models || fallback;
  }
}

/**
 * Model choices for the Settings STT/TTS pickers, fetched live per provider
 * (Groq + OpenAI need their API key; the local list needs no key).
 */
async function getAudioModels(settings = {}) {
  const openaiFallback = { stt: AUDIO_FALLBACKS.sttOpenai, tts: AUDIO_FALLBACKS.ttsOpenai };
  const [sttGroq, openaiAudio, sttLocal] = await Promise.all([
    isValidKey(settings.GROQ_API_KEY)
      ? getCachedAudioList('sttGroq', () => fetchGroqAudioModels(settings.GROQ_API_KEY), AUDIO_FALLBACKS.sttGroq)
      : Promise.resolve(AUDIO_FALLBACKS.sttGroq),
    isValidKey(settings.OPENAI_API_KEY)
      ? getCachedAudioList('openaiAudio', () => fetchOpenAIAudioModels(settings.OPENAI_API_KEY), openaiFallback)
      : Promise.resolve(openaiFallback),
    getCachedAudioList('sttLocal', fetchLocalWhisperModels, AUDIO_FALLBACKS.sttLocal),
  ]);
  return {
    stt: { groq: sttGroq, openai: openaiAudio.stt, local: sttLocal },
    tts: { openai: openaiAudio.tts, voices: OPENAI_TTS_VOICES },
  };
}

// ---------------------------------------------------------------------------
// Caching (same pattern as shared/models.js for Groq)
// ---------------------------------------------------------------------------

const providerCaches = {
  anthropic: { models: null, ts: 0 },
  openai: { models: null, ts: 0 },
  chatgpt: { models: null, ts: 0 },
  localLlm: { models: null, ts: 0, key: null },
  sttGroq: { models: null, ts: 0 },
  openaiAudio: { models: null, ts: 0 },
  sttLocal: { models: null, ts: 0 },
};

// Live ChatGPT subscription catalog with cache; static fallback when the
// access token is missing/expired or the fetch fails.
async function getChatgptModels(settings) {
  const signedIn = !!(settings.chatgptRefreshToken && settings.chatgptRefreshToken.trim());
  if (!signedIn) return {};

  const cache = providerCaches.chatgpt;
  const now = Date.now();
  if (cache.models && now - cache.ts < CACHE_DURATION) {
    return cache.models;
  }

  const tokenFresh =
    settings.chatgptAccessToken && (settings.chatgptTokenExpiresAt || 0) - now > 60 * 1000;
  if (!tokenFresh) {
    return cache.models || CHATGPT_MODELS;
  }

  try {
    cache.models = await fetchChatgptModels({
      token: settings.chatgptAccessToken,
      accountId: settings.chatgptAccountId,
    });
    cache.ts = now;
    return cache.models;
  } catch (err) {
    console.error('[ProviderModels] Failed to fetch ChatGPT models:', err.message);
    return cache.models || CHATGPT_MODELS;
  }
}

async function getCachedProviderModels(provider, apiKey, fetcher, staticFallback) {
  if (!isValidKey(apiKey)) {
    return staticFallback;
  }

  const cache = providerCaches[provider];
  const now = Date.now();
  if (cache.models && now - cache.ts < CACHE_DURATION) {
    return cache.models;
  }

  try {
    cache.models = await fetcher(apiKey);
    cache.ts = now;
    return cache.models;
  } catch (err) {
    console.error(`[ProviderModels] Failed to fetch ${provider} models:`, err.message);
    // Stale cache beats static fallback
    return cache.models || staticFallback;
  }
}

/**
 * Fetch (with cache) the dynamic model lists for all non-Groq providers,
 * merged into a single { modelId: config } map. Falls back to the static
 * definitions per provider when no key is configured or the fetch fails.
 */
async function getProviderModels(settings = {}) {
  // ChatGPT subscription models (when signed in) are offered in addition to
  // the API-key models — both auth modes work side by side. Same for the
  // local model server: its models sit next to Groq's, not instead of them.
  const [anthropic, openai, chatgpt, localLlm] = await Promise.all([
    getCachedProviderModels('anthropic', settings.ANTHROPIC_API_KEY, fetchAnthropicModels, ANTHROPIC_MODELS),
    getCachedProviderModels('openai', settings.OPENAI_API_KEY, fetchOpenAIModels, OPENAI_MODELS),
    getChatgptModels(settings),
    getLocalLlmModels(settings),
  ]);
  return { ...anthropic, ...openai, ...chatgpt, ...localLlm };
}

/**
 * Determine the provider for a given model ID.
 * Checks static provider models first, then falls back to 'groq'.
 */
function getProviderForModel(modelId, modelContextSizes) {
  if (ANTHROPIC_MODELS[modelId]) return 'anthropic';
  if (OPENAI_MODELS[modelId]) return 'openai';
  if (modelId && modelId.startsWith(CHATGPT_MODEL_PREFIX)) return 'openai';
  // Local server speaks OpenAI chat-completions — served by the Groq path
  // with the local base URL swapped in (see chatHandler).
  if (modelId && modelId.startsWith(LOCAL_MODEL_PREFIX)) return 'groq';

  // Check if the model in modelContextSizes has a provider field
  const modelInfo = modelContextSizes && modelContextSizes[modelId];
  if (modelInfo && modelInfo.provider) return modelInfo.provider;

  return 'groq';
}

module.exports = {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  CHATGPT_MODELS,
  CHATGPT_MODEL_PREFIX,
  LOCAL_MODEL_PREFIX,
  getProviderModels,
  getProviderForModel,
  getAudioModels,
  fetchLocalModelInfo,
};
