const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const {
  getProviderForModel,
  CHATGPT_MODEL_PREFIX,
  LOCAL_MODEL_PREFIX,
} = require('../shared/providerModels');
const chatgptAuthManager = require('./chatgptAuthManager');

// Chat titles are produced by whatever model the chat itself runs on, through
// the same provider transport. No separate hardcoded "small" model: Groq
// retired llama-3.1-8b-instant and every title silently fell back to
// "New Chat", which is exactly the failure a pinned catalog invites.

const TITLE_SYSTEM_PROMPT =
  'You generate short, concise titles for chat conversations. Reply with a title of 3-6 words that summarizes the topic or question. No quotes, no trailing punctuation, no preamble. Output only the title.';

const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const MAX_TITLE_LENGTH = 50;
const MAX_INPUT_CHARS = 500;

/** Plain text of a user message that may be a content-part array. */
function messageText(userMessage) {
  if (typeof userMessage === 'string') return userMessage;
  if (Array.isArray(userMessage)) {
    return userMessage
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  if (userMessage && typeof userMessage === 'object') {
    try {
      return JSON.stringify(userMessage);
    } catch {
      return '';
    }
  }
  return '';
}

/** Tidy raw model output into a title, or '' when nothing usable came back. */
function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/^Title:\s*/i, '')
    .replace(/[.。!]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * Title derived from the message itself, used when no provider call can be
 * made (missing key, server down, empty output). Keeps chats identifiable
 * instead of leaving a wall of "New Chat".
 */
function fallbackTitle(text) {
  const words = (text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return 'New Chat';
  let title = words.slice(0, 6).join(' ');
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH - 1) + '…';
  return title;
}

/** Cheapest reasoning effort a model advertises, or null when it has none. */
function lowestEffort(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return null;
  for (const candidate of ['none', 'minimal', 'low']) {
    if (efforts.includes(candidate)) return candidate;
  }
  return efforts[0];
}

function userPrompt(text) {
  return `Generate a short title for a conversation that starts with this message:\n\n${text}`;
}

async function titleWithAnthropic(text, model, settings, modelInfo) {
  if (!settings.ANTHROPIC_API_KEY || !settings.ANTHROPIC_API_KEY.trim()) {
    throw new Error('Anthropic API key not configured');
  }
  const client = new Anthropic({ apiKey: settings.ANTHROPIC_API_KEY });
  const params = {
    model,
    max_tokens: 512,
    system: TITLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt(text) }],
  };
  // Adaptive-thinking models: ask for the lightest effort they support.
  // Everything else: omit thinking entirely (accepted by every model).
  const reasoning = modelInfo?.reasoning;
  if (reasoning && reasoning.mode === 'adaptive') {
    params.thinking = { type: 'adaptive' };
    const effort = lowestEffort(reasoning.efforts);
    if (effort && effort !== 'none') params.output_config = { effort };
  }
  const response = await client.messages.create(params);
  return (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function titleWithOpenAI(text, model, settings, modelInfo) {
  const useChatGpt = model.startsWith(CHATGPT_MODEL_PREFIX);
  const apiModel = useChatGpt ? model.slice(CHATGPT_MODEL_PREFIX.length) : model;
  let client;
  if (useChatGpt) {
    if (!chatgptAuthManager.isSignedIn(settings)) {
      throw new Error('ChatGPT subscription not signed in');
    }
    const { token, accountId } = await chatgptAuthManager.getValidAccessToken(settings);
    client = new OpenAI({
      apiKey: token,
      baseURL: CHATGPT_CODEX_BASE_URL,
      defaultHeaders: {
        originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.136.0',
        ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      },
    });
  } else {
    if (!settings.OPENAI_API_KEY || !settings.OPENAI_API_KEY.trim()) {
      throw new Error('OpenAI API key not configured');
    }
    client = new OpenAI({ apiKey: settings.OPENAI_API_KEY });
  }

  const params = {
    model: apiModel,
    input: [{ role: 'user', content: userPrompt(text) }],
    instructions: TITLE_SYSTEM_PROMPT,
    store: false,
  };
  const effort = lowestEffort(modelInfo?.reasoning?.efforts);
  if (effort && effort !== 'none') {
    params.reasoning = { effort, summary: 'auto' };
  }

  // The ChatGPT backend only serves streamed responses; collect the deltas.
  if (useChatGpt) {
    const stream = await client.responses.create({ ...params, stream: true });
    let output = '';
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta' && event.delta) output += event.delta;
    }
    return output;
  }
  const response = await client.responses.create(params);
  return response.output_text || '';
}

async function titleWithGroqCompatible(text, model, settings, modelInfo, createGroqClient) {
  const groq = createGroqClient(model, settings);
  const isLocalModel = model.startsWith(LOCAL_MODEL_PREFIX);
  const params = {
    model: isLocalModel ? model.slice(LOCAL_MODEL_PREFIX.length) : model,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(text) },
    ],
    temperature: 0.3,
    // Reasoning models spend part of this budget thinking before the title
    max_tokens: 512,
    stream: false,
  };
  const effort = lowestEffort(modelInfo?.reasoning?.efforts);
  if (effort) params.reasoning_effort = effort;
  const response = await groq.chat.completions.create(params);
  return response.choices?.[0]?.message?.content || '';
}

/**
 * Generate a chat title from its first user message.
 * @param {object} args
 * @param {string|Array} args.userMessage - first user message (string or content parts)
 * @param {string} args.model - the chat's model id (decides provider + transport)
 * @param {object} args.settings - app settings (keys, base URLs)
 * @param {object} args.modelContextSizes - merged model catalog (reasoning info)
 * @param {Function} args.createGroqClient - (model, settings) => Groq SDK client
 * @returns {Promise<string>} a title; never throws, never returns empty
 */
async function generateTitle({ userMessage, model, settings, modelContextSizes, createGroqClient }) {
  const text = messageText(userMessage).trim().slice(0, MAX_INPUT_CHARS);
  if (!text) return 'New Chat';
  if (!model || typeof model !== 'string') return fallbackTitle(text);

  const catalog = modelContextSizes || {};
  const provider = getProviderForModel(model, catalog);
  const modelInfo = catalog[model] || {};

  try {
    let raw;
    if (provider === 'anthropic') {
      raw = await titleWithAnthropic(text, model, settings, modelInfo);
    } else if (provider === 'openai') {
      raw = await titleWithOpenAI(text, model, settings, modelInfo);
    } else {
      raw = await titleWithGroqCompatible(text, model, settings, modelInfo, createGroqClient);
    }
    const title = cleanTitle(raw);
    if (title) return title;
    console.warn(`[TitleGenerator] ${model} returned no usable title, using message text`);
  } catch (error) {
    console.error(`[TitleGenerator] ${model} title request failed:`, error.message || error);
  }
  return fallbackTitle(text);
}

module.exports = { generateTitle, cleanTitle, fallbackTitle, messageText };
