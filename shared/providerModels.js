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
// subscription (OAuth) instead of an API key. The backend has no /v1/models,
// so this list is static. Codex-only models 400 on API-key auth and vice
// versa for some API-only models — keep the lists separate.
const CHATGPT_MODELS = {
  'gpt-5.4': {
    displayName: 'GPT-5.4 (ChatGPT)',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.4-codex': {
    displayName: 'GPT-5.4 Codex (ChatGPT)',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.3-codex': {
    displayName: 'GPT-5.3 Codex (ChatGPT)',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 32768,
    reasoning: { supported: true, mode: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
};

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
// Caching (same pattern as shared/models.js for Groq)
// ---------------------------------------------------------------------------

const providerCaches = {
  anthropic: { models: null, ts: 0 },
  openai: { models: null, ts: 0 },
};

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
  // Signed in with a ChatGPT subscription: the ChatGPT backend serves a fixed
  // model set and has no /v1/models endpoint — skip the API-key fetch.
  const chatgptSignedIn = !!(settings.chatgptRefreshToken && settings.chatgptRefreshToken.trim());
  const [anthropic, openai] = await Promise.all([
    getCachedProviderModels('anthropic', settings.ANTHROPIC_API_KEY, fetchAnthropicModels, ANTHROPIC_MODELS),
    chatgptSignedIn
      ? Promise.resolve(CHATGPT_MODELS)
      : getCachedProviderModels('openai', settings.OPENAI_API_KEY, fetchOpenAIModels, OPENAI_MODELS),
  ]);
  return { ...anthropic, ...openai };
}

/**
 * Determine the provider for a given model ID.
 * Checks static provider models first, then falls back to 'groq'.
 */
function getProviderForModel(modelId, modelContextSizes) {
  if (ANTHROPIC_MODELS[modelId]) return 'anthropic';
  if (OPENAI_MODELS[modelId]) return 'openai';
  if (CHATGPT_MODELS[modelId]) return 'openai';

  // Check if the model in modelContextSizes has a provider field
  const modelInfo = modelContextSizes && modelContextSizes[modelId];
  if (modelInfo && modelInfo.provider) return modelInfo.provider;

  return 'groq';
}

module.exports = {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  CHATGPT_MODELS,
  getProviderModels,
  getProviderForModel,
};
