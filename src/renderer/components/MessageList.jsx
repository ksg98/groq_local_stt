import React, { useState, useEffect, useMemo } from 'react';
import { Volume2, Pause, Play, Layers, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatTokens } from '../lib/contextWindow';
import Message from './Message';
import SpeedControl from './SpeedControl';
import MarkdownRenderer from './MarkdownRenderer';

// Floating play button over a text selection inside the transcript. Reading a
// selection is the quickest way past a chunk you would rather skim than hear.
function SelectionSpeaker({ containerRef, speech }) {
  const [pos, setPos] = React.useState(null);
  const rangeRef = React.useRef(null);
  const textRef = React.useRef('');

  // Position from the live range rather than a remembered rectangle, so the
  // button rides along with the text when the transcript scrolls.
  const place = React.useCallback(() => {
    const range = rangeRef.current;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const box = containerRef.current?.getBoundingClientRect();
    // Only hide once the selection itself has scrolled out of view
    if (box && (rect.bottom < box.top || rect.top > box.bottom)) {
      setPos(null);
      return;
    }
    setPos({ top: rect.top, left: rect.left + rect.width / 2 });
  }, [containerRef]);

  React.useEffect(() => {
    if (!speech?.supported) return undefined;

    // Capture never clears: a pointerup that lands outside the transcript, or
    // on the button itself, must leave an existing selection alone. Clearing
    // is selectionchange's job, and that is what stops the flicker.
    const capture = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || !selection.rangeCount) return;
      const node = selection.anchorNode;
      if (!node || !containerRef.current?.contains(node)) return;
      rangeRef.current = selection.getRangeAt(0).cloneRange();
      textRef.current = text;
      place();
    };

    const onSelectionChange = () => {
      if (window.getSelection()?.toString().trim()) return;
      rangeRef.current = null;
      textRef.current = '';
      setPos(null);
    };

    document.addEventListener('pointerup', capture);
    document.addEventListener('keyup', capture);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerup', capture);
      document.removeEventListener('keyup', capture);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [containerRef, speech?.supported, place]);

  if (!pos) return null;
  const reading = speech.tokenState('selection');
  return (
    <div
      className="fixed z-50 -translate-x-1/2 -translate-y-full flex items-center gap-1 rounded-lg glass-card shadow-lg p-1"
      style={{ top: pos.top - 8, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()} // keep the selection alive
    >
      <button
        type="button"
        onClick={() => {
          if (reading === 'idle') speech.readAloud(textRef.current, 'selection');
          else if (reading === 'paused') speech.resume();
          else speech.pause();
        }}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium text-foreground hover:bg-accent transition-colors"
      >
        {reading === 'idle' ? (
          <><Volume2 className="w-3.5 h-3.5" /> Speak selection</>
        ) : reading === 'paused' ? (
          <><Play className="w-3.5 h-3.5" /> Resume</>
        ) : (
          <><Pause className="w-3.5 h-3.5" /> Pause</>
        )}
      </button>
      {reading !== 'idle' && (
        <SpeedControl speed={speech.speed} steps={speech.speedSteps} onChange={speech.setSpeed} />
      )}
    </div>
  );
}

// Where a chat was compacted. Older messages stay visible above; the model
// sees the summary instead of them.
function CompactionNotice({ message }) {
  const [open, setOpen] = useState(false);
  const info = message.compaction || {};
  return (
    <div className="my-4" data-no-speech="">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 hover:bg-accent hover:text-foreground transition-colors"
          aria-expanded={open}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>
            {info.auto ? 'Context compacted automatically' : 'Conversation compacted'}
            {info.tokensBefore ? ` · ${formatTokens(info.tokensBefore)} tokens summarized` : ''}
          </span>
          <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
      {open && (
        <div className="mt-3 rounded-lg glass-card p-4">
          <p className="text-xs text-muted-foreground mb-2">
            The model now sees this summary instead of the messages above
            {info.instructions ? `, focused on: ${info.instructions}` : ''}.
          </p>
          <MarkdownRenderer content={message.content || ''} />
        </div>
      )}
    </div>
  );
}

function MessageList({ messages = [], onToolCallExecute, onRemoveLastMessage, onReloadFromMessage, onRewindToMessage, loading, onActionsVisible, speech = null }) {
  const listRef = React.useRef(null);
  const [fullScreenImage, setFullScreenImage] = useState(null);

  // Effect to handle Escape key for closing fullscreen image
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setFullScreenImage(null);
      }
    };

    // Only add listener if image is fullscreen
    if (fullScreenImage) {
      document.addEventListener('keydown', handleKeyDown);
    }

    // Cleanup function to remove listener
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [fullScreenImage]); // Dependency array includes fullScreenImage

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <p className="text-center max-w-md">
          Send a message to start a conversation with Groq
        </p>
      </div>
    );
  }

  // We still filter tool messages here because the `Message` component handles displaying
  // assistant messages and their corresponding tool calls/results.
  const displayMessages = messages.filter(message => message.role !== 'tool');

  // Identify consecutive assistant message groups (for collapsing reasoning in tool-call continuation flows)
  // When using Responses API with MCP approval, we get multiple assistant messages without user messages between them
  // We want to show reasoning UI only on the first message of such a group, but combine all reasoning
  const assistantGroupInfo = useMemo(() => {
    const groupInfo = new Map(); // Maps display index to { isFirstInGroup, groupStartIndex, groupSize, combinedReasoning, combinedDuration }
    
    // First pass: identify groups
    const groups = []; // Array of { startIndex, endIndex, indices }
    let currentGroupStart = null;
    let currentGroupIndices = [];
    
    displayMessages.forEach((message, index) => {
      if (message.role === 'assistant') {
        if (currentGroupStart === null) {
          currentGroupStart = index;
          currentGroupIndices = [index];
        } else {
          currentGroupIndices.push(index);
        }
      } else {
        // Non-assistant message ends the current group
        if (currentGroupStart !== null && currentGroupIndices.length > 1) {
          groups.push({
            startIndex: currentGroupStart,
            endIndex: currentGroupIndices[currentGroupIndices.length - 1],
            indices: [...currentGroupIndices]
          });
        }
        currentGroupStart = null;
        currentGroupIndices = [];
      }
    });
    
    // Handle the case where the last messages are assistants
    if (currentGroupStart !== null && currentGroupIndices.length > 1) {
      groups.push({
        startIndex: currentGroupStart,
        endIndex: currentGroupIndices[currentGroupIndices.length - 1],
        indices: [...currentGroupIndices]
      });
    }
    
    // Second pass: calculate combined reasoning for each group
    groups.forEach(group => {
      // Combine reasoning from all messages in the group
      const reasoningParts = [];
      let totalDuration = 0;
      let hasAnyReasoning = false;
      
      group.indices.forEach((idx, positionInGroup) => {
        const msg = displayMessages[idx];
        const reasoning = msg.liveReasoning || msg.reasoning;
        const duration = msg.reasoningDuration || 0;
        
        if (reasoning) {
          hasAnyReasoning = true;
          // Add a separator between reasoning sections if not the first
          if (reasoningParts.length > 0) {
            reasoningParts.push('\n\n---\n\n');
          }
          reasoningParts.push(reasoning);
        }
        totalDuration += duration;
      });
      
      const combinedReasoning = hasAnyReasoning ? reasoningParts.join('') : null;
      
      // Store info for each message in the group
      group.indices.forEach((idx, positionInGroup) => {
        groupInfo.set(idx, {
          isFirstInGroup: positionInGroup === 0,
          groupStartIndex: group.startIndex,
          groupSize: group.indices.length,
          // Only the first message gets the combined reasoning
          combinedReasoning: positionInGroup === 0 ? combinedReasoning : null,
          combinedDuration: positionInGroup === 0 ? totalDuration : null
        });
      });
    });
    
    return groupInfo;
  }, [displayMessages]);

  // A compaction marker is not a message: the reply before it keeps its actions
  const lastMessageIndex = displayMessages.map((m) => !m.compaction).lastIndexOf(true);

  return (
    <div className="space-y-0.5 pt-4 p-4" ref={listRef}>
      <SelectionSpeaker containerRef={listRef} speech={speech} />
      {displayMessages.map((message, index) => {
        if (message.compaction) return <CompactionNotice key={index} message={message} />;
        // Find the original index in the messages array (including tool messages)
        const originalIndex = messages.findIndex((m, i) => {
          // Find the nth non-tool message in messages that matches this display message
          let nonToolCount = 0;
          for (let j = 0; j <= i; j++) {
            if (messages[j].role !== 'tool') {
              if (nonToolCount === index) {
                return j === i;
              }
              nonToolCount++;
            }
          }
          return false;
        });

        // Get group info for consecutive assistant messages
        // If this is not the first in a group of consecutive assistant messages, 
        // we want to hide its reasoning UI to collapse it with the first message
        const groupInfo = assistantGroupInfo.get(index);
        const hideReasoningUI = groupInfo && !groupInfo.isFirstInGroup && groupInfo.groupSize > 1;
        // For the first message in a group, pass combined reasoning from all grouped messages
        const combinedReasoning = groupInfo?.combinedReasoning || null;
        const combinedReasoningDuration = groupInfo?.combinedDuration || null;
        
        return (
          <Message 
            key={index} 
            message={message} 
            messageIndex={originalIndex}
            onToolCallExecute={onToolCallExecute}
            onReloadFromMessage={onReloadFromMessage}
            onRewindToMessage={onRewindToMessage}
            speech={speech}
            allMessages={messages} // Pass all messages for the Message component to find tool results
            isLastMessage={index === lastMessageIndex}
            loading={loading}
            onActionsVisible={onActionsVisible}
            hideReasoningUI={hideReasoningUI}
            combinedReasoning={combinedReasoning}
            combinedReasoningDuration={combinedReasoningDuration}
          >
          {message.role === 'user' ? (
            <div className="flex items-start gap-2">
              <div className="flex-1 flex flex-col gap-2"> {/* Use flex-col for text/images */}
                {/* Check if content is an array (structured) or string (simple text) */}
                {Array.isArray(message.content) ? (
                  message.content.map((part, partIndex) => {
                    if (part.type === 'text') {
                      // Render text part as plain text
                      return <div key={`text-${partIndex}`} className="whitespace-pre-wrap text-sm">{part.text || ''}</div>;
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                      // Render image preview
                      return (
                        <img
                          key={`image-${partIndex}`}
                          src={part.image_url.url} // Assumes base64 data URL
                          alt={`Uploaded image ${partIndex + 1}`}
                          className="max-w-xs max-h-48 rounded-md cursor-pointer self-start" // Align images left
                          onClick={() => setFullScreenImage(part.image_url.url)} // Show fullscreen on click
                        />
                      );
                    }
                    return null; // Should not happen with current structure
                  })
                ) : (
                  // If content is just a string, render it directly as plain text
                  <div className="whitespace-pre-wrap text-sm">{message.content || ''}</div>
                )}
              </div>
            </div>
          ) : message.role === 'assistant' ? (
            <MarkdownRenderer content={message.content || ''} boldWordStarts={!!speech?.prefs?.readingBoldStarts} />
          ) : null}
        </Message>
        );
      })}

      {/* Fullscreen Image Overlay */}
      {fullScreenImage && (
        <div 
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 cursor-pointer"
          onClick={() => setFullScreenImage(null)} // Dismiss on click outside image
        >
          <img 
            src={fullScreenImage} 
            alt="Fullscreen view" 
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()} // Prevent closing when clicking the image itself
          />
        </div>
      )}
    </div>
  );
}

export default MessageList; 