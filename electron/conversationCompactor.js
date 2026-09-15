const { completeText } = require('./titleGenerator');

// Conversation compaction: the chat's own model writes a summary that stands
// in for everything said so far, freeing the context window. The renderer
// keeps the original messages on screen and sends only the summary onward.

const COMPACT_SYSTEM_PROMPT =
  'You compact long conversations between a user and an AI assistant. Your summary replaces the original messages, so the assistant must be able to continue the conversation from it alone, without losing anything that matters. Write in the language of the conversation.';

const DEFAULT_CONTEXT_WINDOW = 1000000;
const SUMMARY_MAX_TOKENS = 8192;

function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image_url') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
}

/** Plain-text transcript, newest part kept when it has to be cut. */
function transcriptOf(messages, maxChars) {
  const blocks = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'tool') {
      blocks.push(`[Tool result${message.name ? ` (${message.name})` : ''}]\n${clip(partsText(message.content), 4000)}`);
      continue;
    }
    const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'Note';
    let body = partsText(message.content).trim();
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map((call) => {
        const name = call?.function?.name || call?.name || 'tool';
        const args = call?.function?.arguments ?? call?.arguments ?? '';
        return `[Tool call: ${name}(${clip(typeof args === 'string' ? args : JSON.stringify(args), 1500)})]`;
      });
      body = [body, ...calls].filter(Boolean).join('\n');
    }
    if (body) blocks.push(`${who}:\n${body}`);
  }
  let out = blocks.join('\n\n');
  if (out.length > maxChars) {
    out = `[The earliest part of the conversation did not fit and is omitted]\n\n${out.slice(out.length - maxChars)}`;
  }
  return out;
}

function compactPrompt(transcript, instructions) {
  const focus = instructions && instructions.trim()
    ? `\n\nThe user asked for this focus when compacting: ${instructions.trim()}`
    : '';
  return `Here is the conversation so far:\n\n<conversation>\n${transcript}\n</conversation>\n\nWrite the summary that will replace it. Cover, under short markdown headings:\n1. The user's goals and requests, keeping any exact constraints or preferences they stated.\n2. Key facts, decisions and conclusions reached.\n3. Specifics that must not be lost: names, numbers, code, file paths, commands, URLs and error messages.\n4. What has been done so far and the current state.\n5. Open questions and the next steps.\nBe complete but concise. Output only the summary.${focus}`;
}

/**
 * @param {object} args
 * @param {Array} args.messages - what the model currently sees (earlier summary included)
 * @param {string} args.model - the chat's model id
 * @param {string} [args.instructions] - optional focus from "/compact <instructions>"
 * @param {number} [args.contextWindow] - tokens; bounds how much transcript is sent
 * @returns {Promise<string>} the summary
 */
async function compactConversation({ messages, model, settings, modelContextSizes, createGroqClient, instructions, contextWindow }) {
  const windowTokens = Number(contextWindow) > 0 ? Number(contextWindow) : DEFAULT_CONTEXT_WINDOW;
  // About 3 characters per token, leaving room for the prompt and the summary
  const maxChars = Math.max(40000, Math.floor(windowTokens * 0.7) * 3);
  const transcript = transcriptOf(messages, maxChars);
  if (!transcript.trim()) throw new Error('Nothing to compact');
  const raw = await completeText({
    system: COMPACT_SYSTEM_PROMPT,
    prompt: compactPrompt(transcript, instructions),
    model,
    settings,
    modelContextSizes,
    createGroqClient,
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: 0.2,
  });
  const summary = String(raw || '').trim();
  if (!summary) throw new Error(`${model} returned an empty summary`);
  return summary;
}

module.exports = { compactConversation, transcriptOf };
