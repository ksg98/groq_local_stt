const Anthropic = require('@anthropic-ai/sdk');

// Budget tokens for each reasoning level
const REASONING_BUDGETS = {
  low: 1024,
  medium: 4096,
  high: 16000,
};

function validateApiKey(settings) {
  if (!settings.ANTHROPIC_API_KEY || settings.ANTHROPIC_API_KEY.trim() === '') {
    throw new Error(
      'Anthropic API key not configured. Please add your Anthropic API key in Settings.'
    );
  }
}

/**
 * Convert chat messages to Anthropic format.
 * Extracts system messages to a top-level param, converts image_url blocks, etc.
 */
function convertMessages(messages) {
  let systemPrompt = undefined;
  const converted = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      continue;
    }

    // Skip tool result messages — handled inline with assistant tool_use
    if (msg.role === 'tool') {
      continue;
    }

    if (msg.role === 'assistant') {
      // Handle assistant messages with tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks = [];

        // Add text content if present
        const textContent =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((p) => p.text || '').join('')
              : '';
        if (textContent) {
          contentBlocks.push({ type: 'text', text: textContent });
        }

        // Convert tool_calls to tool_use blocks
        for (const tc of msg.tool_calls) {
          let args = tc.function.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: args || {},
          });
        }

        converted.push({ role: 'assistant', content: contentBlocks });

        // Now find matching tool results in messages and add as tool_result
        const toolResults = [];
        for (const tc of msg.tool_calls) {
          const resultMsg = messages.find(
            (m) => m.role === 'tool' && m.tool_call_id === tc.id
          );
          if (resultMsg) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content:
                typeof resultMsg.content === 'string'
                  ? resultMsg.content
                  : JSON.stringify(resultMsg.content),
            });
          }
        }
        if (toolResults.length > 0) {
          converted.push({ role: 'user', content: toolResults });
        }
        continue;
      }

      // Plain assistant message
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p) => p.text || '').join('')
            : JSON.stringify(msg.content);
      if (text) {
        converted.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (msg.role === 'user') {
      // Handle multimodal content (images)
      if (Array.isArray(msg.content)) {
        const contentBlocks = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            contentBlocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url' && part.image_url) {
            // Convert OpenAI image_url format to Anthropic image format
            const url = part.image_url.url || part.image_url;
            if (url.startsWith('data:')) {
              // Base64 data URL
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2],
                  },
                });
              }
            } else {
              // URL-based image
              contentBlocks.push({
                type: 'image',
                source: { type: 'url', url: url },
              });
            }
          }
        }
        converted.push({ role: 'user', content: contentBlocks });
      } else {
        converted.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
      continue;
    }
  }

  return { systemPrompt, messages: converted };
}

/**
 * Convert discovered MCP tools to Anthropic tool format
 */
function convertTools(discoveredTools) {
  if (!discoveredTools || discoveredTools.length === 0) return [];

  return discoveredTools.map((tool) => {
    // Handle tools that are already in { type: 'function', function: {...} } format
    const fn = tool.function || tool;
    const schema = fn.parameters || fn.input_schema || {};

    return {
      name: fn.name || tool.name,
      description: fn.description || tool.description || '',
      input_schema: {
        type: schema.type || 'object',
        properties: schema.properties || {},
        required: schema.required || [],
      },
    };
  });
}

/**
 * Handle streaming for Anthropic/Claude models
 */
async function handleStream(
  event,
  messages,
  model,
  settings,
  modelContextSizes,
  discoveredTools,
  { activeStreams, streamsBySender, cleanupStream }
) {
  const senderId = event.sender.id;

  // Cancel existing stream from this sender
  const existingStreamId = streamsBySender.get(senderId);
  if (existingStreamId) {
    console.log(
      `[AnthropicProvider] Cancelling existing stream ${existingStreamId} for sender ${senderId}`
    );
    const existingStream = activeStreams.get(existingStreamId);
    if (existingStream) {
      existingStream.cancelled = true;
    }
    cleanupStream(existingStreamId);
  }

  const streamId = `stream_anthropic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  streamsBySender.set(senderId, streamId);

  try {
    activeStreams.set(streamId, {
      cancelled: false,
      stream: null,
      event: event,
      summaryInterval: null,
    });

    validateApiKey(settings);

    const client = new Anthropic({ apiKey: settings.ANTHROPIC_API_KEY });
    const { systemPrompt: extractedSystemPrompt, messages: anthropicMessages } = convertMessages(messages);
    const tools = convertTools(discoveredTools);

    const modelInfo = modelContextSizes[model] || modelContextSizes['default'] || {};
    const maxTokens = modelInfo.max_tokens_default || 8192;

    // Build system prompt (same pattern as Groq chatHandler)
    const dateTimeString = new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'long', hour12: false
    });
    let systemPrompt = `You are a helpful assistant capable of using tools. Use tools only when necessary and relevant to the user's request. Format responses using Markdown.\n\nCurrent date and time: ${dateTimeString}`;
    if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
      systemPrompt += `\n\n${settings.customSystemPrompt.trim()}`;
    }
    // Also include any system message extracted from the chat messages
    if (extractedSystemPrompt) {
      systemPrompt += `\n\n${extractedSystemPrompt}`;
    }

    // Build API params
    const params = {
      model: model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      system: systemPrompt,
    };

    if (tools.length > 0) {
      params.tools = tools;
    }

    // Add extended thinking based on reasoning level
    const reasoningLevel = settings.anthropic_reasoning_level || 'medium';
    const budgetTokens = REASONING_BUDGETS[reasoningLevel] || REASONING_BUDGETS.medium;
    params.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };

    // Temperature not compatible with extended thinking
    // params.temperature = settings.temperature || 0.7;

    console.log(`[AnthropicProvider] Starting stream for model ${model}, reasoning: ${reasoningLevel}`);

    event.sender.send('chat-stream-start', {
      id: streamId,
      role: 'assistant',
    });

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const toolCallsMap = new Map();

    const stream = client.messages.stream(params);

    // Store for cancellation
    if (activeStreams.get(streamId)) {
      activeStreams.get(streamId).stream = stream;
    }

    stream.on('text', (text) => {
      if (activeStreams.get(streamId)?.cancelled) {
        stream.abort();
        return;
      }
      accumulatedContent += text;
      event.sender.send('chat-stream-content', { content: text });
    });

    stream.on('thinking', (thinking) => {
      if (activeStreams.get(streamId)?.cancelled) return;
      accumulatedReasoning += thinking;
      event.sender.send('chat-stream-reasoning', {
        reasoning: thinking,
        accumulated: accumulatedReasoning,
      });
    });

    stream.on('contentBlock', (block) => {
      if (activeStreams.get(streamId)?.cancelled) return;

      if (block.type === 'tool_use') {
        const toolCall = {
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          },
        };
        toolCallsMap.set(block.id, toolCall);
        event.sender.send('chat-stream-tool-calls', {
          tool_calls: Array.from(toolCallsMap.values()),
        });
      }
    });

    // Wait for stream to complete
    const finalMessage = await stream.finalMessage();

    if (activeStreams.get(streamId)?.cancelled) {
      cleanupStream(streamId);
      return;
    }

    // Determine finish reason
    let finishReason = 'stop';
    if (finalMessage.stop_reason === 'tool_use') {
      finishReason = 'tool_calls';
    } else if (finalMessage.stop_reason === 'end_turn') {
      finishReason = 'stop';
    } else if (finalMessage.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }

    // Extract usage
    const usage = finalMessage.usage
      ? {
          prompt_tokens: finalMessage.usage.input_tokens,
          completion_tokens: finalMessage.usage.output_tokens,
          total_tokens:
            (finalMessage.usage.input_tokens || 0) + (finalMessage.usage.output_tokens || 0),
        }
      : undefined;

    event.sender.send('chat-stream-complete', {
      content: accumulatedContent,
      role: 'assistant',
      finish_reason: finishReason,
      tool_calls: toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined,
      reasoning: accumulatedReasoning || undefined,
      usage: usage,
    });

    cleanupStream(streamId);
  } catch (error) {
    console.error('[AnthropicProvider] Error:', error);
    cleanupStream(streamId);
    event.sender.send('chat-stream-error', {
      error: error.message || `Anthropic API error: ${error}`,
    });
  }
}

module.exports = { handleStream };
