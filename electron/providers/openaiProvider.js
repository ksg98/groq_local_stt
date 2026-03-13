const OpenAI = require('openai');

function validateApiKey(settings) {
  if (!settings.OPENAI_API_KEY || settings.OPENAI_API_KEY.trim() === '') {
    throw new Error(
      'OpenAI API key not configured. Please add your OpenAI API key in Settings.'
    );
  }
}

/**
 * Convert chat messages to OpenAI Responses API `input` format.
 * Similar to handleResponsesApiStream in chatHandler.js for Groq's Responses API.
 */
function convertToResponsesInput(messages) {
  let instructions = undefined;
  const input = [];

  const findToolOutput = (id) =>
    messages.find((m) => m.role === 'tool' && m.tool_call_id === id);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      instructions =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      continue; // Handled via assistant tool_calls
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Add text content if present
      let contentText = '';
      if (typeof msg.content === 'string') {
        contentText = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentText = msg.content.map((p) => p.text || '').join('');
      }

      if (contentText) {
        input.push({ role: 'assistant', content: contentText });
      }

      // Add tool calls and their outputs
      for (const toolCall of msg.tool_calls) {
        const outputMsg = findToolOutput(toolCall.id);
        const outputContent = outputMsg
          ? typeof outputMsg.content === 'string'
            ? outputMsg.content
            : JSON.stringify(outputMsg.content)
          : undefined;

        input.push({
          type: 'function_call',
          id: toolCall.id,
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });

        if (outputContent) {
          input.push({
            type: 'function_call_output',
            call_id: toolCall.id,
            output: outputContent,
          });
        }
      }
      continue;
    }

    // Standard message
    let contentText = '';
    if (typeof msg.content === 'string') {
      contentText = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentText = msg.content.map((p) => p.text || '').join('');
    }

    input.push({
      role: msg.role,
      content: contentText,
    });
  }

  return { instructions, input };
}

/**
 * Convert discovered tools to OpenAI function format for Responses API
 */
function convertTools(discoveredTools) {
  if (!discoveredTools || discoveredTools.length === 0) return [];

  return discoveredTools.map((tool) => {
    const fn = tool.function || tool;
    return {
      type: 'function',
      name: fn.name || tool.name,
      description: fn.description || tool.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

/**
 * Handle streaming for OpenAI models via the Responses API
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
      `[OpenAIProvider] Cancelling existing stream ${existingStreamId} for sender ${senderId}`
    );
    const existingStream = activeStreams.get(existingStreamId);
    if (existingStream) {
      existingStream.cancelled = true;
    }
    cleanupStream(existingStreamId);
  }

  const streamId = `stream_openai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  streamsBySender.set(senderId, streamId);

  try {
    activeStreams.set(streamId, {
      cancelled: false,
      stream: null,
      event: event,
      summaryInterval: null,
    });

    validateApiKey(settings);

    const client = new OpenAI({ apiKey: settings.OPENAI_API_KEY });
    const { instructions: extractedInstructions, input } = convertToResponsesInput(messages);
    const tools = convertTools(discoveredTools);

    // Build system prompt / instructions (same pattern as Groq chatHandler)
    const dateTimeString = new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'long', hour12: false
    });
    let instructions = `You are a helpful assistant capable of using tools. Use tools only when necessary and relevant to the user's request. Format responses using Markdown.\n\nCurrent date and time: ${dateTimeString}`;
    if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
      instructions += `\n\n${settings.customSystemPrompt.trim()}`;
    }
    if (extractedInstructions) {
      instructions += `\n\n${extractedInstructions}`;
    }

    // Build API params for Responses API
    const apiParams = {
      model: model,
      stream: true,
      input: input,
      instructions: instructions,
      store: false,
    };

    if (tools.length > 0) {
      apiParams.tools = tools;
    }

    // Add reasoning effort
    const reasoningEffort = settings.openai_reasoning_effort || 'medium';
    if (reasoningEffort !== 'none') {
      apiParams.reasoning = {
        effort: reasoningEffort === 'xhigh' ? 'high' : reasoningEffort,
        summary: 'auto',
      };
    }

    console.log(
      `[OpenAIProvider] Starting stream for model ${model}, reasoning effort: ${reasoningEffort}`
    );

    event.sender.send('chat-stream-start', {
      id: streamId,
      role: 'assistant',
    });

    // Use the streaming Responses API
    const stream = await client.responses.create(apiParams);

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const toolCallsMap = new Map();

    for await (const event_ of stream) {
      if (activeStreams.get(streamId)?.cancelled) {
        break;
      }

      switch (event_.type) {
        case 'response.output_text.delta':
          accumulatedContent += event_.delta;
          event.sender.send('chat-stream-content', { content: event_.delta });
          break;

        case 'response.reasoning_summary_text.delta':
          accumulatedReasoning += event_.delta;
          event.sender.send('chat-stream-reasoning', {
            reasoning: event_.delta,
            accumulated: accumulatedReasoning,
          });
          break;

        case 'response.output_item.added':
          if (event_.item.type === 'function_call') {
            const toolCall = {
              id: event_.item.id,
              type: 'function',
              function: {
                name: event_.item.name || '',
                arguments: event_.item.arguments || '',
              },
            };
            toolCallsMap.set(event_.item.id, toolCall);
            event.sender.send('chat-stream-tool-calls', {
              tool_calls: Array.from(toolCallsMap.values()),
            });
          }
          break;

        case 'response.function_call_arguments.delta':
          if (toolCallsMap.has(event_.item_id)) {
            const tc = toolCallsMap.get(event_.item_id);
            tc.function.arguments += event_.delta;
            toolCallsMap.set(event_.item_id, tc);
            event.sender.send('chat-stream-tool-calls', {
              tool_calls: Array.from(toolCallsMap.values()),
            });
          }
          break;

        case 'response.output_item.done':
          if (event_.item.type === 'function_call') {
            // Ensure final arguments
            if (toolCallsMap.has(event_.item.id) && event_.item.arguments) {
              const tc = toolCallsMap.get(event_.item.id);
              tc.function.arguments = event_.item.arguments;
              toolCallsMap.set(event_.item.id, tc);
            }
            event.sender.send('chat-stream-tool-calls', {
              tool_calls: Array.from(toolCallsMap.values()),
            });
          }
          break;

        case 'response.completed':
        case 'response.done': {
          // Extract usage
          const usage = event_.response?.usage
            ? {
                prompt_tokens: event_.response.usage.input_tokens,
                completion_tokens: event_.response.usage.output_tokens,
                total_tokens:
                  (event_.response.usage.input_tokens || 0) +
                  (event_.response.usage.output_tokens || 0),
              }
            : undefined;

          let finishReason = 'stop';
          const status = event_.response?.status;
          if (status === 'requires_action' || status === 'incomplete') {
            finishReason = 'tool_calls';
          } else if (toolCallsMap.size > 0) {
            finishReason = 'tool_calls';
          }

          event.sender.send('chat-stream-complete', {
            content: accumulatedContent,
            role: 'assistant',
            finish_reason: finishReason,
            tool_calls:
              toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined,
            reasoning: accumulatedReasoning || undefined,
            usage: usage,
          });

          cleanupStream(streamId);
          return;
        }

        case 'error':
          console.error('[OpenAIProvider] Stream error event:', event_);
          break;
      }
    }

    // If we reach here without a response.completed event, send completion
    if (!activeStreams.get(streamId)?.cancelled) {
      let finishReason = 'stop';
      if (toolCallsMap.size > 0) {
        finishReason = 'tool_calls';
      }

      event.sender.send('chat-stream-complete', {
        content: accumulatedContent,
        role: 'assistant',
        finish_reason: finishReason,
        tool_calls:
          toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined,
        reasoning: accumulatedReasoning || undefined,
      });
    }

    cleanupStream(streamId);
  } catch (error) {
    console.error('[OpenAIProvider] Error:', error);
    cleanupStream(streamId);
    event.sender.send('chat-stream-error', {
      error: error.message || `OpenAI API error: ${error}`,
    });
  }
}

module.exports = { handleStream };
