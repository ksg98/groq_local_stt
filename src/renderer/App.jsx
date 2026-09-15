import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ToolsPanel from './components/ToolsPanel';
import ToolApprovalModal from './components/ToolApprovalModal';
import ChatHistorySidebar from './components/ChatHistorySidebar';
import ScreenSourcePicker from './components/ScreenSourcePicker';
import { ProjectKnowledgePanel, ProjectModal, ProjectKnowledgeModal } from './components/ProjectPanel';
import { useChat } from './context/ChatContext'; // Import useChat hook
import { useVoiceAgent, SPEED_STEPS, resolveToken } from './hooks/useVoiceAgent';
import { useReadingPrefs } from './hooks/useReadingPrefs';
import { applyCompaction, estimateContextTokens, resolveContextWindow, parseCompactCommand, formatTokens, MIN_COMPACT_TOKENS } from './lib/contextWindow';
import { buildFrameParts, mergeFinalFrame, pruneHistoryImages } from './lib/frameBank';
import { useMediaCapture } from './hooks/useMediaCapture';
// Import shared model definitions - REMOVED
// import { MODEL_CONTEXT_SIZES } from '../../shared/models';
import { Settings, Zap, MessageSquare, PanelLeftClose, PanelLeft, Radio, MessagesSquare, FolderOpen, Pencil } from 'lucide-react';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';

// LocalStorage keys
const TOOL_APPROVAL_PREFIX = 'tool_approval_';
const YOLO_MODE_KEY = 'tool_approval_yolo_mode';

// --- LocalStorage Helper Functions ---
const getToolApprovalStatus = (toolName) => {
  try {
    const yoloMode = localStorage.getItem(YOLO_MODE_KEY);
    if (yoloMode === 'true') {
      return 'yolo';
    }
    const toolStatus = localStorage.getItem(`${TOOL_APPROVAL_PREFIX}${toolName}`);
    if (toolStatus === 'always') {
      return 'always';
    }
    // Default: prompt the user
    return 'prompt';
  } catch (error) {
    console.error("Error reading tool approval status from localStorage:", error);
    return 'prompt'; // Fail safe: prompt user if localStorage fails
  }
};

const setToolApprovalStatus = (toolName, status) => {
  try {
    if (status === 'yolo') {
      localStorage.setItem(YOLO_MODE_KEY, 'true');
      // Optionally clear specific tool settings when YOLO is enabled?
      // Object.keys(localStorage).forEach(key => {
      //   if (key.startsWith(TOOL_APPROVAL_PREFIX)) {
      //     localStorage.removeItem(key);
      //   }
      // });
    } else if (status === 'always') {
      localStorage.setItem(`${TOOL_APPROVAL_PREFIX}${toolName}`, 'always');
      // Ensure YOLO mode is off if a specific tool is set to always
      localStorage.removeItem(YOLO_MODE_KEY);
    } else if (status === 'once') {
      // 'once' doesn't change persistent storage, just allows current execution
      // Ensure YOLO mode is off if 'once' is chosen for a specific tool
      localStorage.removeItem(YOLO_MODE_KEY);
    } else if (status === 'deny') {
       // 'deny' also doesn't change persistent storage by default.
       // Could potentially add a 'never' status if needed.
       // Ensure YOLO mode is off if 'deny' is chosen
       localStorage.removeItem(YOLO_MODE_KEY);
    }
  } catch (error) {
    console.error("Error writing tool approval status to localStorage:", error);
  }
};
// --- End LocalStorage Helper Functions ---


function App() {
  // const [messages, setMessages] = useState([]); // Remove local state
  const { 
    messages, 
    setMessages, 
    currentChatId,
    createNewChat, 
    startFreshChat,
    isSidebarCollapsed,
    toggleSidebar,
    needsTitleGeneration,
    currentProject,
    currentProjectId
  } = useChat(); // Use context state
  const [loading, setLoading] = useState(false);
  // Project dialogs: { mode: 'create' | 'edit', project } and the knowledge panel
  const [projectModal, setProjectModal] = useState(null);
  const [projectKnowledgeOpen, setProjectKnowledgeOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('llama-3.3-70b-versatile');
  const [reasoningEffort, setReasoningEffort] = useState('medium');
  const [mcpTools, setMcpTools] = useState([]);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [mcpServersStatus, setMcpServersStatus] = useState({ loading: false, message: "" });
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const userScrollingRef = useRef(false); // Immediate ref for preventing race conditions
  const scrollThrottleRef = useRef(null); // For throttling scroll during streaming
  const rafRef = useRef(null); // For requestAnimationFrame during streaming
  // Store the list of models from capabilities keys
  // const models = Object.keys(MODEL_CONTEXT_SIZES).filter(key => key !== 'default'); // Old way
  const [modelConfigs, setModelConfigs] = useState({}); // State for model configurations
  const [models, setModels] = useState([]); // State for model list
  const [modelFilter, setModelFilter] = useState(''); // State for model filter setting
  const [modelFilterExclude, setModelFilterExclude] = useState(''); // State for model filter exclude setting

  // Add state to track if initial model/settings load is complete
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  // Track if using Responses API (needed for chat history compatibility)
  const [useResponsesApi, setUseResponsesApi] = useState(false);

  // --- State for Tool Approval Flow ---
  const [pendingApprovalCall, setPendingApprovalCall] = useState(null); // Holds the tool call object needing approval
  const [pausedChatState, setPausedChatState] = useState(null); // Holds { currentMessages, finalAssistantMessage, accumulatedResponses }
  // --- End Tool Approval State ---

  // --- Context Sharing State ---
  const [externalContext, setExternalContext] = useState(null);
  // --- End Context Sharing State ---

  // --- Cancellation State ---
  const cancelledRef = useRef(false); // Track if current operation is cancelled
  const loadingRef = useRef(false); // Track loading state for cleanup
  // Screen-share frame policy from Settings: frames per held turn, and how
  // many recent turns keep their images in the API payload.
  const frameSettingsRef = useRef({ perTurn: 5, historyTurns: 2 });
  // Context window and auto-compact preferences from Settings
  const [contextPrefs, setContextPrefs] = useState({ contextWindow: 'auto', autoCompact: true, threshold: 0.85 });
  // Compaction in progress / its outcome, shown above the input
  const [compactState, setCompactState] = useState(null);
  const frameBudgetRef = useRef(5);
  useEffect(() => {
    const load = () =>
      window.electron
        ?.getSettings?.()
        .then((s) => {
          const perTurn = Math.max(1, Number(s?.screenFramesPerTurn) || 5);
          const historyTurns = Math.max(0, Number(s?.screenFrameHistoryTurns ?? 2) || 0);
          frameSettingsRef.current = { perTurn, historyTurns };
          frameBudgetRef.current = perTurn;
          const threshold = Math.min(0.98, Math.max(0.5, Number(s?.autoCompactThreshold) || 0.85));
          const nextContext = { contextWindow: s?.contextWindow ?? 'auto', autoCompact: s?.autoCompact !== false, threshold };
          setContextPrefs((prev) =>
            prev.contextWindow === nextContext.contextWindow && prev.autoCompact === nextContext.autoCompact && prev.threshold === nextContext.threshold
              ? prev
              : nextContext
          );
        })
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  // --- End Cancellation State ---

  // --- Voice Agent / Capture refs ---
  // Populated after the hooks are instantiated (they need handleSendMessage);
  // the streaming callbacks in executeChatTurn read them through these refs.
  const voiceAgentRef = useRef(null);
  const captureRef = useRef(null);
  // Index of the streaming assistant placeholder, for auto-read to follow
  const placeholderIndexRef = useRef(-1);
  // Reading & focus preferences (follow-along, auto-read, text presentation)
  const readingPrefs = useReadingPrefs();
  // --- End Voice Agent / Capture refs ---

  // Rewind: drop everything after a message, without resending anything.
  // The truncated history is saved through the same path as any edit.
  // A read-aloud is tied to a message position, so it ends whenever the
  // messages it points at go away
  const stopReadAloud = () => {
    if (voiceAgentRef.current?.playback?.token != null) voiceAgentRef.current.stopSpeech();
  };

  const handleRewindToMessage = (messageIndex) => {
    stopReadAloud();
    if (loadingRef.current) handleStopGeneration();
    setMessages((prev) => (messageIndex < prev.length - 1 ? prev.slice(0, messageIndex + 1) : prev));
  };

  const handleRemoveLastMessage = () => {
    setMessages(prev => {
      if (prev.length === 0) return prev;
      // Create a copy without the last message
      return prev.slice(0, prev.length - 1);
    });
  };

  // Handle reloading from a specific message (remove all messages after it and resend)
  const handleReloadFromMessage = async (messageIndex) => {
    stopReadAloud();
    // Find the last user message at or before the messageIndex
    let lastUserMessageIndex = -1;
    for (let i = messageIndex; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserMessageIndex = i;
        break;
      }
    }

    if (lastUserMessageIndex === -1) {
      console.warn('No user message found to reload from');
      return;
    }

    // Get messages up to and including the last user message
    const messagesToKeep = messages.slice(0, lastUserMessageIndex + 1);
    
    // Reset messages to only include up to the last user message
    setMessages(messagesToKeep);

    // Reset cancellation flag
    cancelledRef.current = false;
    
    // Reset user scrolling flag
    userScrollingRef.current = false;
    setIsUserScrolling(false);

    setLoading(true);

    let currentApiMessages = messagesToKeep;
    let conversationStatus = 'processing';

    try {
        while (conversationStatus === 'processing' || conversationStatus === 'completed_with_tools') {
            const { status, assistantMessage, toolResponseMessages } = await executeChatTurn(currentApiMessages);

            conversationStatus = status;

            if (status === 'paused') {
                break;
            } else if (status === 'cancelled') {
                console.log('Conversation cancelled by user');
                break;
            } else if (status === 'error') {
                break;
            } else if (status === 'completed_with_tools') {
                if (assistantMessage && toolResponseMessages.length > 0) {
                    const formattedToolResponses = toolResponseMessages.map(msg => ({
                        role: 'tool',
                        content: msg.content,
                        tool_call_id: msg.tool_call_id
                    }));
                    currentApiMessages = [
                        ...currentApiMessages,
                        {
                          role: assistantMessage.role,
                          content: assistantMessage.content,
                          tool_calls: assistantMessage.tool_calls
                        },
                        ...formattedToolResponses
                    ];
                } else {
                    console.warn("Status 'completed_with_tools' but no assistant message or tool responses found.");
                    conversationStatus = 'error';
                    break;
                }
            } else if (status === 'completed_no_tools') {
                break;
            }
        }
    } catch (error) {
        console.error('Error in handleReloadFromMessage:', error);
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error.message}` }]);
        conversationStatus = 'error';
    } finally {
        if (conversationStatus !== 'paused') {
            setLoading(false);
        }
    }
  };
  
  // Models list derived from capabilities keys
  // const models = Object.keys(MODEL_CAPABILITIES).filter(key => key !== 'default');

  // Helper function to filter models based on modelFilter setting
  const filterModels = (modelList, filterText, excludeText, configs) => {
    let filteredModels = modelList;

    // First, apply inclusion filter if specified
    if (filterText && filterText.trim()) {
      // Split filter text into lines and filter out empty lines
      const filterTerms = filterText
        .split('\n')
        .map(term => term.trim())
        .filter(term => term.length > 0);

      if (filterTerms.length > 0) {
        // Helper to get display name for a model
        const getDisplayName = (modelId) => {
          const modelInfo = configs[modelId];
          if (modelInfo && modelInfo.displayName) {
            return modelInfo.displayName;
          }
          return modelId;
        };

        // Filter models that match any filter term (case-insensitive)
        filteredModels = modelList.filter(modelId => {
          const displayName = getDisplayName(modelId).toLowerCase();
          const modelIdLower = modelId.toLowerCase();
          
          // Check if any filter term matches either the model ID or display name
          return filterTerms.some(term => {
            const termLower = term.toLowerCase();
            return modelIdLower.includes(termLower) || displayName.includes(termLower);
          });
        });
      }
    }

    // Then, apply exclude filter (applies regardless of inclusion filter)
    if (excludeText && excludeText.trim()) {
      // Split exclude text into lines and filter out empty lines
      const excludeTerms = excludeText
        .split('\n')
        .map(term => term.trim())
        .filter(term => term.length > 0);

      if (excludeTerms.length > 0) {
        // Helper to get display name for a model
        const getDisplayName = (modelId) => {
          const modelInfo = configs[modelId];
          if (modelInfo && modelInfo.displayName) {
            return modelInfo.displayName;
          }
          return modelId;
        };

        // Filter out models that match any exclude term (case-insensitive)
        filteredModels = filteredModels.filter(modelId => {
          const displayName = getDisplayName(modelId).toLowerCase();
          const modelIdLower = modelId.toLowerCase();
          
          // Check if any exclude term matches either the model ID or display name
          const matchesExclude = excludeTerms.some(term => {
            const termLower = term.toLowerCase();
            return modelIdLower.includes(termLower) || displayName.includes(termLower);
          });
          
          // Return false (exclude) if it matches, true (keep) if it doesn't
          return !matchesExclude;
        });
      }
    }

    return filteredModels;
  };

  // Sort models alphabetically by display name for consistent ordering
  // and apply model filter if configured
  const sortedModels = useMemo(() => {
    // First apply the filters (inclusion and exclude)
    const filteredModels = filterModels(models, modelFilter, modelFilterExclude, modelConfigs);
    
    // Then sort the filtered models
    return filteredModels.sort((a, b) => {
      // Get display names from modelConfigs
      const getDisplayName = (modelId) => {
        const modelInfo = modelConfigs[modelId];
        if (modelInfo && modelInfo.displayName) {
          return modelInfo.displayName;
        }
        return modelId;
      };
      
      const nameA = getDisplayName(a).toLowerCase();
      const nameB = getDisplayName(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [models, modelConfigs, modelFilter, modelFilterExclude]);

  // Function to update the server status display - moved outside useEffect
  const updateServerStatus = (tools, settings) => {
    try {
      // Get number of configured servers
      if (settings && settings.mcpServers) {
        const configuredCount = Object.keys(settings.mcpServers).length;
        
        // Get unique server IDs from the tools
        const connectedServerIds = new Set();
        if (Array.isArray(tools)) {
          tools.forEach(tool => {
            if (tool && tool.serverId) {
              connectedServerIds.add(tool.serverId);
            }
          });
        }
        const connectedCount = connectedServerIds.size;
        const toolCount = Array.isArray(tools) ? tools.length : 0;
        
        if (configuredCount > 0) {
          if (connectedCount === configuredCount) {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, ${connectedCount}/${configuredCount} MCP servers connected` 
            });
          } else if (connectedCount > 0) {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, ${connectedCount}/${configuredCount} MCP servers connected` 
            });
          } else {
            setMcpServersStatus({ 
              loading: false, 
              message: `${toolCount} tools, No MCP servers connected (${configuredCount} configured)` 
            });
          }
        } else {
          setMcpServersStatus({ loading: false, message: `${toolCount} tools, No MCP servers configured` });
        }
      } else {
        const toolCount = Array.isArray(tools) ? tools.length : 0;
        setMcpServersStatus({ loading: false, message: `${toolCount} tools available` });
      }
    } catch (error) {
      console.error('Error updating server status:', error);
      setMcpServersStatus({ loading: false, message: "Error updating server status" });
    }
  };

  // Load settings, MCP tools, and model configs when component mounts
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        // Set loading status
        setMcpServersStatus({ loading: true, message: "Connecting to MCP servers..." });

        // Load model configurations first
        const configs = await window.electron.getModelConfigs(); // Await configs
        setModelConfigs(configs);
        const availableModels = Object.keys(configs).filter(key => key !== 'default');
        setModels(availableModels); // Set models list

        // THEN Load settings
        const settings = await window.electron.getSettings(); // Await settings
        // Load model filter settings
        setModelFilter(settings.modelFilter || '');
        setModelFilterExclude(settings.modelFilterExclude || '');
        // Load useResponsesApi setting
        setUseResponsesApi(settings.useResponsesApi || false);
        let effectiveModel = availableModels.length > 0 ? availableModels[0] : 'default'; // Default fallback if no models or no setting

        if (settings && settings.model) {
            // Ensure the saved model is still valid against the loaded configs
            if (configs[settings.model]) {
                effectiveModel = settings.model; // Use saved model if valid
            } else {
                // If saved model is invalid, keep the default fallback (first available model)
                console.warn(`Saved model "${settings.model}" not found in loaded configs. Falling back to ${effectiveModel}.`);
            }
        } else if (availableModels.length > 0) {
             // If no model saved in settings, but models are available, use the first one
            effectiveModel = availableModels[0];
        }
        // If no model in settings and no available models, effectiveModel remains 'default'

        setSelectedModel(effectiveModel); // Set the final selected model state


        // Initial load of MCP tools (can happen after model/settings)
        const mcpToolsResult = await window.electron.getMcpTools();
        // Use the already loaded settings object here for initial status update
        if (mcpToolsResult && mcpToolsResult.tools) {
          setMcpTools(mcpToolsResult.tools);
          updateServerStatus(mcpToolsResult.tools, settings); // Pass loaded settings
        } else {
           // Handle case where no tools are found initially, but update status
          updateServerStatus([], settings);
        }

        // Set up event listener for MCP server status changes
        const removeListener = window.electron.onMcpServerStatusChanged((data) => {
          if (data && data.tools !== undefined) { // Check if tools property exists
            setMcpTools(data.tools);
            // Fetch latest settings again when status changes, as they might have been updated
            window.electron.getSettings().then(currentSettings => {
              updateServerStatus(data.tools, currentSettings);
            }).catch(err => {
                console.error("Error fetching settings for status update:", err);
                // Fallback to updating status without settings info
                updateServerStatus(data.tools, null);
            });
          }
        });

        // Clean up the event listener when component unmounts
        return () => {
          if (removeListener) removeListener();
        };
      } catch (error) {
        console.error('Error loading initial data:', error);
        setMcpServersStatus({ loading: false, message: "Error loading initial data" });
      } finally {
          // Mark initial load as complete regardless of success/failure
          setInitialLoadComplete(true);
      }
    };

    loadInitialData();
  }, []); // Empty dependency array ensures this runs only once on mount

  // Reload settings when window gains focus (in case settings changed)
  useEffect(() => {
    const handleFocus = async () => {
      try {
        const settings = await window.electron.getSettings();
        setModelFilter(settings.modelFilter || '');
        setModelFilterExclude(settings.modelFilterExclude || '');
        setUseResponsesApi(settings.useResponsesApi || false);
      } catch (error) {
        console.error('Error reloading settings:', error);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // Save model selection to settings when it changes, ONLY after initial load
  useEffect(() => {
    // Prevent saving during initial setup before models/settings are loaded/validated
    if (!initialLoadComplete) {
        return;
    }

    // Also ensure models list isn't empty and selectedModel is valid
    if (models.length === 0 || !selectedModel) {
        console.warn("Skipping model save: Models not loaded or no model selected.");
        return;
    }

    const saveModelSelection = async () => {
      try {
        console.log(`Attempting to save selected model: ${selectedModel}`); // Debug log
        const settings = await window.electron.getSettings();
        // Check if the model actually changed before saving
        if (settings.model !== selectedModel) {
            console.log(`Saving new model selection: ${selectedModel}`);
            await window.electron.saveSettings({ ...settings, model: selectedModel });
        } else {
            // console.log("Model selection hasn't changed, skipping save."); // Optional: Log skips
        }
      } catch (error) {
        console.error('Error saving model selection:', error);
      }
    };

    saveModelSelection();
    // Depend on initialLoadComplete as well to trigger after load finishes
  }, [selectedModel, initialLoadComplete, models]);

  // Check if user is at the bottom of the scroll area (within 100px threshold)
  const isAtBottom = () => {
    if (!messagesContainerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const threshold = 100;
    return scrollHeight - scrollTop - clientHeight < threshold;
  };

  const scrollToBottom = (instant = false) => {
    // Double-check before scrolling to prevent race conditions
    if (!userScrollingRef.current) {
      // Use instant scroll during streaming to avoid bouncy behavior
      // Use smooth scroll for stable content (like when user sends a message)
      messagesEndRef.current?.scrollIntoView({ behavior: instant ? 'instant' : 'smooth' });
    }
  };

  // Handle scroll events to detect when user manually scrolls
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const atBottom = isAtBottom();
      if (atBottom) {
        // User is at bottom, resume auto-scroll
        userScrollingRef.current = false;
        setIsUserScrolling(false);
      } else if (!atBottom) {
        // User scrolled up, disable auto-scroll
        userScrollingRef.current = true;
        setIsUserScrolling(true);
      }
    };

    // Detect scroll wheel/touch intent immediately (before scroll position changes)
    const handleWheel = (e) => {
      // ANY wheel event immediately cancels auto-scrolling to prevent fighting
      userScrollingRef.current = true;
      setIsUserScrolling(true);
    };

    const handleTouchStart = () => {
      // When user touches to scroll, check if they're at bottom
      if (!isAtBottom()) {
        userScrollingRef.current = true;
        setIsUserScrolling(true);
      }
    };

    container.addEventListener('scroll', handleScroll);
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
    };
  }, []);

  // Auto-scroll to bottom when messages change, but only if user hasn't scrolled up
  useEffect(() => {
    // Check both state and ref for maximum responsiveness
    if (!isUserScrolling && !userScrollingRef.current) {
      // Check if any message is actively streaming
      const isStreaming = messages.some(msg => msg.isStreaming === true);
      
      if (isStreaming) {
        // Use requestAnimationFrame for smooth scrolling aligned with browser rendering
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
        }
        if (scrollThrottleRef.current) {
          clearTimeout(scrollThrottleRef.current);
        }
        
        // Throttle with rAF for optimal performance
        scrollThrottleRef.current = setTimeout(() => {
          rafRef.current = requestAnimationFrame(() => {
            scrollToBottom(true); // instant scroll
            rafRef.current = null;
          });
          scrollThrottleRef.current = null;
        }, 50);
      } else {
        // Clear any pending throttled scroll and rAF
        if (scrollThrottleRef.current) {
          clearTimeout(scrollThrottleRef.current);
          scrollThrottleRef.current = null;
        }
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        // Non-streaming: scroll smoothly immediately
        scrollToBottom(false);
      }
    }
    
    // Cleanup function
    return () => {
      if (scrollThrottleRef.current) {
        clearTimeout(scrollThrottleRef.current);
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [messages, isUserScrolling]);

  const executeToolCall = async (toolCall) => {
    try {
      const response = await window.electron.executeToolCall(toolCall);
      
      // Return the tool response message in the correct format
      return {
        role: 'tool',
        content: response.error ? JSON.stringify({ error: response.error }) : (response.result || ''),
        tool_call_id: toolCall.id
      };
    } catch (error) {
      console.error('Error executing tool call:', error);
      return { 
        role: 'tool', 
        content: JSON.stringify({ error: error.message }),
        tool_call_id: toolCall.id
      };
    }
  };

  // Refactored processToolCalls to handle sequential checking and pausing
  const processToolCalls = async (assistantMessage, currentMessagesBeforeAssistant) => {
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return { status: 'completed', toolResponseMessages: [] };
    }

    const toolResponseMessages = [];
    let needsPause = false;

    for (const toolCall of assistantMessage.tool_calls) {
      // Check if operation was cancelled
      if (cancelledRef.current) {
        console.log('Tool execution cancelled by user');
        return { status: 'cancelled', toolResponseMessages };
      }

      // Skip remote MCP tool calls - they are executed server-side by Groq
      // and their results are already handled via pre_calculated_tool_responses
      // Remote MCP tools have server_label set (mcp_call events set this in chatHandler)
      const toolName = toolCall.function.name;
      if (toolCall.server_label) {
        console.log(`Tool '${toolName}' is a remote MCP tool (server: ${toolCall.server_label}). Skipping client-side execution.`);
        continue;
      }

      const approvalStatus = getToolApprovalStatus(toolName);

      if (approvalStatus === 'always' || approvalStatus === 'yolo') {
        console.log(`Tool '${toolName}' automatically approved (${approvalStatus}). Executing...`);
        try {
          // Check again before executing (in case cancelled during previous tool execution)
          if (cancelledRef.current) {
            console.log('Tool execution cancelled by user before executing tool');
            return { status: 'cancelled', toolResponseMessages };
          }
          
          const resultMsg = await executeToolCall(toolCall);
          
          // Check again after execution completes
          if (cancelledRef.current) {
            console.log('Tool execution cancelled by user after tool completed');
            return { status: 'cancelled', toolResponseMessages };
          }
          
          toolResponseMessages.push(resultMsg);
          // Update UI immediately for executed tool calls
          setMessages(prev => [...prev, resultMsg]);
        } catch (error) {
            console.error(`Error executing automatically approved tool call '${toolName}':`, error);
            const errorMsg = {
                role: 'tool',
                content: JSON.stringify({ error: `Error executing tool '${toolName}': ${error.message}` }),
                tool_call_id: toolCall.id
            };
            toolResponseMessages.push(errorMsg);
           setMessages(prev => [...prev, errorMsg]); // Show error in UI
        }
      } else { // status === 'prompt'
        console.log(`Tool '${toolName}' requires user approval.`);
        setPendingApprovalCall(toolCall);
        setPausedChatState({
          currentMessages: currentMessagesBeforeAssistant, // History before this assistant message
          finalAssistantMessage: assistantMessage,
          accumulatedResponses: toolResponseMessages // Responses gathered *before* this pause
        });
        needsPause = true;
        break; // Stop processing further tools for this turn
      }
    }

    if (needsPause) {
      return { status: 'paused', toolResponseMessages };
    } else {
      return { status: 'completed', toolResponseMessages };
    }
  };

  // Keep the reasoning effort valid for the selected model (each model
  // reports its own supported effort levels via the dynamic model configs)
  useEffect(() => {
    const efforts = modelConfigs?.[selectedModel]?.reasoning?.efforts;
    if (efforts && efforts.length > 0 && !efforts.includes(reasoningEffort)) {
      setReasoningEffort(efforts.includes('medium') ? 'medium' : efforts[efforts.length - 1]);
    }
  }, [selectedModel, modelConfigs, reasoningEffort]);

  // Function to stop the ongoing generation
  const handleStopGeneration = () => {
    console.log('Stopping generation...');
    cancelledRef.current = true; // Set cancellation flag
    window.electron.stopChatStream();
    setLoading(false); // Immediately set loading to false
    // Clear any pending tool approval state
    setPendingApprovalCall(null);
    setPausedChatState(null);
  };

  // Keep loadingRef in sync with loading state
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Cleanup function to stop any active streams when component unmounts (page reload/navigation/HMR)
  useEffect(() => {
    return () => {
      // Always clean up IPC listeners on unmount (important for HMR)
      console.log('Component unmounting, cleaning up...');
      
      // Clean up chat stream listeners to prevent duplicates on HMR
      if (window.electron.cleanupChatStreamListeners) {
        window.electron.cleanupChatStreamListeners();
      }
      
      // Stop any active streams when the component actually unmounts
      if (loadingRef.current) {
        console.log('Stopping active streams...');
        cancelledRef.current = true;
        window.electron.stopChatStream();
      }
    };
  }, []); // Empty dependency array - only run on actual mount/unmount

  // Core function to execute a chat turn (fetch response, handle tools)
  // Refactored from the main loop of handleSendMessage
  const executeChatTurn = async (turnMessages) => {
    let currentTurnStatus = 'processing'; // processing, completed, paused, error
    let turnAssistantMessage = null;
    let turnToolResponses = [];

    try {
        // Create a streaming assistant message placeholder
        const assistantPlaceholder = {
            role: 'assistant',
            content: '',
            isStreaming: true,
            reasoningSummaries: []
        };
        setMessages(prev => {
            placeholderIndexRef.current = prev.length;
            return [...prev, assistantPlaceholder];
        });
        // Auto-read: speak this reply as it streams in, following along on screen
        voiceAgentRef.current?.onAssistantTurnStart(() => placeholderIndexRef.current);

        // Start streaming chat
        // Old screenshots leave the payload here; the chat on screen keeps them
        // A compacted chat sends its summary in place of the older messages
        const apiMessages = pruneHistoryImages(applyCompaction(turnMessages), frameSettingsRef.current.historyTurns);
        // A chat inside a project sends its id so the main process can fold
        // the project's instructions and files into the system prompt
        const streamHandler = window.electron.startChatStream(apiMessages, selectedModel, {
          reasoningEffort,
          projectId: currentProjectId || null,
        });

            // Collect the final message data
        let finalAssistantData = {
            role: 'assistant',
            content: '',
            tool_calls: undefined,
            reasoning: undefined,
            executed_tools: undefined,
            liveReasoning: '',
            liveExecutedTools: [],
            reasoningSummaries: [],
            reasoningStartTime: null,
            reasoningDuration: null,
            pre_calculated_tool_responses: undefined
        };

        // Setup event handlers for streaming
        streamHandler.onStart(() => { /* Placeholder exists */ });

        streamHandler.onContent(({ content }) => {
            finalAssistantData.content += content;
            // Voice agent: speak completed sentences as they stream in
            voiceAgentRef.current?.feedAssistantDelta(content);

            // If this is the first content token and we have reasoning, mark reasoning as complete
            if (finalAssistantData.content === content && finalAssistantData.reasoningStartTime && !finalAssistantData.reasoningDuration) {
                finalAssistantData.reasoningDuration = Math.round((Date.now() - finalAssistantData.reasoningStartTime) / 1000);
            }
            
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { 
                        ...newMessages[idx], 
                        content: finalAssistantData.content,
                        reasoningDuration: finalAssistantData.reasoningDuration,
                        liveReasoning: finalAssistantData.liveReasoning,
                        reasoningSummaries: [...finalAssistantData.reasoningSummaries]
                    };
                }
                return newMessages;
            });
        });

        streamHandler.onToolCalls(({ tool_calls }) => {
            finalAssistantData.tool_calls = tool_calls;
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { ...newMessages[idx], tool_calls: finalAssistantData.tool_calls };
                }
                return newMessages;
            });
        });

        // Handle compound-beta reasoning streaming
        streamHandler.onReasoning(({ reasoning, accumulated }) => {
            // Track when reasoning starts and add initial "Thinking" placeholder
            if (!finalAssistantData.reasoningStartTime) {
                finalAssistantData.reasoningStartTime = Date.now();
                
                // Add initial "Thinking" placeholder if no summaries yet
                if (finalAssistantData.reasoningSummaries.length === 0) {
                    finalAssistantData.reasoningSummaries.push({ index: 0, summary: 'Thinking', isPlaceholder: true });
                }
            }
            
            finalAssistantData.liveReasoning = accumulated;
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { 
                        ...newMessages[idx], 
                        liveReasoning: accumulated,
                        reasoningSummaries: [...finalAssistantData.reasoningSummaries]
                    };
                }
                return newMessages;
            });
        });

        // Handle reasoning summaries
        streamHandler.onReasoningSummary(({ streamId, summaryIndex, summary }) => {
            // Remove the placeholder "Thinking" when first real summary arrives
            if (finalAssistantData.reasoningSummaries.length > 0 && 
                finalAssistantData.reasoningSummaries[0].isPlaceholder) {
                finalAssistantData.reasoningSummaries.shift();
            }
            
            finalAssistantData.reasoningSummaries.push({ index: summaryIndex, summary });
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { 
                        ...newMessages[idx], 
                        reasoningSummaries: [...finalAssistantData.reasoningSummaries] 
                    };
                }
                return newMessages;
            });
        });

        // Handle MCP approval requests (remote MCP tools requiring user approval)
        streamHandler.onMcpApprovalRequest((approvalRequest) => {
            // MCP approval request received during streaming
            // Store in finalAssistantData to be processed after stream completes
            if (!finalAssistantData.mcpApprovalRequests) {
                finalAssistantData.mcpApprovalRequests = [];
            }
            finalAssistantData.mcpApprovalRequests.push({
                ...approvalRequest,
                type: 'mcp_approval_request' // Mark type for handleToolApproval
            });
        });

        // Handle compound-beta tool execution streaming
        streamHandler.onToolExecution(({ type, tool }) => {
            // Ensure liveExecutedTools is an array (defensive against race conditions with onComplete)
            if (!Array.isArray(finalAssistantData.liveExecutedTools)) {
                finalAssistantData.liveExecutedTools = [];
            }
            
            if (type === 'start') {
                // Add or update tool in live list
                const updatedLiveTools = [...finalAssistantData.liveExecutedTools];
                const existingIndex = updatedLiveTools.findIndex(t => t.index === tool.index);
                
                if (existingIndex === -1) {
                    updatedLiveTools.push(tool);
                } else {
                    // Merge tool data to preserve any existing properties
                    updatedLiveTools[existingIndex] = { ...updatedLiveTools[existingIndex], ...tool };
                }
                
                finalAssistantData.liveExecutedTools = updatedLiveTools;
            } else if (type === 'complete') {
                // Update tool with complete data including output
                const updatedLiveTools = [...finalAssistantData.liveExecutedTools];
                // Try to match by index first, then by name as fallback
                let existingIndex = updatedLiveTools.findIndex(t => t.index === tool.index);
                if (existingIndex === -1 && tool.name) {
                    // Fallback: find by name if index doesn't match
                    existingIndex = updatedLiveTools.findIndex(t => t.name === tool.name && !t.output);
                }
                
                if (existingIndex !== -1) {
                    // Merge complete data with existing tool to preserve properties like type, arguments
                    updatedLiveTools[existingIndex] = { 
                        ...updatedLiveTools[existingIndex], 
                        ...tool,
                        // Ensure output is set (this is the key property for completion)
                        output: tool.output 
                    };
                    finalAssistantData.liveExecutedTools = updatedLiveTools;
                } else {
                    // Handle case where complete event arrives before start (shouldn't happen but defensive)
                    console.warn(`Received complete event for tool ${tool.name} (index ${tool.index}) without corresponding start event`);
                    updatedLiveTools.push(tool);
                    finalAssistantData.liveExecutedTools = updatedLiveTools;
                }
            }
            
            // Double-check before spreading (extra safety)
            const toolsToSet = Array.isArray(finalAssistantData.liveExecutedTools) 
                ? [...finalAssistantData.liveExecutedTools] 
                : [];
            
            setMessages(prev => {
                const newMessages = [...prev];
                const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                if (idx !== -1) {
                    newMessages[idx] = { ...newMessages[idx], liveExecutedTools: toolsToSet };
                }
                return newMessages;
            });
        });

        // Handle stream completion
        await new Promise((resolve, reject) => {
            streamHandler.onComplete((data) => {
                // Use existing duration if already set, otherwise calculate it now
                let reasoningDuration = finalAssistantData.reasoningDuration;
                if (!reasoningDuration && finalAssistantData.reasoningStartTime && data.reasoning) {
                    reasoningDuration = Math.round((Date.now() - finalAssistantData.reasoningStartTime) / 1000);
                }
                
                finalAssistantData = {
                    role: 'assistant',
                    content: data.content || '',
                    tool_calls: data.tool_calls,
                    reasoning: data.reasoning,
                    executed_tools: data.executed_tools,
                    // Clear live streaming data on completion
                    liveReasoning: undefined,
                    liveExecutedTools: undefined,
                    // Keep the reasoning summaries
                    reasoningSummaries: finalAssistantData.reasoningSummaries,
                    reasoningDuration: reasoningDuration,
                    usage: data.usage,
                    pre_calculated_tool_responses: data.pre_calculated_tool_responses,
                    // MCP approval requests from server
                    mcp_approval_requests: data.mcp_approval_requests || finalAssistantData.mcpApprovalRequests,
                    finish_reason: data.finish_reason
                };
                turnAssistantMessage = finalAssistantData; // Store the completed message

                setMessages(prev => {
                    const newMessages = [...prev];
                    const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                    if (idx !== -1) {
                        newMessages[idx] = finalAssistantData; // Replace placeholder
                    } else {
                        // Should not happen if placeholder logic is correct
                        console.warn("Streaming placeholder not found for replacement.");
                        newMessages.push(finalAssistantData);
                    }
                    return newMessages;
                });
                // Voice agent: speak any trailing partial sentence of this turn
                voiceAgentRef.current?.flushAssistantTurn();
                resolve();
            });

            streamHandler.onError(({ error }) => {
                console.error('Stream error received:', error);
                console.log('Error details:', { error });
                voiceAgentRef.current?.cancelSpeech();
                // Replace placeholder with error
                setMessages(prev => {
                    const newMessages = [...prev];
                    const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                    const errorMsg = { role: 'assistant', content: `Error: ${error}`, isStreaming: false };
                    if (idx !== -1) {
                        newMessages[idx] = errorMsg;
                    } else {
                        newMessages.push(errorMsg);
                    }
                    return newMessages;
                });
                reject(new Error(error));
            });

            streamHandler.onCancelled(() => {
                console.log('Stream was cancelled by user');
                voiceAgentRef.current?.cancelSpeech();
                // Remove the streaming placeholder or mark it as cancelled
                setMessages(prev => {
                    const newMessages = [...prev];
                    const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
                    if (idx !== -1) {
                        // If there's content, keep it; otherwise remove the placeholder
                        if (finalAssistantData.content.trim()) {
                            newMessages[idx] = {
                                role: 'assistant',
                                content: finalAssistantData.content,
                                isStreaming: false
                            };
                        } else {
                            // Remove empty placeholder
                            newMessages.splice(idx, 1);
                        }
                    }
                    return newMessages;
                });
                // Resolve with a special status to indicate cancellation
                currentTurnStatus = 'cancelled';
                reject(new Error('CANCELLED'));
            });

            streamHandler.onRetry(({ attempt, maxAttempts, error, newTemperature }) => {
                console.log(`🔄 Retry attempt ${attempt}/${maxAttempts}:`);
                console.log(`  Error: ${error}`);
                console.log(`  New temperature: ${newTemperature}`);
            });
        });

        // Clean up stream handlers
        streamHandler.cleanup();

        // Check and process tool calls if any
            if (turnAssistantMessage && turnAssistantMessage.tool_calls?.length > 0) {
            let handledIds = new Set();
            let preCalculatedMessages = [];

            if (turnAssistantMessage.pre_calculated_tool_responses) {
                 // Map pre-calculated responses to message format
                 preCalculatedMessages = turnAssistantMessage.pre_calculated_tool_responses.map(r => ({
                     role: 'tool',
                     content: r.content,
                     tool_call_id: r.tool_call_id
                 }));
                 
                 preCalculatedMessages.forEach(m => handledIds.add(m.tool_call_id));

                 // Update UI with tool results immediately
                 setMessages(prev => [...prev, ...preCalculatedMessages]);
                 
                 // Add to turnToolResponses accumulator
                 turnToolResponses = [...preCalculatedMessages];
            }

            // Check for unhandled tool calls
            // Filter out:
            // 1. Tool calls that have pre-calculated responses (already in handledIds)
            // 2. Remote MCP tool calls (have server_label set) - these are executed server-side by Groq
            const unhandledToolCalls = turnAssistantMessage.tool_calls.filter(tc => {
                return !handledIds.has(tc.id) && !tc.server_label;
            });
            
            if (unhandledToolCalls.length > 0) {
                // Create a proxy message with only unhandled tool calls for the processor
                const proxyAssistantMessage = {
                    ...turnAssistantMessage,
                    tool_calls: unhandledToolCalls
                };
                
                // Standard processing: Execute unhandled tools locally
                // IMPORTANT: Pass the messages *before* this assistant message was added
                const { status: toolProcessingStatus, toolResponseMessages } = await processToolCalls(
                    proxyAssistantMessage,
                    turnMessages // Pass the input messages for this turn
                );
    
                turnToolResponses = [...turnToolResponses, ...toolResponseMessages]; // Combine responses
    
                if (toolProcessingStatus === 'paused') {
                    currentTurnStatus = 'paused'; // Signal pause to the caller
                } else if (toolProcessingStatus === 'cancelled') {
                    currentTurnStatus = 'cancelled'; // Signal cancellation to the caller
                } else if (toolProcessingStatus === 'completed') {
                     // If tools completed, the caller might loop
                    currentTurnStatus = 'completed_with_tools';
                } else { // Handle potential errors from processToolCalls if added
                    currentTurnStatus = 'error';
                }
            } else {
                 // All tools were handled by server
                 currentTurnStatus = 'completed_no_tools';
            }
        } else {
             // No tools, this turn is complete
            currentTurnStatus = 'completed_no_tools';
        }

        // Handle MCP approval requests (remote tools requiring user approval)
        // These are received when require_approval is set to "always" for a connector/remote MCP server
        if (turnAssistantMessage?.mcp_approval_requests?.length > 0 || 
            turnAssistantMessage?.finish_reason === 'mcp_approval_required') {
            
            const mcpApprovalRequests = turnAssistantMessage.mcp_approval_requests || [];
            
            if (mcpApprovalRequests.length > 0) {
                // Process the first MCP approval request
                const firstApprovalRequest = mcpApprovalRequests[0];
                
                // Show approval modal for the first request
                setPendingApprovalCall({
                    ...firstApprovalRequest,
                    type: 'mcp_approval_request' // Ensure type is set for modal
                });
                
                // Store state for resuming after approval
                // IMPORTANT: We need to store the approval requests themselves to include them in the next input
                setPausedChatState({
                    currentMessages: turnMessages,
                    finalAssistantMessage: turnAssistantMessage,
                    accumulatedResponses: turnToolResponses,
                    pendingMcpApprovals: mcpApprovalRequests.slice(1), // Remaining approvals
                    mcpApprovalRequestItems: mcpApprovalRequests // Store all approval request items
                });
                
                currentTurnStatus = 'paused';
            }
        }

    } catch (error) {
      console.error('Error in executeChatTurn:', error);
      
      // Check if this was a cancellation
      if (error.message === 'CANCELLED') {
        console.log('Chat turn was cancelled');
        currentTurnStatus = 'cancelled';
      } else {
        // Ensure placeholder is replaced or an error message is added
        setMessages(prev => {
            const newMessages = [...prev];
            const idx = newMessages.findIndex(msg => msg.role === 'assistant' && msg.isStreaming);
            const errorMsg = { role: 'assistant', content: `Error: ${error.message}`, isStreaming: false };
              if (idx !== -1) {
                  newMessages[idx] = errorMsg;
              } else {
                  // If streaming never started, add the error message
                  newMessages.push(errorMsg);
              }
            return newMessages;
        });
        currentTurnStatus = 'error';
      }
    }

    // Return the outcome of the turn
    return {
        status: currentTurnStatus, // 'completed_no_tools', 'completed_with_tools', 'paused', 'error', 'cancelled'
        assistantMessage: turnAssistantMessage,
        toolResponseMessages: turnToolResponses,
    };
  };

  // Handle sending message (text or structured content with images)
  // Summarize the conversation with its own model; the summary replaces the
  // older messages in every later request. Returns the new message list.
  const compactConversation = async ({ instructions = '', auto = false, baseMessages } = {}) => {
    const source = baseMessages || messages;
    const view = applyCompaction(source);
    if (!currentChatId || !view.some((m) => m.role === 'assistant')) {
      setCompactState({ state: 'info', message: 'Nothing to compact yet.' });
      return null;
    }
    const limit = resolveContextWindow(selectedModel, modelConfigs, contextPrefs.contextWindow);
    const tokensBefore = estimateContextTokens(source).tokens;
    if (tokensBefore < MIN_COMPACT_TOKENS) {
      // Auto-compact skips quietly; a manual request says why nothing happened
      if (!auto) {
        setCompactState({
          state: 'info',
          message: `Only ${formatTokens(tokensBefore)} tokens in context. Chats under ${formatTokens(MIN_COMPACT_TOKENS)} are not compacted.`,
        });
      }
      return null;
    }
    setCompactState({
      state: 'running',
      message: auto ? 'Context is nearly full. Compacting the conversation…' : 'Compacting the conversation…',
    });
    // Only what the summarizer reads crosses IPC: no images, no UI state
    const transport = view.map((m) => ({
      role: m.role,
      name: m.name,
      tool_calls: m.tool_calls,
      content: Array.isArray(m.content)
        ? m.content.map((part) => (part?.type === 'image_url' ? { type: 'text', text: '[image]' } : part))
        : m.content,
    }));
    try {
      const result = await window.electron.chatHistory.compact(transport, selectedModel, { instructions, contextWindow: limit });
      if (!result?.summary) throw new Error(result?.error || 'The model returned no summary');
      const marker = {
        role: 'system',
        content: result.summary,
        compaction: {
          auto,
          at: new Date().toISOString(),
          tokensBefore,
          model: selectedModel,
          ...(instructions ? { instructions } : {}),
        },
      };
      const next = [...source, marker];
      setMessages(next);
      setCompactState(null);
      return next;
    } catch (error) {
      console.error('[Compact] Failed:', error);
      setCompactState({ state: 'error', message: `Compaction failed: ${error.message || error}` });
      return null;
    }
  };

  const handleCompactNow = async (instructions = '') => {
    if (loadingRef.current) return;
    setLoading(true);
    try {
      await compactConversation({ instructions });
    } finally {
      setLoading(false);
    }
  };

  const handleSendMessage = async (content, extra = {}) => {
    // Check if content is structured (array) or just text (string)
    const isStructuredContent = Array.isArray(content);
    const hasContent = isStructuredContent ? content.some(part => (part.type === 'text' && part.text.trim()) || part.type === 'image_url') : content.trim();

    if (!hasContent) return;

    // "/compact [instructions]" summarizes instead of sending
    const compactCommand = parseCompactCommand(content);
    if (compactCommand) {
      await handleCompactNow(compactCommand.instructions);
      return;
    }

    // While screen/camera capture is active, attach what's on screen now. A
    // released held turn also brings the frames banked at each utterance, so
    // the model sees the screens that were talked about, not just the last.
    if (captureRef.current?.mode) {
      const held = Array.isArray(extra.frames) ? extra.frames : [];
      const finalShot = captureRef.current.captureFrameWithSignature({ maxWidth: 1920, quality: 0.75 });
      const frames = mergeFinalFrame(held, finalShot, extra.heldMs);
      if (frames.length) {
        const parts = isStructuredContent ? [...content] : [{ type: 'text', text: content }];
        parts.push(...buildFrameParts(frames));
        content = parts;
      }
    }

    // Auto-compact: summarize first when this message would push the context
    // past the threshold
    let baseMessages = messages;
    if (contextPrefs.autoCompact && currentChatId && messages.length > 0) {
      const limit = resolveContextWindow(selectedModel, modelConfigs, contextPrefs.contextWindow);
      const projected = estimateContextTokens([...messages, { role: 'user', content }]).tokens;
      if (projected >= limit * contextPrefs.threshold && projected >= MIN_COMPACT_TOKENS) {
        setLoading(true);
        const compacted = await compactConversation({ auto: true, baseMessages: messages });
        if (compacted) baseMessages = compacted;
      }
    }

    // If no current chat exists, create one first with current API mode
    if (!currentChatId) {
      await createNewChat(selectedModel, useResponsesApi);
    }

    // Reset cancellation flag for new message
    cancelledRef.current = false;
    
    // Reset user scrolling flag so new messages auto-scroll
    userScrollingRef.current = false;
    setIsUserScrolling(false);

    // Format the user message based on content type
    const userMessage = {
      role: 'user',
      content: content // Assumes ChatInput now sends the correct structured format
    };
    // Add user message optimistically BEFORE the API call
    const initialMessages = [...baseMessages, userMessage];
    setMessages(initialMessages);

    setLoading(true);

    let currentApiMessages = initialMessages; // Start with messages including the new user one
    let conversationStatus = 'processing'; // Start the conversation flow
    let emptyResponseRetries = 0; // Track retries for empty responses
    const MAX_EMPTY_RETRIES = 3; // Maximum retries for empty responses

    try {
        while (conversationStatus === 'processing' || conversationStatus === 'completed_with_tools') {
            const { status, assistantMessage, toolResponseMessages } = await executeChatTurn(currentApiMessages);

            conversationStatus = status; // Update status for loop condition

            if (status === 'paused') {
                 // Pause initiated by executeChatTurn/processToolCalls
                 // Loading state remains true, waiting for modal interaction
                 break; // Exit the loop
            } else if (status === 'cancelled') {
                 // Stream was cancelled by user
                 console.log('Conversation cancelled by user');
                 break;
            } else if (status === 'error') {
                 // Error occurred, stop the loop
                  break;
            } else if (status === 'completed_with_tools') {
                  // Reset empty response retry counter since we got valid tool calls
                  emptyResponseRetries = 0;
                  
                  // Prepare messages for the next turn ONLY if tools were completed
                  if (assistantMessage && toolResponseMessages.length > 0) {
                      // Format tool responses for the API
                      const formattedToolResponses = toolResponseMessages.map(msg => ({
                          role: 'tool',
                          content: msg.content, // Ensure this is a string
                          tool_call_id: msg.tool_call_id
                      }));
                      // Append assistant message and tool responses for the next API call
                      currentApiMessages = [
                          ...currentApiMessages,
                          { // Assistant message that included the tool calls
                            role: assistantMessage.role,
                            content: assistantMessage.content,
                            tool_calls: assistantMessage.tool_calls
                          },
                          ...formattedToolResponses
                      ];
                      // Loop continues as conversationStatus is 'completed_with_tools'
                  } else {
                      // Should not happen if status is completed_with_tools, but safety break
                      console.warn("Status 'completed_with_tools' but no assistant message or tool responses found.");
                      conversationStatus = 'error'; // Treat as error
                      break;
                  }
            } else if (status === 'completed_no_tools') {
                  // Conversation turn finished without tools
                  // Check if we got an empty response (only reasoning, no content)
                  // Note: Don't treat as empty if there are tool calls (e.g. Responses API might return tool calls with no content if that was the intent)
                  const hasContent = assistantMessage.content && assistantMessage.content.trim() !== '';
                  const hasToolCalls = assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0;
                  
                  if (assistantMessage && !hasContent && !hasToolCalls) {
                      if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
                          emptyResponseRetries++;
                          console.warn(`[Frontend] Model completed with no content. Retrying (${emptyResponseRetries}/${MAX_EMPTY_RETRIES})...`);
                          
                          // Remove the empty assistant message from the UI
                          setMessages(prev => {
                              const newMessages = [...prev];
                              // Find and remove the last assistant message (which has empty content)
                              const lastAssistantIdx = newMessages.map((m, i) => ({ idx: i, msg: m }))
                                  .reverse()
                                  .find(({ msg }) => msg.role === 'assistant')?.idx;
                              if (lastAssistantIdx !== undefined) {
                                  newMessages.splice(lastAssistantIdx, 1);
                              }
                              return newMessages;
                          });
                          
                          // Retry with the same messages (don't modify currentApiMessages)
                          conversationStatus = 'processing';
                      } else {
                          // Max retries reached, show error
                          console.error('[Frontend] Max retries reached for empty response. Stopping.');
                          setMessages(prev => {
                              const newMessages = [...prev];
                              // Find and replace the last assistant message with error
                              const lastAssistantIdx = newMessages.map((m, i) => ({ idx: i, msg: m }))
                                  .reverse()
                                  .find(({ msg }) => msg.role === 'assistant')?.idx;
                              if (lastAssistantIdx !== undefined) {
                                  newMessages[lastAssistantIdx] = {
                                      role: 'assistant',
                                      content: 'Error: Model failed to generate a response after multiple attempts.'
                                  };
                              }
                              return newMessages;
                          });
                          break;
                      }
                  } else {
                      // Normal completion with content, stop the loop
                      break;
                  }
            }
        } // End while loop

    } catch (error) {
        // Catch errors originating directly in handleSendMessage loop (unlikely with refactor)
        console.error('Error in handleSendMessage conversation flow:', error);
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error.message}` }]);
        conversationStatus = 'error'; // Ensure loading state is handled
    } finally {
        // Only set loading false if the conversation is not paused
        if (conversationStatus !== 'paused') {
            setLoading(false);
        }
    }
  };

  // --- Voice agent (Kokoro TTS + Silero VAD) and screenshare/camera capture ---
  // Surface capture/agent failures in the chat — DevTools-only errors read as
  // the buttons silently doing nothing
  const showSessionError = (tag, message) => {
    console.error(tag, message);
    setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${message}` }]);
  };

  const capture = useMediaCapture({
    onError: (message) => showSessionError('[Capture]', message),
  });
  captureRef.current = capture;

  const voiceAgent = useVoiceAgent({
    onTranscript: (text, extra) => handleSendMessage(text, extra),
    onStopGeneration: handleStopGeneration,
    loadingRef,
    onError: (message) => showSessionError('[VoiceAgent]', message),
    // Intermediate frames are context, not the thing being pointed at, so
    // they go smaller; the send-time frame keeps full size.
    captureHeldFrame: () =>
      captureRef.current?.mode
        ? captureRef.current.captureFrameWithSignature({ maxWidth: 1024, quality: 0.6 })
        : null,
    frameBudgetRef,
    autoRead: readingPrefs.ttsAutoRead,
  });
  voiceAgentRef.current = voiceAgent;

  // Read-aloud controls handed to the transcript: play a whole reply, or just
  // a selection inside one, with pause and speed while it runs.
  const speech = useMemo(
    () => ({
      supported: voiceAgent.supported,
      speed: voiceAgent.speed,
      readAloud: voiceAgent.readAloud,
      pause: voiceAgent.pauseSpeech,
      resume: voiceAgent.resumeSpeech,
      stop: voiceAgent.stopSpeech,
      speedSteps: SPEED_STEPS,
      setSpeed: voiceAgent.setSpeed,
      // A reply read while streaming carries a token that resolves to its
      // message index once it has rendered
      tokenState: (token) =>
        resolveToken(voiceAgent.playback.token) === token ? voiceAgent.playback.state : 'idle',
      // Follow-along: where the voice is, jumping, and the reading preferences
      cursorStore: voiceAgent.readCursorStore,
      jumpTo: voiceAgent.jumpTo,
      skip: voiceAgent.skipSentence,
      prefs: readingPrefs,
    }),
    [voiceAgent.supported, voiceAgent.speed, voiceAgent.readAloud, voiceAgent.pauseSpeech, voiceAgent.resumeSpeech, voiceAgent.stopSpeech, voiceAgent.setSpeed, voiceAgent.playback, voiceAgent.readCursorStore, voiceAgent.jumpTo, voiceAgent.skipSentence, readingPrefs]
  );

  // Context meter for the input bar
  const contextUsage = useMemo(() => {
    const limit = resolveContextWindow(selectedModel, modelConfigs, contextPrefs.contextWindow);
    const { tokens, measured } = estimateContextTokens(messages);
    return { tokens, limit, measured, autoCompact: contextPrefs.autoCompact, threshold: contextPrefs.threshold };
  }, [messages, selectedModel, modelConfigs, contextPrefs]);

  // Leaving a chat ends a read-aloud (its token is a message position, which
  // would land on an unrelated message in the next chat) and clears any
  // compaction notice
  const prevChatIdRef = useRef(currentChatId);
  useEffect(() => {
    const prev = prevChatIdRef.current;
    prevChatIdRef.current = currentChatId;
    if (prev && prev !== currentChatId) {
      if (voiceAgentRef.current?.playback?.token != null) voiceAgentRef.current.stopSpeech();
      setCompactState(null);
    }
  }, [currentChatId]);

  // Notices fade on their own; a running compaction stays until it ends
  useEffect(() => {
    if (!compactState || compactState.state === 'running') return undefined;
    const timer = setTimeout(() => setCompactState(null), 6000);
    return () => clearTimeout(timer);
  }, [compactState]);

  // Screenshare/camera are only offered during voice sessions — stop any
  // active capture when the agent turns off
  useEffect(() => {
    if (!voiceAgent.active && capture.mode) {
      capture.stopCapture();
    }
  }, [voiceAgent.active, capture.mode, capture.stopCapture]);
  // --- End voice agent / capture ---

  // --- Placeholder for resuming chat after modal interaction ---
  const resumeChatFlow = async (handledToolResponse) => {
      if (!pausedChatState) {
          console.error("Attempted to resume chat flow without paused state.");
          setLoading(false); // Ensure loading indicator stops
          return;
      }

      // Check if operation was cancelled
      if (cancelledRef.current) {
          console.log('Resume chat flow cancelled by user');
          setLoading(false);
          return;
      }

      const { currentMessages, finalAssistantMessage, accumulatedResponses } = pausedChatState;
      setPausedChatState(null); // Clear the paused state

      const allResponsesForTurn = [...accumulatedResponses, handledToolResponse];

      // Find the index of the tool that caused the pause
      const pausedToolIndex = finalAssistantMessage.tool_calls.findIndex(
          tc => tc.id === handledToolResponse.tool_call_id // Match based on ID
      );

      if (pausedToolIndex === -1) {
          console.error("Could not find the paused tool call in the original message.");
          setLoading(false);
          return; // Cannot proceed
      }

      const remainingTools = finalAssistantMessage.tool_calls.slice(pausedToolIndex + 1);
      let needsPauseAgain = false;

      // Process remaining tools
      for (const nextToolCall of remainingTools) {
        // Check if operation was cancelled
        if (cancelledRef.current) {
            console.log('Tool execution cancelled by user during resume');
            setLoading(false);
            return;
        }

        const toolName = nextToolCall.function.name;
        const approvalStatus = getToolApprovalStatus(toolName);

        if (approvalStatus === 'always' || approvalStatus === 'yolo') {
            console.log(`Resuming: Tool '${toolName}' automatically approved (${approvalStatus}). Executing...`);
            try {
                // Check before executing
                if (cancelledRef.current) {
                    console.log('Tool execution cancelled by user before executing');
                    setLoading(false);
                    return;
                }
                
                const resultMsg = await executeToolCall(nextToolCall);
                
                // Check after executing
                if (cancelledRef.current) {
                    console.log('Tool execution cancelled by user after tool completed');
                    setLoading(false);
                    return;
                }
                
                allResponsesForTurn.push(resultMsg);
                setMessages(prev => [...prev, resultMsg]); // Update UI immediately
            } catch (error) {
                console.error(`Resuming: Error executing tool call '${toolName}':`, error);
                const errorMsg = { role: 'tool', content: JSON.stringify({ error: `Error executing tool '${toolName}': ${error.message}` }), tool_call_id: nextToolCall.id };
                allResponsesForTurn.push(errorMsg);
                setMessages(prev => [...prev, errorMsg]);
            }
        } else { // Needs prompt again
            console.log(`Resuming: Tool '${toolName}' requires user approval.`);
            setPendingApprovalCall(nextToolCall);
            // Save state again, including the responses gathered *during* this resume attempt
            setPausedChatState({
                currentMessages: currentMessages, // Original messages before assistant response
                finalAssistantMessage: finalAssistantMessage,
                accumulatedResponses: allResponsesForTurn // All responses UP TO this new pause
            });
            needsPauseAgain = true;
            break; // Stop processing remaining tools
        }
      }

      if (needsPauseAgain) {
        // Loading state remains true, waiting for the next modal interaction
        console.log("Chat flow paused again for the next tool.");
      } else {
        // All remaining tools were processed. Prepare for the next API call.
        console.log("All tools for the turn processed. Continuing conversation.");
        setLoading(true); // Show loading for the next API call

        const nextApiMessages = [
            ...currentMessages, // History BEFORE the assistant message with tools
            { // The assistant message itself
                role: finalAssistantMessage.role,
                content: finalAssistantMessage.content,
                tool_calls: finalAssistantMessage.tool_calls,
            },
            // Map ALL tool responses for the completed turn
            ...allResponsesForTurn.map(msg => ({
                role: 'tool',
                content: msg.content,
                tool_call_id: msg.tool_call_id
            }))
        ];

        // Continue the conversation loop by executing the next turn
        // This recursively calls the main logic, effectively continuing the loop
        // Pass the fully prepared message list for the *next* API call
        // We need to handle the loading state correctly after this returns
        try {
             // Start the next turn
              const { status: nextTurnStatus } = await executeChatTurn(nextApiMessages);
              // If the *next* turn also pauses, loading state remains true
              if (nextTurnStatus !== 'paused') {
                  setLoading(false);
              }
        } catch (error) {
            // Check if this was a cancellation
            if (error.message !== 'CANCELLED') {
                console.error("Error during resumed chat turn:", error);
                setMessages(prev => [...prev, { role: 'assistant', content: `Error after resuming: ${error.message}` }]);
            }
            setLoading(false); // Stop loading on error or cancellation
        }
      }
  };

  // --- Placeholder for handling modal choice ---
  const handleToolApproval = async (choice, toolCall) => {
      if (!toolCall || !toolCall.id) {
          console.error("handleToolApproval called with invalid toolCall:", toolCall);
          return;
      }
      
      // Check if this is an MCP approval request (remote tool)
      const isMcpApprovalRequest = toolCall.type === 'mcp_approval_request';
      const toolName = isMcpApprovalRequest ? toolCall.name : toolCall.function?.name;
      

      // Clear the pending call *before* executing/resuming
      setPendingApprovalCall(null);

      // Update localStorage based on choice
      setToolApprovalStatus(toolName, choice);

      if (isMcpApprovalRequest) {
          // Handle MCP approval request - need to send approval/denial back to the API
          await handleMcpApprovalResponse(choice, toolCall);
      } else {
          // Handle local tool call
          let handledToolResponse;

          if (choice === 'deny') {
              handledToolResponse = {
                  role: 'tool',
                  content: JSON.stringify({ error: 'Tool execution denied by user.' }),
                  tool_call_id: toolCall.id
              };
              setMessages(prev => [...prev, handledToolResponse]); // Show denial in UI
              // Resume processing potential subsequent tools
              await resumeChatFlow(handledToolResponse);
          } else { // 'once', 'always', 'yolo' -> Execute the tool
              setLoading(true); // Show loading specifically for tool execution phase
              try {
                  console.log(`Executing tool '${toolName}' after user approval...`);
                  handledToolResponse = await executeToolCall(toolCall);
                  setMessages(prev => [...prev, handledToolResponse]); // Show result in UI
                  // Resume processing potential subsequent tools
                  await resumeChatFlow(handledToolResponse);
              } catch (error) {
                  console.error(`Error executing approved tool call '${toolName}':`, error);
                  handledToolResponse = {
                      role: 'tool',
                      content: JSON.stringify({ error: `Error executing tool '${toolName}' after approval: ${error.message}` }),
                      tool_call_id: toolCall.id
                  };
                  setMessages(prev => [...prev, handledToolResponse]); // Show error in UI
                  // Still try to resume processing subsequent tools even if this one failed
                  await resumeChatFlow(handledToolResponse);
              } finally {
                  // Loading state will be handled by resumeChatFlow or set to false if it errors/completes fully
                  // setLoading(false); // Don't set false here, resumeChatFlow handles it
              }
          }
      }
  };

  // Handle MCP approval response - send approval/denial back to the API
  const handleMcpApprovalResponse = async (choice, approvalRequest) => {
      if (!pausedChatState) {
          console.error("handleMcpApprovalResponse called without paused state");
          setLoading(false);
          return;
      }

      const { currentMessages, finalAssistantMessage, accumulatedResponses, pendingMcpApprovals, mcpApprovalRequestItems } = pausedChatState;
      
      // Determine approval decision
      const approved = choice !== 'deny';
      

      // Create the approval response item for the API
      const approvalResponseItem = {
          type: 'mcp_approval_response',
          approval_request_id: approvalRequest.id,
          approve: approved,
          // Include reason if denied
          ...((!approved) && { reason: 'User denied the tool execution' })
      };

      // Check if there are more pending approvals
      if (pendingMcpApprovals && pendingMcpApprovals.length > 0) {
          // Show modal for the next approval request
          const nextApproval = pendingMcpApprovals[0];
          setPendingApprovalCall({
              ...nextApproval,
              type: 'mcp_approval_request'
          });
          
          // Update paused state with the response and remaining approvals
          setPausedChatState({
              currentMessages,
              finalAssistantMessage,
              accumulatedResponses: [...accumulatedResponses, approvalResponseItem],
              pendingMcpApprovals: pendingMcpApprovals.slice(1),
              mcpApprovalRequestItems
          });
          return; // Wait for next approval
      }

      // All approvals handled, continue the conversation
      setPausedChatState(null);
      setLoading(true);

      try {
          // Build the input for the next API call
          // For Responses API with MCP approvals:
          // 1. Include original conversation history
          // 2. Include the mcp_approval_request items (output from previous response)
          // 3. Include the mcp_approval_response items (our responses)
          
          const allApprovalResponses = [...accumulatedResponses, approvalResponseItem]
              .filter(r => r.type === 'mcp_approval_response');
          
          // Build messages for the next turn
          const nextApiMessages = [
              ...currentMessages,
              // Include the assistant's message content if any
              ...(finalAssistantMessage.content ? [{
                  role: 'assistant',
                  content: finalAssistantMessage.content,
                  // Include any tool calls that were made
                  ...(finalAssistantMessage.tool_calls && { tool_calls: finalAssistantMessage.tool_calls })
              }] : []),
              // Include the mcp_approval_request items from the response
              // These need to be in the input so the API knows what we're responding to
              ...(mcpApprovalRequestItems || []).map(req => ({
                  type: 'mcp_approval_request',
                  id: req.id,
                  name: req.name,
                  server_label: req.server_label,
                  arguments: req.arguments
              })),
              // Add our approval responses
              ...allApprovalResponses.map(r => ({
                  type: 'mcp_approval_response',
                  approval_request_id: r.approval_request_id,
                  approve: r.approve,
                  ...(r.reason && { reason: r.reason })
              }))
          ];


          // Continue the conversation with the approval responses
          const { status: nextTurnStatus } = await executeChatTurn(nextApiMessages);
          
          if (nextTurnStatus !== 'paused') {
              setLoading(false);
          }
      } catch (error) {
          if (error.message !== 'CANCELLED') {
              console.error("Error during MCP approval continuation:", error);
              setMessages(prev => [...prev, { role: 'assistant', content: `Error after approval: ${error.message}` }]);
          }
          setLoading(false);
      }
  };

  // Disconnect from an MCP server
  const disconnectMcpServer = async (serverId) => {
    try {
      const result = await window.electron.disconnectMcpServer(serverId);
      if (result && result.success) {
        if (result.allTools) {
          setMcpTools(result.allTools);
        } else {
          // If we don't get allTools back, just filter out the tools from this server
          setMcpTools(prev => prev.filter(tool => tool.serverId !== serverId));
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error disconnecting from MCP server:', error);
      return false;
    }
  };
  
  // Reconnect to an MCP server
  const reconnectMcpServer = async (serverId) => {
    try {
      // Get server configuration from settings
      const settings = await window.electron.getSettings();
      if (!settings.mcpServers || !settings.mcpServers[serverId]) {
        console.error(`Server configuration not found for ${serverId}`);
        return false;
      }
      
      // Get the full configuration object for the server
      const serverConfig = settings.mcpServers[serverId];

      // Connect to the server
      const result = await window.electron.connectMcpServer({
        ...serverConfig, // Spread the loaded config (includes transport, url/command, args, env)
        id: serverId      // Ensure ID is explicitly included
      });

      // --- Update tools state ONLY on success ---
      if (result && result.success) {
        // Update tools based on the result
        if (result.allTools) {
          setMcpTools(result.allTools);
        } else if (result.tools) {
          // Fallback logic if allTools isn't provided but tools is
          setMcpTools(prev => {
            const filteredTools = prev.filter(tool => tool.serverId !== serverId);
            return [...filteredTools, ...(result.tools || [])];
          });
        }
        // Do NOT return true here, let the full result propagate
      }

      // Return the result object regardless of success/failure/requiresAuth
      // ToolsPanel will handle the requiresAuth flag
      return result;
    } catch (error) {
      console.error('Error reconnecting to MCP server:', error);
      // Return an error structure consistent with what ToolsPanel might expect
      return { success: false, error: error.message || 'An unknown error occurred', requiresAuth: false }; 
    }
  };

  // Add this function to explicitly refresh MCP tools
  const refreshMcpTools = async () => {
    try {
      setMcpServersStatus({ loading: true, message: "Refreshing MCP connections..." });
      
      // Get latest settings
      const settings = await window.electron.getSettings();
      
      // Manually fetch the current tools
      const mcpToolsResult = await window.electron.getMcpTools();
      
      if (mcpToolsResult && mcpToolsResult.tools) {
        setMcpTools(mcpToolsResult.tools);
        updateServerStatus(mcpToolsResult.tools, settings);
      } else {
        console.warn("No MCP tools available");
        setMcpServersStatus({ loading: false, message: "No MCP tools available" });
      }
    } catch (error) {
      console.error('Error refreshing MCP tools:', error);
      setMcpServersStatus({ loading: false, message: "Error refreshing MCP tools" });
    }
  };

  // Handle creating a new chat
  const handleNewChat = useCallback(async () => {
    // Stop any ongoing streams before clearing
    if (loading) {
      console.log('Stopping streams before starting new chat...');
      window.electron.stopChatStream();
      setLoading(false);
      // Clear any pending tool approval state
      setPendingApprovalCall(null);
      setPausedChatState(null);
    }
    
    // Create a new chat in history with the current API mode
    await createNewChat(selectedModel, useResponsesApi);
  }, [loading, createNewChat, selectedModel, useResponsesApi]);

  // Handle when a chat is loaded from history - switch API mode if needed
  const handleChatLoaded = useCallback(async (chat) => {
    if (chat && chat.useResponsesApi !== undefined) {
      const chatApiMode = chat.useResponsesApi;
      
      // If the chat's API mode differs from current setting, update it
      if (chatApiMode !== useResponsesApi) {
        console.log(`[App] Switching API mode for chat: useResponsesApi=${chatApiMode}`);
        setUseResponsesApi(chatApiMode);
        
        // Also update the setting in storage so the chat handler uses it
        try {
          const settings = await window.electron.getSettings();
          if (settings.useResponsesApi !== chatApiMode) {
            await window.electron.saveSettings({ ...settings, useResponsesApi: chatApiMode });
          }
        } catch (error) {
          console.error('Error updating API mode setting:', error);
        }
      }
    }
  }, [useResponsesApi]);
  return (
    <div className="flex h-screen">
      {/* Chat History Sidebar */}
      <ChatHistorySidebar
        onNewChat={handleNewChat}
        onChatLoaded={handleChatLoaded}
        loading={loading}
        onCreateProject={() => setProjectModal({ mode: 'create', project: null })}
        onEditProject={(project) => setProjectModal({ mode: 'edit', project })}
        onOpenProjectKnowledge={() => setProjectKnowledgeOpen(true)}
      />
      
      {/* Main Content Area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Modern Sticky Header */}
        <header className="sticky top-0 z-50 glass">
          <div className="flex h-14 items-center justify-between px-4 max-w-full">
            <div className="flex items-center space-x-3">
              {/* Sidebar toggle for mobile/collapsed state */}
              {isSidebarCollapsed && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  title="Expand sidebar"
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              )}
              
              <div className="flex items-center space-x-2">
                <img 
                  src="./groqLogo.png" 
                  alt="Groq Logo" 
                  className="h-7 w-auto"
                />
              </div>
              
              {/* Status Badge */}
              {mcpTools.length > 0 && (
                <Badge variant="secondary" className="bg-secondary hover:bg-accent">
                  <Zap className="w-3 h-3 mr-1" />
                  {mcpTools.length} tools
                </Badge>
              )}
              
              {/* API Mode Indicator */}
              <span
                className="text-xs text-muted-foreground flex items-center gap-1 cursor-default"
                title={useResponsesApi ? "Using Responses API (supports agentic features)" : "Using Chat Completions API"}
              >
                {useResponsesApi ? (
                  <>
                    <Radio className="w-3 h-3" />
                    <span className="hidden sm:inline">Responses</span>
                  </>
                ) : (
                  <>
                    <MessagesSquare className="w-3 h-3" />
                    <span className="hidden sm:inline">Completions</span>
                  </>
                )}
              </span>

              {/* Active project — opens its instructions & files */}
              {currentProject && (
                <button
                  type="button"
                  onClick={() => setProjectKnowledgeOpen(true)}
                  className="flex items-center gap-1.5 max-w-[240px] rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-primary/15 transition-colors"
                  title={`Project: ${currentProject.name} — click to view instructions and files`}
                >
                  <FolderOpen className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <span className="truncate">{currentProject.name}</span>
                </button>
              )}
            </div>

            <div className="flex items-center space-x-2">
              {/* New Chat Button - only show when there are messages */}
              {messages.length > 0 && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleNewChat}
                  className="text-foreground hover:text-foreground"
                >
                  <MessageSquare className="h-4 w-4 mr-2" />
                  New Chat
                </Button>
              )}
              
              {/* Voice model load/unload moved to Settings > Text to Speech */}
              <Link to="/settings">
                <Button variant="ghost" size="icon" className="text-foreground hover:text-foreground">
                  <Settings className="h-5 w-5" />
                </Button>
              </Link>
            </div>
          </div>
        </header>

      {/* Main Content */}
      {/* TODO: Make the scroll area the entire width instead of the container while keeping the input at the bottom*/}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1600px] mx-auto py-8 px-8 h-full">
            <div className="h-full">
            {messages.length === 0 && currentProject ? (
              /* Project home: start a chat here, manage instructions & files */
              <div className="flex flex-col items-center min-h-full space-y-8 py-4">
                <div className="w-full max-w-3xl text-center space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <FolderOpen className="h-7 w-7 text-primary" />
                    <h1 className="text-3xl font-bold truncate">{currentProject.name}</h1>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => setProjectModal({ mode: 'edit', project: currentProject })}
                      title="Edit project name and description"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </div>
                  {currentProject.description ? (
                    <p className="text-lg text-muted-foreground max-w-2xl mx-auto">{currentProject.description}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Chats started here share the instructions and files of this project.
                    </p>
                  )}
                </div>

                {/* Chat Input */}
                <div className="w-full max-w-2xl">
                  <ChatInput
                    onSendMessage={handleSendMessage}
                    onStopGeneration={handleStopGeneration}
                    loading={loading}
                    models={sortedModels}
                    selectedModel={selectedModel}
                    onModelChange={setSelectedModel}
                    onOpenMcpTools={() => setIsToolsPanelOpen(true)}
                    modelConfigs={modelConfigs}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={setReasoningEffort}
                    voiceAgent={voiceAgent}
                    capture={capture}
                    contextUsage={contextUsage}
                    onCompact={() => handleCompactNow()}
                    compactState={compactState}
                  />
                </div>

                <div className="w-full max-w-3xl">
                  <ProjectKnowledgePanel project={currentProject} />
                </div>
              </div>
            ) : messages.length === 0 ? (
              /* Welcome Screen */
              <div className="flex flex-col items-center justify-center h-full space-y-8">
                <div className="text-center space-y-4">
                  <h1 className="text-4xl font-bold text-primary">
                    Build Fast
                  </h1>
                  <p className="text-xl text-muted-foreground max-w-2xl">
                    Try the speed of Groq…
                  </p>
                </div>

                {/* Chat Input */}
                <div className="w-full max-w-2xl">
                  <ChatInput
                    onSendMessage={handleSendMessage}
                    onStopGeneration={handleStopGeneration}
                    loading={loading}
                    models={sortedModels}
                    selectedModel={selectedModel}
                    onModelChange={setSelectedModel}
                    onOpenMcpTools={() => setIsToolsPanelOpen(true)}
                    modelConfigs={modelConfigs}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={setReasoningEffort}
                    voiceAgent={voiceAgent}
                    capture={capture}
                    contextUsage={contextUsage}
                    onCompact={() => handleCompactNow()}
                    compactState={compactState}
                  />
                </div>
              </div>
            ) : (
              /* Chat View */
              <div className="flex flex-col h-full min-h-0">
                <div 
                  ref={messagesContainerRef} 
                  className="flex-1 overflow-y-auto mb-6 min-h-0"
                  style={{ willChange: 'scroll-position' }}
                >
                  <MessageList 
                    messages={messages} 
                    onToolCallExecute={executeToolCall} 
                    onRemoveLastMessage={handleRemoveLastMessage}
                    onReloadFromMessage={handleReloadFromMessage}
                    onRewindToMessage={handleRewindToMessage}
                    speech={speech}
                    loading={loading}
                    onActionsVisible={scrollToBottom}
                  />
                  <div ref={messagesEndRef} />
                </div>
                
                <div className="flex-shrink-0 pt-6">
                  <ChatInput
                    onSendMessage={handleSendMessage}
                    onStopGeneration={handleStopGeneration}
                    loading={loading}
                    models={sortedModels}
                    selectedModel={selectedModel}
                    onModelChange={setSelectedModel}
                    onOpenMcpTools={() => setIsToolsPanelOpen(true)}
                    modelConfigs={modelConfigs}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={setReasoningEffort}
                    voiceAgent={voiceAgent}
                    capture={capture}
                    contextUsage={contextUsage}
                    onCompact={() => handleCompactNow()}
                    compactState={compactState}
                  />
                </div>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {isToolsPanelOpen && (
        <ToolsPanel
          tools={mcpTools}
          onClose={() => setIsToolsPanelOpen(false)}
                    onDisconnectServer={disconnectMcpServer}
          onReconnectServer={reconnectMcpServer}
        />
      )}

      {pendingApprovalCall && (
        <ToolApprovalModal
          toolCall={pendingApprovalCall}
                    onApprove={handleToolApproval}
        />
      )}

      {capture.pickerOpen && (
        <ScreenSourcePicker
          sources={capture.sources}
          onSelect={capture.startScreenshare}
          onClose={() => capture.setPickerOpen(false)}
        />
      )}

      {projectModal && (
        <ProjectModal
          mode={projectModal.mode}
          project={projectModal.project}
          onClose={() => setProjectModal(null)}
        />
      )}

      {projectKnowledgeOpen && currentProject && (
        <ProjectKnowledgeModal
          project={currentProject}
          onClose={() => setProjectKnowledgeOpen(false)}
          onEdit={() => {
            setProjectKnowledgeOpen(false);
            setProjectModal({ mode: 'edit', project: currentProject });
          }}
        />
      )}
      </div>
    </div>
  );
}

export default App; 