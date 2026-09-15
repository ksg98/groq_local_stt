// Context window accounting and compaction for chats.
//
// A compaction is stored in the chat as a marker message
// { role: 'system', content: <summary>, compaction: {...} }. The messages
// before it stay on screen, but requests carry only the summary and what
// came after it.

export const DEFAULT_CONTEXT_WINDOW = 1000000;
export const COMPACT_COMMAND = '/compact';
// Below this there is too little conversation for a summary to save anything
export const MIN_COMPACT_TOKENS = 25000;
const IMAGE_TOKENS = 1500; // rough per-image cost; providers differ

export function lastCompactionIndex(messages) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    if (messages[i]?.compaction) return i;
  }
  return -1;
}

function summaryPreamble(summary) {
  return `This conversation was compacted to free up context. Summary of everything before this point:\n\n${summary}\n\n---\n\nThe conversation continues from here.`;
}

// What the model should see: the latest summary stands in for everything before it
export function applyCompaction(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const at = lastCompactionIndex(list);
  if (at === -1) return list;
  const preamble = summaryPreamble(list[at].content || '');
  const rest = list.slice(at + 1);
  const first = rest[0];
  if (first && first.role === 'user') {
    let content;
    if (typeof first.content === 'string') content = `${preamble}\n\n${first.content}`;
    else if (Array.isArray(first.content)) content = [{ type: 'text', text: preamble }, ...first.content];
    else content = preamble;
    return [{ ...first, content }, ...rest.slice(1)];
  }
  return [
    { role: 'user', content: preamble },
    { role: 'assistant', content: 'Understood. I will continue from this summary.' },
    ...rest,
  ];
}

export function estimateMessageTokens(message) {
  if (!message) return 0;
  let chars = 0;
  let images = 0;
  const { content } = message;
  if (typeof content === 'string') chars += content.length;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text') chars += (part.text || '').length;
      else if (part?.type === 'image_url') images += 1;
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      try {
        chars += JSON.stringify(call?.function || call).length;
      } catch {
        /* ignore */
      }
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS + 4;
}

// Tokens the next request will carry. The provider's own count from the last
// reply is used when there is one; anything newer is estimated on top.
export function estimateContextTokens(messages) {
  const view = applyCompaction(messages || []);
  let tokens = 0;
  let from = 0;
  let measured = false;
  for (let i = view.length - 1; i >= 0; i--) {
    const usage = view[i]?.usage;
    if (view[i]?.role === 'assistant' && usage && Number(usage.prompt_tokens) > 0) {
      // Reasoning tokens are not sent back, so the reply counts by its text
      tokens = Number(usage.prompt_tokens) + estimateMessageTokens(view[i]);
      from = i + 1;
      measured = true;
      break;
    }
  }
  for (let i = from; i < view.length; i++) tokens += estimateMessageTokens(view[i]);
  return { tokens, measured };
}

// The model's own window when its provider reports one, otherwise 1M.
// A fixed number in Settings overrides both.
export function resolveContextWindow(model, modelConfigs, setting) {
  const fixed = Number(setting);
  if (setting && setting !== 'auto' && fixed > 0) return fixed;
  const info = modelConfigs?.[model];
  if (info && Number(info.context) > 0 && info.contextReported !== false) return Number(info.context);
  return DEFAULT_CONTEXT_WINDOW;
}

export function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(n >= 1e5 ? 0 : 1))}K`;
  return String(n);
}

// "/compact [instructions]" typed into the chat input, or null
export function parseCompactCommand(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((part) => part?.type === 'image_url')) return null;
    text = content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ');
  } else return null;
  const trimmed = String(text || '').trim();
  if (!/^\/compact(\s|$)/i.test(trimmed)) return null;
  return { instructions: trimmed.slice(COMPACT_COMMAND.length).trim() };
}
