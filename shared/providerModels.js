// Static model definitions for non-Groq providers

const ANTHROPIC_MODELS = {
  'claude-haiku-4-5': {
    displayName: 'Claude Haiku 4.5',
    context: 200000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'anthropic',
    max_tokens_default: 8192,
  },
  'claude-sonnet-4-6': {
    displayName: 'Claude Sonnet 4.6',
    context: 200000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'anthropic',
    max_tokens_default: 64000,
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
  },
  'gpt-5.4-mini': {
    displayName: 'GPT-5.4 Mini',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
  },
  'gpt-5.4-nano': {
    displayName: 'GPT-5.4 Nano',
    context: 400000,
    vision_supported: true,
    builtin_tools_supported: false,
    provider: 'openai',
    max_tokens_default: 16384,
  },
};

/**
 * Determine the provider for a given model ID.
 * Checks static provider models first, then falls back to 'groq'.
 */
function getProviderForModel(modelId, modelContextSizes) {
  if (ANTHROPIC_MODELS[modelId]) return 'anthropic';
  if (OPENAI_MODELS[modelId]) return 'openai';

  // Check if the model in modelContextSizes has a provider field
  const modelInfo = modelContextSizes && modelContextSizes[modelId];
  if (modelInfo && modelInfo.provider) return modelInfo.provider;

  return 'groq';
}

module.exports = {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  getProviderForModel,
};
