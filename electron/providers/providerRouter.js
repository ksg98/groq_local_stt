const { getProviderForModel } = require('../../shared/providerModels');
const anthropicProvider = require('./anthropicProvider');
const openaiProvider = require('./openaiProvider');

/**
 * Route a chat stream to the appropriate provider based on the model.
 * Returns true if a non-Groq provider handled the request, false otherwise.
 */
function routeToProvider(
  event,
  messages,
  model,
  settings,
  modelContextSizes,
  discoveredTools,
  streamUtils
) {
  const provider = getProviderForModel(model, modelContextSizes);

  switch (provider) {
    case 'anthropic':
      anthropicProvider.handleStream(
        event,
        messages,
        model,
        settings,
        modelContextSizes,
        discoveredTools,
        streamUtils
      );
      return true;

    case 'openai':
      openaiProvider.handleStream(
        event,
        messages,
        model,
        settings,
        modelContextSizes,
        discoveredTools,
        streamUtils
      );
      return true;

    case 'groq':
    default:
      return false; // Let existing chatHandler logic handle it
  }
}

module.exports = { routeToProvider };
