import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, Plus, Trash2, Edit3, Save, X, RefreshCw, Key, Settings as SettingsIcon, Zap, Cpu, Server, AlertCircle, CheckCircle, Mic, Volume2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import Switch from '../components/ui/Switch';

// Make sure the saved model is always selectable, even when the live list
// hasn't loaded yet or no longer contains it.
function withCurrent(list, current) {
  const arr = Array.isArray(list) ? [...list] : [];
  if (current && !arr.includes(current)) arr.unshift(current);
  return arr;
}

function formatBytes(n) {
  if (!n) return '';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

// RAM status + load/unload row for a local model sidecar (Kokoro / Whisper)
function SidecarStatusRow({ status, onLoad, onUnload }) {
  const state = status?.state || 'stopped';
  if (state === 'ready') {
    return (
      <div className="flex items-center justify-between border border-green-500/30 bg-green-500/10 rounded-lg px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 bg-green-500 rounded-full shrink-0" />
          <span className="text-sm font-medium truncate">
            Loaded in RAM{status?.model ? ` — ${status.model.replace('mlx-community/', '')}` : ''}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onUnload}>
          Unload
        </Button>
      </div>
    );
  }
  if (state === 'starting' || state === 'loading') {
    return (
      <div className="flex items-center justify-between gap-2 border border-border/50 bg-muted/40 rounded-lg px-3 py-2 text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0">
          <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
          <span className="text-sm truncate">
            {status?.detail || 'Loading model… (first load downloads it from HuggingFace)'}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onUnload} title="Stop loading — a partial download resumes next time">
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between border border-border/50 rounded-lg px-3 py-2">
      <span className={`text-sm truncate ${state === 'error' ? 'text-red-500' : 'text-muted-foreground'}`}>
        {state === 'error' ? status?.message || 'Failed to load' : 'Not loaded'}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onLoad}>
        Load
      </Button>
    </div>
  );
}

function Settings() {
  const [settings, setSettings] = useState({
    GROQ_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    temperature: 0.7,
    top_p: 0.95,
    reasoning_effort: 'medium',
    anthropic_reasoning_level: 'medium',
    openai_reasoning_effort: 'medium',
    mcpServers: {},
    disabledMcpServers: [],
    customSystemPrompt: '',
    popupEnabled: true,
    customCompletionUrl: '',
    toolOutputLimit: 8000,
    customApiBaseUrl: '',
    customApiBaseUrlEnabled: false,
    customModels: {},
    builtInTools: {
      codeInterpreter: false,
      browserSearch: false
    },
    modelFilter: '',
    modelFilterExclude: '',
    disableThinkingSummaries: false,
    useResponsesApi: false,
    logApiRequests: false,
    googleConnectors: { gmail: false, calendar: false, drive: false },
    googleConnectorsApproval: { gmail: 'never', calendar: 'never', drive: 'never' },
    googleOAuthToken: '',
    googleRefreshToken: '',
    googleClientId: '',
    googleClientSecret: '',
    googleTokenExpiresAt: null,
    remoteMcpServers: {}
  });
  const [googleOAuthStatus, setGoogleOAuthStatus] = useState(null);
  const [audioModels, setAudioModels] = useState(null);
  const [kokoroStatus, setKokoroStatus] = useState({ state: 'stopped' });
  const [whisperStatus, setWhisperStatus] = useState({ state: 'stopped' });
  const [localModelInfo, setLocalModelInfo] = useState(null);
  const [chatgptAuthStatus, setChatgptAuthStatus] = useState({ signedIn: false });
  const [chatgptSigningIn, setChatgptSigningIn] = useState(false);
  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAnthropicApiKey, setShowAnthropicApiKey] = useState(false);
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false);
  const [newMcpServer, setNewMcpServer] = useState({
    id: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: {},
    url: '',
    headers: {}
  });
  const [useJsonInput, setUseJsonInput] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState(null);
  const [settingsPath, setSettingsPath] = useState('');
  const [newEnvVar, setNewEnvVar] = useState({ key: '', value: '' });
  const [newHeader, setNewHeader] = useState({ key: '', value: '' });
  const [editingServerId, setEditingServerId] = useState(null);
  const [newCustomModel, setNewCustomModel] = useState({
    id: '',
    displayName: '',
    context: 8192,
    vision_supported: false,
    builtin_tools_supported: false
  });
  const [editingModelId, setEditingModelId] = useState(null);
  
  // Remote MCP Server state
  const [newRemoteMcpServer, setNewRemoteMcpServer] = useState({
    id: '',
    serverUrl: '',
    serverLabel: '',
    serverDescription: '',
    requireApproval: 'never',
    allowedTools: '', // Comma-separated list of tool names to filter (empty = all tools)
    headers: {}
  });
  const [newRemoteMcpHeader, setNewRemoteMcpHeader] = useState({ key: '', value: '' });
  const [editingRemoteMcpServerId, setEditingRemoteMcpServerId] = useState(null);
  
  const statusTimeoutRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const navigate = useNavigate();

  // Handle Escape key to dismiss settings
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        navigate('/');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  // STT/TTS model catalogs (fetched live per provider) + sidecar RAM states
  useEffect(() => {
    let disposed = false;
    window.electron.getAudioModels?.()
      .then((models) => {
        if (!disposed) setAudioModels(models);
      })
      .catch((e) => console.error('Error fetching audio models:', e));
    window.electron.tts?.getState?.()
      .then((s) => {
        if (!disposed && s) setKokoroStatus({ state: s.running ? s.state : 'stopped' });
      })
      .catch(() => {});
    window.electron.sttLocal?.getState?.()
      .then((s) => {
        if (!disposed && s) setWhisperStatus({ state: s.running ? s.state : 'stopped', model: s.model });
      })
      .catch(() => {});
    const unsubTts = window.electron.tts?.onStatus?.((status) => {
      // The shared tts-status channel also reports the OpenAI engine; the
      // pill here only tracks the Kokoro sidecar (what sits in RAM).
      if (status?.engine === 'openai') return;
      setKokoroStatus(status);
    }) || (() => {});
    const unsubStt = window.electron.sttLocal?.onStatus?.((status) => setWhisperStatus(status)) || (() => {});
    return () => {
      disposed = true;
      unsubTts();
      unsubStt();
    };
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settingsData = await window.electron.getSettings();
        if (!settingsData.disabledMcpServers) {
            settingsData.disabledMcpServers = [];
        }
        if (!settingsData.builtInTools) {
            settingsData.builtInTools = {
                codeInterpreter: false,
                browserSearch: false
            };
        }
        if (!settingsData.reasoning_effort) {
            settingsData.reasoning_effort = 'medium';
        }
        if (!settingsData.ANTHROPIC_API_KEY) {
            settingsData.ANTHROPIC_API_KEY = '';
        }
        if (!settingsData.OPENAI_API_KEY) {
            settingsData.OPENAI_API_KEY = '';
        }
        if (!settingsData.anthropic_reasoning_level) {
            settingsData.anthropic_reasoning_level = 'medium';
        }
        if (!settingsData.openai_reasoning_effort) {
            settingsData.openai_reasoning_effort = 'medium';
        }
        if (settingsData.disableThinkingSummaries === undefined) {
            settingsData.disableThinkingSummaries = false;
        }
        if (settingsData.useResponsesApi === undefined) {
            settingsData.useResponsesApi = false;
        }
        if (settingsData.logApiRequests === undefined) {
            settingsData.logApiRequests = false;
        }
        if (!settingsData.googleConnectors) {
            settingsData.googleConnectors = { gmail: false, calendar: false, drive: false };
        }
        if (!settingsData.googleConnectorsApproval) {
            settingsData.googleConnectorsApproval = { gmail: 'never', calendar: 'never', drive: 'never' };
        }
        if (!settingsData.googleOAuthToken) {
            settingsData.googleOAuthToken = '';
        }
        if (!settingsData.googleRefreshToken) {
            settingsData.googleRefreshToken = '';
        }
        if (!settingsData.googleClientId) {
            settingsData.googleClientId = '';
        }
        if (!settingsData.googleClientSecret) {
            settingsData.googleClientSecret = '';
        }
        if (!settingsData.remoteMcpServers) {
            settingsData.remoteMcpServers = {};
        }
        setSettings(settingsData);
        
        // Fetch Google OAuth status
        try {
          const status = await window.electron.googleOAuth.getStatus();
          setGoogleOAuthStatus(status);
        } catch (e) {
          console.error('Error fetching Google OAuth status:', e);
        }

        // Fetch ChatGPT subscription sign-in status
        try {
          const status = await window.electron.chatgptAuth.getStatus();
          setChatgptAuthStatus(status || { signedIn: false });
        } catch (e) {
          console.error('Error fetching ChatGPT auth status:', e);
        }
      } catch (error) {
        console.error('Error loading settings:', error);
        setSettings(prev => ({
            ...prev,
            GROQ_API_KEY: '',
            ANTHROPIC_API_KEY: '',
            OPENAI_API_KEY: '',
            temperature: 0.7,
            top_p: 0.95,
            mcpServers: {},
            disabledMcpServers: [],
            customSystemPrompt: '',
            popupEnabled: true,
            customCompletionUrl: '',
            toolOutputLimit: 8000,
            customApiBaseUrl: '',
            customApiBaseUrlEnabled: false,
            customModels: {},
            builtInTools: {
                codeInterpreter: false,
                browserSearch: false
            },
            reasoning_effort: 'medium',
            anthropic_reasoning_level: 'medium',
            openai_reasoning_effort: 'medium',
            modelFilter: '',
            modelFilterExclude: '',
            disableThinkingSummaries: false,
            useResponsesApi: false,
            logApiRequests: false,
            googleConnectors: { gmail: false, calendar: false, drive: false },
            googleConnectorsApproval: { gmail: 'never', calendar: 'never', drive: 'never' },
            googleOAuthToken: '',
            googleRefreshToken: '',
            googleClientId: '',
            googleClientSecret: '',
            googleTokenExpiresAt: null,
            remoteMcpServers: {}
        }));
      }
    };

    const getSettingsPath = async () => {
      try {
        const path = await window.electron.getSettingsPath();
        setSettingsPath(path);
      } catch (error) {
        console.error('Error getting settings path:', error);
      }
    };

    loadSettings();
    getSettingsPath();

    return () => {
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Save settings with debounce
  const saveSettings = (updatedSettings) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setIsSaving(true);
    
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const settingsToSave = {
            ...updatedSettings,
            disabledMcpServers: updatedSettings.disabledMcpServers || []
        };
        const result = await window.electron.saveSettings(settingsToSave);
        if (result.success) {
          setSaveStatus({ type: 'success', message: 'Settings saved' });
          
          if (statusTimeoutRef.current) {
            clearTimeout(statusTimeoutRef.current);
          }
          statusTimeoutRef.current = setTimeout(() => {
            setSaveStatus(null);
          }, 2000);
        } else {
          setSaveStatus({ type: 'error', message: `Failed to save: ${result.error}` });
        }
      } catch (error) {
        console.error('Error saving settings:', error);
        setSaveStatus({ type: 'error', message: `Error: ${error.message}` });
      } finally {
        setIsSaving(false);
      }
    }, 800);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    const updatedSettings = { ...settings, [name]: value };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleSelectChange = (name, value) => {
    const updatedSettings = { ...settings, [name]: value };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleToggleChange = (name, checked) => {
    const updatedSettings = { ...settings, [name]: checked };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  // Voice (STT/TTS) derived state + sidecar controls
  const sttProvider = settings.sttProvider || 'groq';
  const sttModelKey =
    sttProvider === 'openai' ? 'sttModelOpenai' : sttProvider === 'local' ? 'sttModelLocal' : 'sttModelGroq';
  const sttModelOptions = withCurrent(audioModels?.stt?.[sttProvider], settings[sttModelKey]);
  const ttsProvider = settings.ttsProvider || 'kokoro';
  const ttsModelOptions = withCurrent(audioModels?.tts?.openai, settings.ttsOpenaiModel);
  const ttsVoiceOptions = withCurrent(audioModels?.tts?.voices, settings.ttsOpenaiVoice);
  const openaiKeySet = !!(
    settings.OPENAI_API_KEY &&
    settings.OPENAI_API_KEY.trim() &&
    !settings.OPENAI_API_KEY.includes('<replace me>')
  );

  const handleKokoroLoad = () => (window.electron.tts.loadKokoro || window.electron.tts.start)().catch(() => {});
  const handleKokoroUnload = () => window.electron.tts.stop().catch(() => {});
  const handleWhisperLoad = async () => {
    // Flush the debounced save first so the sidecar picks up a just-changed model
    try {
      await window.electron.saveSettings({ ...settings, disabledMcpServers: settings.disabledMcpServers || [] });
    } catch { /* best effort */ }
    window.electron.sttLocal.start().catch(() => {});
  };
  const handleWhisperUnload = () => window.electron.sttLocal.stop().catch(() => {});

  const refreshAudioModels = () =>
    window.electron.getAudioModels?.().then(setAudioModels).catch(() => {});

  // Size (live from HuggingFace) + on-disk state for the selected local model
  useEffect(() => {
    if (sttProvider !== 'local' || !settings.sttModelLocal) {
      setLocalModelInfo(null);
      return undefined;
    }
    let stale = false;
    setLocalModelInfo(null);
    window.electron.getLocalModelInfo?.(settings.sttModelLocal)
      .then((info) => {
        if (!stale) setLocalModelInfo(info);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [sttProvider, settings.sttModelLocal, whisperStatus.state]);

  const handleDeleteLocalModel = async (modelId) => {
    if (!modelId) return;
    if (!window.confirm(`Delete ${modelId} from disk? It will re-download the next time it loads.`)) return;
    const result = await window.electron.deleteLocalModel?.(modelId);
    if (result && result.ok === false) {
      setSaveStatus({ type: 'error', message: `Delete failed: ${result.error}` });
    }
    refreshAudioModels();
    if (modelId === settings.sttModelLocal) {
      window.electron.getLocalModelInfo?.(modelId).then(setLocalModelInfo).catch(() => {});
    }
  };

  const handleBuiltInToolToggle = (toolName, checked) => {
    const updatedSettings = {
      ...settings,
      builtInTools: {
        ...settings.builtInTools,
        [toolName]: checked
      }
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleGoogleConnectorToggle = (connectorName, checked) => {
    const updatedSettings = {
      ...settings,
      googleConnectors: {
        ...settings.googleConnectors,
        [connectorName]: checked
      }
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleGoogleConnectorApprovalChange = (connectorName, value) => {
    const updatedSettings = {
      ...settings,
      googleConnectorsApproval: {
        ...settings.googleConnectorsApproval,
        [connectorName]: value
      }
    };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleGoogleOAuthRefresh = async () => {
    setIsRefreshingToken(true);
    try {
      const result = await window.electron.googleOAuth.refresh();
      if (result.success) {
        // Reload settings to get the new token
        const newSettings = await window.electron.getSettings();
        setSettings(prev => ({
          ...prev,
          googleOAuthToken: newSettings.googleOAuthToken,
          googleTokenExpiresAt: newSettings.googleTokenExpiresAt
        }));
        // Update status
        const status = await window.electron.googleOAuth.getStatus();
        setGoogleOAuthStatus(status);
        setSaveStatus({ type: 'success', message: 'Token refreshed successfully!' });
      } else {
        setSaveStatus({ type: 'error', message: result.message || 'Failed to refresh token' });
      }
    } catch (error) {
      console.error('Error refreshing Google OAuth token:', error);
      setSaveStatus({ type: 'error', message: 'Error refreshing token' });
    } finally {
      setIsRefreshingToken(false);
      // Clear status after 3 seconds
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  // Sync ChatGPT token fields written by the main process into local state —
  // the Settings page saves the whole settings object, so stale local values
  // would otherwise clobber freshly written tokens.
  const syncChatgptTokenSettings = async () => {
    try {
      const fresh = await window.electron.getSettings();
      const tokenKeys = [
        'chatgptAccessToken', 'chatgptRefreshToken', 'chatgptIdToken',
        'chatgptTokenExpiresAt', 'chatgptLastRefreshAt', 'chatgptEmail',
        'chatgptAccountId', 'chatgptPlanType',
      ];
      setSettings(prev => {
        const next = { ...prev };
        tokenKeys.forEach(key => { next[key] = fresh[key]; });
        return next;
      });
    } catch (e) {
      console.error('Error syncing ChatGPT token settings:', e);
    }
  };

  const handleChatgptSignIn = async () => {
    setChatgptSigningIn(true);
    try {
      const result = await window.electron.chatgptAuth.start();
      setChatgptAuthStatus({ signedIn: true, email: result.email, planType: result.planType });
      await syncChatgptTokenSettings();
      setSaveStatus({ type: 'success', message: `Signed in with ChatGPT${result.email ? ` as ${result.email}` : ''}` });
    } catch (error) {
      console.error('ChatGPT sign-in failed:', error);
      setSaveStatus({ type: 'error', message: `ChatGPT sign-in failed: ${error.message}` });
    } finally {
      setChatgptSigningIn(false);
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const handleChatgptSignOut = async () => {
    try {
      await window.electron.chatgptAuth.signOut();
      setChatgptAuthStatus({ signedIn: false });
      await syncChatgptTokenSettings();
    } catch (error) {
      console.error('ChatGPT sign-out failed:', error);
    }
  };

  const handleNumberChange = (e) => {
    const { name, value } = e.target;
    const updatedSettings = { ...settings, [name]: parseFloat(value) };
    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleNewMcpServerChange = (e) => {
    const { name, value } = e.target;
    setNewMcpServer(prev => ({ ...prev, [name]: value }));
  };

  const handleTransportChange = (transportType) => {
    setNewMcpServer(prev => ({
        ...prev,
        transport: transportType,
        command: (transportType === 'sse' || transportType === 'streamableHttp') ? '' : prev.command,
        args: (transportType === 'sse' || transportType === 'streamableHttp') ? '' : prev.args,
        env: (transportType === 'sse' || transportType === 'streamableHttp') ? {} : prev.env,
        url: transportType === 'stdio' ? '' : prev.url,
        headers: transportType === 'stdio' ? {} : prev.headers
    }));
    setJsonInput('');
    setJsonError(null);
  };

  const addEnvVar = () => {
    if (!newEnvVar.key) return;
    
    console.log('Adding environment variable:', newEnvVar.key, '=', newEnvVar.value);
    
    setNewMcpServer(prev => ({
      ...prev,
      env: {
        ...prev.env,
        [newEnvVar.key]: newEnvVar.value
      }
    }));
    
    setNewEnvVar({ key: '', value: '' });
  };

  const removeEnvVar = (key) => {
    setNewMcpServer(prev => {
      const updatedEnv = { ...prev.env };
      delete updatedEnv[key];
      return { ...prev, env: updatedEnv };
    });
    setUseJsonInput(false);
    setJsonError(null);
  };

  const handleEnvVarChange = (e) => {
    const { name, value } = e.target;
    setNewEnvVar(prev => ({ ...prev, [name]: value }));
  };

  const addHeader = () => {
    if (!newHeader.key) return;
    
    console.log('Adding header:', newHeader.key, '=', newHeader.value);
    
    setNewMcpServer(prev => ({
      ...prev,
      headers: {
        ...prev.headers,
        [newHeader.key]: newHeader.value
      }
    }));
    
    setNewHeader({ key: '', value: '' });
  };

  const removeHeader = (key) => {
    setNewMcpServer(prev => {
      const updatedHeaders = { ...prev.headers };
      delete updatedHeaders[key];
      return { ...prev, headers: updatedHeaders };
    });
    setUseJsonInput(false);
    setJsonError(null);
  };

  const handleHeaderChange = (e) => {
    const { name, value } = e.target;
    setNewHeader(prev => ({ ...prev, [name]: value }));
  };

  const handleJsonInputChange = (e) => {
    setJsonInput(e.target.value);
    setJsonError(null);
  };

  const parseJsonInput = () => {
    try {
      if (!jsonInput.trim()) {
        throw new Error("JSON input is empty");
      }
      
      const parsedJson = JSON.parse(jsonInput);
      
      // Check if it's a valid MCP server config
      if (typeof parsedJson !== 'object') {
        throw new Error("JSON must be an object");
      }
      
      // Create a normalized server entry
      const serverEntry = {};
      
      // Check for transport type in JSON (optional, default to stdio if missing)
      const transport = parsedJson.transport === 'sse' ? 'sse' : 
                        parsedJson.transport === 'streamableHttp' ? 'streamableHttp' : 'stdio';
      serverEntry.transport = transport;

      if (transport === 'stdio') {
          if ('command' in parsedJson) {
              serverEntry.command = parsedJson.command;
          } else {
              throw new Error("Stdio server config must include 'command' field");
          }

          // Handle args field for stdio
          if ('args' in parsedJson) {
              if (Array.isArray(parsedJson.args)) {
              serverEntry.args = parsedJson.args;
              } else {
              throw new Error("'args' must be an array for stdio config");
              }
          } else {
              serverEntry.args = [];
          }

          // Handle env field for stdio
          if ('env' in parsedJson) {
              if (typeof parsedJson.env === 'object' && parsedJson.env !== null) {
              serverEntry.env = parsedJson.env;
              } else {
              throw new Error("'env' must be an object for stdio config");
              }
          } else {
              serverEntry.env = {};
          }
          // Ensure url field is not present or empty for stdio
          serverEntry.url = '';

      } else { // transport === 'sse'
          if ('url' in parsedJson && typeof parsedJson.url === 'string' && parsedJson.url.trim() !== '') {
              serverEntry.url = parsedJson.url;
          } else {
              throw new Error("SSE server config must include a non-empty 'url' field");
          }
           // Ensure stdio fields are not present or empty for sse
          serverEntry.command = '';
          serverEntry.args = [];
          serverEntry.env = {};
      }

      return serverEntry;
    } catch (error) {
      setJsonError(error.message);
      return null;
    }
  };

  // Helper function to parse args string into array
  const parseArgsString = (argsStr) => {
    if (!argsStr) return [];
    let args = [];
    const trimmedArgsStr = argsStr.trim();
    let current = '';
    let inQuotes = false;
    let quoteChar = null;

    for (let i = 0; i < trimmedArgsStr.length; i++) {
      const char = trimmedArgsStr[i];

      if ((char === '"' || char === "'") && (quoteChar === null || quoteChar === char)) {
        if (inQuotes) {
          // Ending quote
          inQuotes = false;
          quoteChar = null;
        } else {
          // Starting quote
          inQuotes = true;
          quoteChar = char;
        }
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      args.push(current);
    }
    return args;
  };

  // Switches view to Form, converting JSON state if valid
  const switchToFormView = () => {
    if (!useJsonInput) return; // Already in form view

    try {
      const parsedJson = JSON.parse(jsonInput || '{}');
      if (typeof parsedJson !== 'object' || parsedJson === null) {
        throw new Error("JSON must be an object.");
      }
      
      // Basic validation (can be more robust)
      const command = parsedJson.command || '';
      const args = Array.isArray(parsedJson.args) ? parsedJson.args : [];
      const env = typeof parsedJson.env === 'object' && parsedJson.env !== null ? parsedJson.env : {};
      const argsString = args.join(' ');

      setNewMcpServer(prev => ({ ...prev, command, args: argsString, env }));
      setJsonError(null);
      setUseJsonInput(false);
    } catch (error) {
      console.error("Error parsing JSON to switch to form view:", error);
      setJsonError(`Invalid JSON: ${error.message}. Cannot switch to form view.`);
      // Optionally keep the user in JSON view if parsing fails
    }
  };

  // Switches view to JSON, converting form state
  const switchToJsonView = () => {
    if (useJsonInput) return; // Already in JSON view

    try {
      let serverConfig = {};
      if (newMcpServer.transport === 'stdio') {
          const argsArray = parseArgsString(newMcpServer.args);
          serverConfig = {
              transport: 'stdio',
              command: newMcpServer.command,
              args: argsArray,
              env: newMcpServer.env
          };
      } else { // sse or streamableHttp
          serverConfig = {
              transport: newMcpServer.transport, // Keep the selected transport
              url: newMcpServer.url
          };
          // Explicitly exclude stdio fields if they somehow exist
          delete serverConfig.command;
          delete serverConfig.args;
          delete serverConfig.env;
      }

      const jsonString = JSON.stringify(serverConfig, null, 2);
      setJsonInput(jsonString);
      setJsonError(null); // Clear any previous JSON error
      setUseJsonInput(true);
    } catch (error) {
      console.error("Error converting form state to JSON:", error);
      // This should ideally not happen if form state is valid
      setJsonError(`Internal error: Failed to generate JSON. ${error.message}`);
    }
  };

  const handleSaveMcpServer = (e) => {
    e.preventDefault();
    
    let serverConfig;
    
    if (useJsonInput) {
      const parsedConfig = parseJsonInput();
      if (!parsedConfig) return;
      
      // Use the ID from the form field (which is disabled during edit)
      if (!newMcpServer.id.trim()) {
        setJsonError("Server ID is required");
        return;
      }
      
      serverConfig = parsedConfig;
    } else {
      // Use form state
      if (!newMcpServer.id) {
          setSaveStatus({ type: 'error', message: 'Server ID is required' });
          return;
      }

      if (newMcpServer.transport === 'stdio') {
          if (!newMcpServer.command) {
              setSaveStatus({ type: 'error', message: 'Command is required for stdio transport' });
              return;
          }
          // Parse args string from the form field
          const args = parseArgsString(newMcpServer.args);
          serverConfig = {
              transport: 'stdio',
              command: newMcpServer.command,
              args, // Use the parsed array
              env: newMcpServer.env
          };
      } else { // sse or streamableHttp
          if (!newMcpServer.url || !newMcpServer.url.trim()) {
              setSaveStatus({ type: 'error', message: 'URL is required for SSE or Streamable HTTP transport' });
              return;
          }
          try {
              // Basic URL validation
              new URL(newMcpServer.url);
          } catch (urlError) {
              setSaveStatus({ type: 'error', message: `Invalid URL: ${urlError.message}` });
              return;
          }
          serverConfig = {
              transport: newMcpServer.transport,
              url: newMcpServer.url
          };
          // Include headers if present
          if (newMcpServer.headers && Object.keys(newMcpServer.headers).length > 0) {
              serverConfig.headers = newMcpServer.headers;
          }
      }
    }

    console.log('Saving MCP server:', newMcpServer.id, 'with config:', serverConfig);
    
    // Update settings with new/updated MCP server
    const updatedSettings = {
      ...settings,
      mcpServers: {
        ...settings.mcpServers,
        [newMcpServer.id]: serverConfig // Use ID from state (disabled during edit)
      }
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    
    // Clear the form, reset to stdio default
    setNewMcpServer({ id: '', transport: 'stdio', command: '', args: '', env: {}, url: '', headers: {} });
    setJsonInput('');
    setJsonError(null);
    setEditingServerId(null); // Reset editing state after save
  };

  const removeMcpServer = (serverId) => {
    const updatedMcpServers = { ...settings.mcpServers };
    delete updatedMcpServers[serverId];
    
    const updatedSettings = {
      ...settings,
      mcpServers: updatedMcpServers
    };
    
    setSettings(updatedSettings);
    saveSettings(updatedSettings);

    // If the removed server was being edited, cancel the edit
    if (editingServerId === serverId) {
      cancelEditing();
    }
  };

  // Function to handle starting the edit process for an MCP server
  const startEditing = (serverId) => {
    const serverToEdit = settings.mcpServers[serverId];
    if (!serverToEdit) return;

    setEditingServerId(serverId);

    // Determine transport type accurately
    let transport;
    if (serverToEdit.transport === 'sse') {
        transport = 'sse';
    } else if (serverToEdit.transport === 'streamableHttp') {
        transport = 'streamableHttp';
    } else {
        transport = 'stdio'; // Default to stdio if missing or other value
    }


    // Populate form fields based on transport type
    let command = '', argsArray = [], envObject = {}, argsString = '', url = '', headersObject = {};
    if (transport === 'stdio') {
        command = serverToEdit.command || '';
        argsArray = Array.isArray(serverToEdit.args) ? serverToEdit.args : [];
        envObject = typeof serverToEdit.env === 'object' && serverToEdit.env !== null ? serverToEdit.env : {};
        argsString = argsArray.join(' ');
    } else { // sse or streamableHttp
        url = serverToEdit.url || '';
        headersObject = typeof serverToEdit.headers === 'object' && serverToEdit.headers !== null ? serverToEdit.headers : {};
        // Ensure stdio fields are clear
        command = '';
        argsString = '';
        envObject = {};
    }

    setNewMcpServer({
      id: serverId, // Keep the original ID in the form
      transport: transport, // Set the correct transport type
      command: command,
      args: argsString,
      env: envObject,
      url: url, // URL will be populated correctly now
      headers: headersObject
    });

    // Also populate the JSON input field based on the correct structure
    try {
      let jsonConfig;
      if (transport === 'stdio') {
          jsonConfig = { transport: 'stdio', command, args: argsArray, env: envObject };
      } else { // sse or streamableHttp
          // Use the determined transport type for the JSON representation
          jsonConfig = { transport: transport, url };
          // Include headers if present
          if (headersObject && Object.keys(headersObject).length > 0) {
              jsonConfig.headers = headersObject;
          }
      }
      const jsonString = JSON.stringify(jsonConfig, null, 2);
      setJsonInput(jsonString);
    } catch (error) {
      console.error("Failed to stringify server config for JSON input:", error);
      setJsonInput(''); // Clear if error
    }

    // Switch to form view when editing starts
    setUseJsonInput(false);
    setJsonError(null);

    // Optional: Scroll to the form or highlight it
    // window.scrollTo({ top: document.getElementById('mcp-form').offsetTop, behavior: 'smooth' });
  };

  // Function to cancel editing
  const cancelEditing = () => {
    setEditingServerId(null);
    setNewMcpServer({ id: '', transport: 'stdio', command: '', args: '', env: {}, url: '', headers: {} }); // Reset form
    setJsonInput('');
    setJsonError(null);
  };

  // Custom Model Management Functions
  const handleNewCustomModelChange = (e) => {
    const { name, value, type, checked } = e.target;
    setNewCustomModel(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : (name === 'context' ? parseInt(value) || 8192 : value)
    }));
  };

  const handleSaveCustomModel = (e) => {
    e.preventDefault();
    
    if (!newCustomModel.id.trim()) {
      setSaveStatus({ type: 'error', message: 'Model ID is required' });
      return;
    }

    if (!newCustomModel.displayName.trim()) {
      setSaveStatus({ type: 'error', message: 'Model display name is required' });
      return;
    }

    // Create the model configuration
    const modelConfig = {
      displayName: newCustomModel.displayName.trim(),
      context: newCustomModel.context,
      vision_supported: newCustomModel.vision_supported,
      builtin_tools_supported: newCustomModel.builtin_tools_supported
    };

    console.log('Saving custom model:', newCustomModel.id, 'with config:', modelConfig);
    
    // Update settings with new/updated custom model
    const updatedSettings = {
      ...settings,
      customModels: {
        ...settings.customModels,
        [newCustomModel.id]: modelConfig
      }
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    
    // Clear the form
    setNewCustomModel({ id: '', displayName: '', context: 8192, vision_supported: false, builtin_tools_supported: false });
    setEditingModelId(null);
  };

  const removeCustomModel = (modelId) => {
    const updatedCustomModels = { ...settings.customModels };
    delete updatedCustomModels[modelId];
    
    const updatedSettings = {
      ...settings,
      customModels: updatedCustomModels
    };
    
    setSettings(updatedSettings);
    saveSettings(updatedSettings);

    // If the removed model was being edited, cancel the edit
    if (editingModelId === modelId) {
      cancelModelEditing();
    }
  };

  const startModelEditing = (modelId) => {
    const modelToEdit = settings.customModels[modelId];
    if (!modelToEdit) return;

    setEditingModelId(modelId);
    setNewCustomModel({
      id: modelId,
      displayName: modelToEdit.displayName || '',
      context: modelToEdit.context || 8192,
      vision_supported: modelToEdit.vision_supported || false,
      builtin_tools_supported: modelToEdit.builtin_tools_supported || false
    });
  };

  const cancelModelEditing = () => {
    setEditingModelId(null);
    setNewCustomModel({ id: '', displayName: '', context: 8192, vision_supported: false, builtin_tools_supported: false });
  };

  // Remote MCP Server Management Functions
  const handleRemoteMcpServerToggle = (serverId, enabled) => {
    const serverConfig = settings.remoteMcpServers[serverId];
    if (!serverConfig) return;

    const updatedSettings = {
      ...settings,
      remoteMcpServers: {
        ...settings.remoteMcpServers,
        [serverId]: {
          ...serverConfig,
          enabled: enabled
        }
      }
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
  };

  const handleNewRemoteMcpServerChange = (e) => {
    const { name, value } = e.target;
    setNewRemoteMcpServer(prev => ({ ...prev, [name]: value }));
  };

  const addRemoteMcpHeader = () => {
    if (!newRemoteMcpHeader.key) return;
    
    setNewRemoteMcpServer(prev => ({
      ...prev,
      headers: {
        ...prev.headers,
        [newRemoteMcpHeader.key]: newRemoteMcpHeader.value
      }
    }));
    
    setNewRemoteMcpHeader({ key: '', value: '' });
  };

  const removeRemoteMcpHeader = (key) => {
    setNewRemoteMcpServer(prev => {
      const updatedHeaders = { ...prev.headers };
      delete updatedHeaders[key];
      return { ...prev, headers: updatedHeaders };
    });
  };

  const handleRemoteMcpHeaderChange = (e) => {
    const { name, value } = e.target;
    setNewRemoteMcpHeader(prev => ({ ...prev, [name]: value }));
  };

  const handleSaveRemoteMcpServer = (e) => {
    e.preventDefault();
    
    if (!newRemoteMcpServer.id.trim()) {
      setSaveStatus({ type: 'error', message: 'Server ID is required' });
      return;
    }

    if (!newRemoteMcpServer.serverUrl.trim()) {
      setSaveStatus({ type: 'error', message: 'Server URL is required' });
      return;
    }

    // Validate URL
    try {
      new URL(newRemoteMcpServer.serverUrl);
    } catch (urlError) {
      setSaveStatus({ type: 'error', message: `Invalid URL: ${urlError.message}` });
      return;
    }

    // Create the server configuration
    const serverConfig = {
      serverUrl: newRemoteMcpServer.serverUrl.trim(),
      serverLabel: newRemoteMcpServer.serverLabel.trim() || newRemoteMcpServer.id.trim(),
      serverDescription: newRemoteMcpServer.serverDescription.trim(),
      requireApproval: newRemoteMcpServer.requireApproval || 'never'
    };

    // Include headers if present
    if (newRemoteMcpServer.headers && Object.keys(newRemoteMcpServer.headers).length > 0) {
      serverConfig.headers = newRemoteMcpServer.headers;
    }

    // Include allowedTools if present (filters which tools are available from the server)
    if (newRemoteMcpServer.allowedTools && newRemoteMcpServer.allowedTools.trim()) {
      const toolsList = newRemoteMcpServer.allowedTools
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      if (toolsList.length > 0) {
        serverConfig.allowedTools = toolsList;
      }
    }

    console.log('Saving remote MCP server:', newRemoteMcpServer.id, 'with config:', serverConfig);
    
    // Update settings with new/updated remote MCP server
    const updatedSettings = {
      ...settings,
      remoteMcpServers: {
        ...settings.remoteMcpServers,
        [newRemoteMcpServer.id]: serverConfig
      }
    };

    setSettings(updatedSettings);
    saveSettings(updatedSettings);
    
    // Clear the form
    setNewRemoteMcpServer({
      id: '',
      serverUrl: '',
      serverLabel: '',
      serverDescription: '',
      requireApproval: 'never',
      allowedTools: '',
      headers: {}
    });
    setEditingRemoteMcpServerId(null);
  };

  const removeRemoteMcpServer = (serverId) => {
    const updatedRemoteMcpServers = { ...settings.remoteMcpServers };
    delete updatedRemoteMcpServers[serverId];
    
    const updatedSettings = {
      ...settings,
      remoteMcpServers: updatedRemoteMcpServers
    };
    
    setSettings(updatedSettings);
    saveSettings(updatedSettings);

    // If the removed server was being edited, cancel the edit
    if (editingRemoteMcpServerId === serverId) {
      cancelRemoteMcpEditing();
    }
  };

  const startRemoteMcpEditing = (serverId) => {
    const serverToEdit = settings.remoteMcpServers[serverId];
    if (!serverToEdit) return;

    setEditingRemoteMcpServerId(serverId);
    setNewRemoteMcpServer({
      id: serverId,
      serverUrl: serverToEdit.serverUrl || '',
      serverLabel: serverToEdit.serverLabel || '',
      serverDescription: serverToEdit.serverDescription || '',
      requireApproval: serverToEdit.requireApproval || 'never',
      allowedTools: Array.isArray(serverToEdit.allowedTools) ? serverToEdit.allowedTools.join(', ') : '',
      headers: serverToEdit.headers || {}
    });
  };

  const cancelRemoteMcpEditing = () => {
    setEditingRemoteMcpServerId(null);
    setNewRemoteMcpServer({
      id: '',
      serverUrl: '',
      serverLabel: '',
      serverDescription: '',
      requireApproval: 'never',
      allowedTools: '',
      headers: {}
    });
  };

  const getStatusMessage = () => {
    if (isSaving) return 'Saving...';
    return saveStatus?.message || '';
  };

  const reloadSettingsFromDisk = async () => {
    setIsSaving(true);
    setSaveStatus({ type: 'info', message: 'Reloading settings...' });

    try {
      const settingsData = await window.electron.getSettings();
      if (!settingsData.disabledMcpServers) {
          settingsData.disabledMcpServers = [];
      }
      setSettings(settingsData);
      setSaveStatus({ type: 'success', message: 'Settings reloaded from disk' });
    } catch (error) {
      console.error('Error reloading settings:', error);
      setSaveStatus({ type: 'error', message: `Error reloading: ${error.message}` });
    } finally {
      setIsSaving(false);
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
      statusTimeoutRef.current = setTimeout(() => {
        setSaveStatus(null);
      }, 2000);
    }
  };

  // Function to reset tool call approvals in localStorage
  const handleResetToolApprovals = () => {
    setIsSaving(true);
    setSaveStatus({ type: 'info', message: 'Resetting approvals...' });

    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('tool_approval_') || key === 'tool_approval_yolo_mode')) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        console.log(`Removed tool approval key: ${key}`);
      });

      setSaveStatus({ type: 'success', message: 'Tool call approvals reset' });
    } catch (error) {
      console.error('Error resetting tool approvals:', error);
      setSaveStatus({ type: 'error', message: `Error resetting: ${error.message}` });
    } finally {
      setIsSaving(false);
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
      statusTimeoutRef.current = setTimeout(() => {
        setSaveStatus(null);
      }, 2000);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-6">
          <div className="flex items-center space-x-4">
            <Link to="/">
              <Button variant="ghost" size="icon" className="text-foreground hover:text-foreground">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div className="flex items-center space-x-2">
              <SettingsIcon className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold text-foreground">Settings</h1>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={reloadSettingsFromDisk}
              disabled={isSaving}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isSaving ? 'animate-spin' : ''}`} />
              Reload
            </Button>
          </div>
        </div>
      </header>

      {/* Status Message */}
      {(isSaving || saveStatus) && (
        <div className="border-b bg-background">
          <div className="container px-6 py-3">
            <div className={`flex items-center space-x-2 text-sm ${
              saveStatus?.type === 'error'
                ? 'text-destructive'
                : saveStatus?.type === 'success'
                ? 'text-green-600'
                : 'text-muted-foreground'
            }`}>
              {saveStatus?.type === 'success' ? (
                <CheckCircle className="h-4 w-4" />
              ) : saveStatus?.type === 'error' ? (
                <AlertCircle className="h-4 w-4" />
              ) : (
                <RefreshCw className="h-4 w-4 animate-spin" />
              )}
              <span>{getStatusMessage()}</span>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main>
        <div className="container px-6 py-8">
          <div className="max-w-4xl mx-auto space-y-8">
            
            {/* Settings Path Info */}
            {settingsPath && (
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                    <Key className="h-4 w-4" />
                    <span>Settings file: <code className="text-xs bg-muted px-1 py-0.5 rounded">{settingsPath}</code></span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* API Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Key className="h-5 w-5 text-primary" />
                  <span>API Configuration</span>
                </CardTitle>
                <CardDescription>
                  Configure your API credentials and endpoint settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="api-key">API Key</Label>
                  <div className="relative">
                    <Input
                      type={showApiKey ? "text" : "password"}
                      id="api-key"
                      name="GROQ_API_KEY"
                      value={settings.GROQ_API_KEY || ''}
                      onChange={handleChange}
                      placeholder="Enter your API key"
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-10 w-10"
                      onClick={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="custom-api-base-url">Custom API Base URL (Optional)</Label>
                    <div className="flex items-center space-x-2">
                      <Label htmlFor="custom-api-base-url-enabled" className="text-sm font-normal text-muted-foreground">
                        {settings.customApiBaseUrlEnabled ? 'Enabled' : 'Disabled'}
                      </Label>
                      <Switch
                        id="custom-api-base-url-enabled"
                        checked={settings.customApiBaseUrlEnabled || false}
                        onChange={(e) => handleToggleChange('customApiBaseUrlEnabled', e.target.checked)}
                      />
                    </div>
                  </div>
                  <Input
                    type="text"
                    id="custom-api-base-url"
                    name="customApiBaseUrl"
                    value={settings.customApiBaseUrl || ''}
                    onChange={handleChange}
                    placeholder="e.g., https://api.groq.com/openai/v1/ or http://127.0.0.1:8000/v1/"
                    disabled={!settings.customApiBaseUrlEnabled}
                    className={!settings.customApiBaseUrlEnabled ? 'opacity-50' : ''}
                  />
                  <p className="text-xs text-muted-foreground">
                    <strong>Important:</strong> URL must end with <code className="text-xs bg-muted px-1 py-0.5 rounded">/v1/</code> (with trailing slash).
                    For Groq-compatible endpoints: <code className="text-xs bg-muted px-1 py-0.5 rounded">https://api.groq.com/openai/v1/</code>.
                    For custom OpenAI-compatible endpoints: <code className="text-xs bg-muted px-1 py-0.5 rounded">http://your-server/v1/</code>.
                    {settings.customApiBaseUrlEnabled ? ' Toggle off to use the default Groq API.' : ' Toggle on to enable custom API base URL.'}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Local Model Server (its own slot — works alongside Groq) */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Server className="h-5 w-5 text-primary" />
                  <span>Local Model Server</span>
                </CardTitle>
                <CardDescription>
                  Serve models from your own machine (LM Studio, Ollama, mlx_lm.server, llama.cpp) alongside Groq — they show up in the model picker marked (Local)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="local-llm-base-url">Base URL</Label>
                    <div className="flex items-center space-x-2">
                      <Label htmlFor="local-llm-enabled" className="text-sm font-normal text-muted-foreground">
                        {settings.localLlmEnabled ? 'Enabled' : 'Disabled'}
                      </Label>
                      <Switch
                        id="local-llm-enabled"
                        checked={settings.localLlmEnabled || false}
                        onChange={(e) => handleToggleChange('localLlmEnabled', e.target.checked)}
                      />
                    </div>
                  </div>
                  <Input
                    type="text"
                    id="local-llm-base-url"
                    name="localLlmBaseUrl"
                    value={settings.localLlmBaseUrl || ''}
                    onChange={handleChange}
                    placeholder="e.g., http://127.0.0.1:1234/v1/ (LM Studio) or http://127.0.0.1:11434/v1/ (Ollama)"
                    disabled={!settings.localLlmEnabled}
                    className={!settings.localLlmEnabled ? 'opacity-50' : ''}
                  />
                  <p className="text-xs text-muted-foreground">
                    <strong>Important:</strong> URL must end with <code className="text-xs bg-muted px-1 py-0.5 rounded">/v1/</code> (with trailing slash).
                    Any OpenAI-compatible endpoint works. Unlike the custom URL above, this does not replace Groq —
                    both are available at the same time.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="local-llm-api-key">API Key (Optional)</Label>
                  <Input
                    type="password"
                    id="local-llm-api-key"
                    name="localLlmApiKey"
                    value={settings.localLlmApiKey || ''}
                    onChange={handleChange}
                    placeholder="Only if your local server requires one"
                    disabled={!settings.localLlmEnabled}
                    className={!settings.localLlmEnabled ? 'opacity-50' : ''}
                  />
                  <p className="text-xs text-muted-foreground">
                    Most local servers need no key. Models are fetched live from the server&apos;s /v1/models.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Claude (Anthropic) Configuration */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Cpu className="h-5 w-5 text-primary" />
                  <span>Claude (Anthropic)</span>
                </CardTitle>
                <CardDescription>
                  Configure your Anthropic API key and Claude reasoning settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="anthropic-api-key">Anthropic API Key</Label>
                  <div className="relative">
                    <Input
                      type={showAnthropicApiKey ? "text" : "password"}
                      id="anthropic-api-key"
                      name="ANTHROPIC_API_KEY"
                      value={settings.ANTHROPIC_API_KEY || ''}
                      onChange={handleChange}
                      placeholder="Enter your Anthropic API key"
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-10 w-10"
                      onClick={() => setShowAnthropicApiKey(!showAnthropicApiKey)}
                    >
                      {showAnthropicApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Get your API key from console.anthropic.com
                  </p>
                </div>

                <div className="space-y-3">
                  <Label htmlFor="anthropic_reasoning_level">
                    Extended Thinking Level: <Badge variant="outline">{settings.anthropic_reasoning_level}</Badge>
                  </Label>
                  <Select
                    value={settings.anthropic_reasoning_level}
                    onValueChange={(value) => handleSelectChange('anthropic_reasoning_level', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select reasoning level" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (disabled)</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="adaptive">Adaptive (auto)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Controls extended thinking for Claude models. Adaptive lets Claude decide thinking depth automatically.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* ChatGPT (OpenAI) Configuration */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <span>ChatGPT (OpenAI)</span>
                </CardTitle>
                <CardDescription>
                  Sign in with your ChatGPT subscription (no API key needed) or configure an OpenAI API key
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* ChatGPT subscription sign-in */}
                <div className="space-y-2">
                  <Label>ChatGPT Account</Label>
                  {chatgptAuthStatus?.signedIn ? (
                    <div className="flex items-center justify-between border border-green-500/30 bg-green-500/10 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full" />
                        <span className="text-sm font-medium">
                          Signed in{chatgptAuthStatus.email ? ` as ${chatgptAuthStatus.email}` : ''}
                          {chatgptAuthStatus.planType ? ` (${chatgptAuthStatus.planType})` : ''}
                        </span>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={handleChatgptSignOut}>
                        Sign out
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleChatgptSignIn}
                      disabled={chatgptSigningIn}
                    >
                      {chatgptSigningIn ? 'Waiting for browser…' : 'Sign in with ChatGPT'}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {chatgptAuthStatus?.signedIn
                      ? 'Subscription models are marked "(ChatGPT)" in the model picker; API-key models keep working alongside them.'
                      : 'Adds GPT models billed to your ChatGPT Plus/Pro subscription — works alongside the API key.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="openai-api-key">OpenAI API Key</Label>
                  <div className="relative">
                    <Input
                      type={showOpenaiApiKey ? "text" : "password"}
                      id="openai-api-key"
                      name="OPENAI_API_KEY"
                      value={settings.OPENAI_API_KEY || ''}
                      onChange={handleChange}
                      placeholder="Enter your OpenAI API key"
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-10 w-10"
                      onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                    >
                      {showOpenaiApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Get your API key from platform.openai.com
                  </p>
                </div>

                <div className="space-y-3">
                  <Label htmlFor="openai_reasoning_effort">
                    Reasoning Effort: <Badge variant="outline">{settings.openai_reasoning_effort}</Badge>
                  </Label>
                  <Select
                    value={settings.openai_reasoning_effort}
                    onValueChange={(value) => handleSelectChange('openai_reasoning_effort', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select reasoning effort" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="minimal">Minimal</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="xhigh">XHigh</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Controls reasoning depth for GPT models. GPT-5.4 defaults to none; temperature/top_p only work with none.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Speech to Text */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Mic className="h-5 w-5 text-primary" />
                  <span>Speech to Text</span>
                </CardTitle>
                <CardDescription>
                  Whisper provider for dictation and the voice agent — model lists are fetched live from each provider
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select
                    value={sttProvider}
                    onValueChange={(value) => handleSelectChange('sttProvider', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select STT provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="groq">Groq (cloud)</SelectItem>
                      <SelectItem value="openai">OpenAI (cloud)</SelectItem>
                      <SelectItem value="local">Local — mlx-whisper (on-device)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Model</Label>
                  <Select
                    value={settings[sttModelKey] || ''}
                    onValueChange={(value) => handleSelectChange(sttModelKey, value)}
                    disabled={sttModelOptions.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={audioModels ? 'Select model' : 'Loading models…'} />
                    </SelectTrigger>
                    <SelectContent>
                      {sttModelOptions.map((id) => (
                        <SelectItem key={id} value={id}>
                          {sttProvider === 'local'
                            ? `${id.replace('mlx-community/', '')}${(audioModels?.localDownloaded || []).includes(id) ? ' ✓' : ''}`
                            : id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {sttProvider === 'openai' && !openaiKeySet && (
                    <p className="text-xs text-amber-500">
                      Requires the OpenAI API key above.
                    </p>
                  )}
                  {sttProvider === 'local' && (
                    <p className="text-xs text-muted-foreground">
                      {localModelInfo?.sizeBytes
                        ? `Download size: ${formatBytes(localModelInfo.sizeBytes)}`
                        : 'All mlx-community whisper builds from HuggingFace (✓ = already on disk).'}
                      {localModelInfo &&
                        (localModelInfo.downloaded
                          ? ' — already on disk ✓'
                          : ' — downloads on first load')}
                    </p>
                  )}
                </div>

                {sttProvider === 'local' && (
                  audioModels && audioModels.localSupported === false ? (
                    <div className="flex items-center gap-2 border border-amber-500/30 bg-amber-500/10 rounded-lg px-3 py-2">
                      <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
                      <span className="text-sm">
                        Local Whisper needs Apple Silicon and uv (docs.astral.sh/uv).
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Local model (RAM)</Label>
                      <SidecarStatusRow
                        status={whisperStatus}
                        onLoad={handleWhisperLoad}
                        onUnload={handleWhisperUnload}
                      />
                      {whisperStatus.state === 'ready' &&
                        whisperStatus.model &&
                        settings.sttModelLocal &&
                        whisperStatus.model !== settings.sttModelLocal && (
                          <p className="text-xs text-amber-500">
                            A different model is loaded — click Load to switch to the selected one.
                          </p>
                        )}
                      {localModelInfo?.downloaded && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDeleteLocalModel(settings.sttModelLocal)}
                          className="text-red-500 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete download
                          {localModelInfo?.sizeBytes ? ` (${formatBytes(localModelInfo.sizeBytes)})` : ''}
                        </Button>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Downloads from HuggingFace on first load, then stays in RAM until you unload it
                        (auto-loads on first use otherwise). Deleting removes the files from disk only.
                      </p>
                    </div>
                  )
                )}
              </CardContent>
            </Card>

            {/* Text to Speech */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Volume2 className="h-5 w-5 text-primary" />
                  <span>Text to Speech</span>
                </CardTitle>
                <CardDescription>
                  Voice used when the agent speaks its replies
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select
                    value={ttsProvider}
                    onValueChange={(value) => handleSelectChange('ttsProvider', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select TTS provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kokoro">Kokoro — local MLX (on-device)</SelectItem>
                      <SelectItem value="openai">OpenAI (cloud)</SelectItem>
                    </SelectContent>
                  </Select>
                  {ttsProvider === 'kokoro' && audioModels && audioModels.kokoroSupported === false && (
                    <p className="text-xs text-amber-500">
                      Kokoro needs Apple Silicon and uv — pick OpenAI instead on this machine.
                    </p>
                  )}
                  {ttsProvider === 'openai' && !openaiKeySet && (
                    <p className="text-xs text-amber-500">
                      Requires the OpenAI API key above.
                    </p>
                  )}
                </div>

                {ttsProvider === 'kokoro' ? (
                  <div className="space-y-2">
                    <Label>Kokoro model (RAM)</Label>
                    <SidecarStatusRow
                      status={kokoroStatus}
                      onLoad={handleKokoroLoad}
                      onUnload={handleKokoroUnload}
                    />
                    {audioModels?.kokoroDownloaded && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteLocalModel(audioModels.kokoroModelId)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete download
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Preload for instant speech when the agent starts; unload to free RAM. The agent
                      loads it automatically when needed. Deleting removes the files from disk only.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label>Model</Label>
                      <Select
                        value={settings.ttsOpenaiModel || ''}
                        onValueChange={(value) => handleSelectChange('ttsOpenaiModel', value)}
                        disabled={ttsModelOptions.length === 0}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={audioModels ? 'Select model' : 'Loading models…'} />
                        </SelectTrigger>
                        <SelectContent>
                          {ttsModelOptions.map((id) => (
                            <SelectItem key={id} value={id}>
                              {id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Voice</Label>
                      <Select
                        value={settings.ttsOpenaiVoice || ''}
                        onValueChange={(value) => handleSelectChange('ttsOpenaiVoice', value)}
                        disabled={ttsVoiceOptions.length === 0}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select voice" />
                        </SelectTrigger>
                        <SelectContent>
                          {ttsVoiceOptions.map((voice) => (
                            <SelectItem key={voice} value={voice}>
                              {voice.charAt(0).toUpperCase() + voice.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Responses API & Connectors */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <span>Responses API & Connectors</span>
                </CardTitle>
                <CardDescription>
                  Enable the Groq Responses API and Google connectors for extended capabilities.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="use-responses-api" className="font-medium">
                      Use Responses API
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Switch from standard Chat Completions to the Responses API (Required for Connectors)
                    </p>
                  </div>
                  <Switch
                    id="use-responses-api"
                    checked={settings.useResponsesApi || false}
                    onChange={(e) => handleToggleChange('useResponsesApi', e.target.checked)}
                  />
                </div>

                {settings.useResponsesApi && (
                  <div className="space-y-4 pl-4 border-l-2 border-muted ml-2">
                    {/* Google OAuth Credentials Section */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Google OAuth Credentials</Label>
                        {googleOAuthStatus?.hasRefreshCapability && (
                          <div className="flex items-center gap-2">
                            {googleOAuthStatus?.expiresInMinutes !== null && (
                              <span className={`text-xs ${googleOAuthStatus.isExpired ? 'text-red-500' : googleOAuthStatus.expiresInMinutes < 10 ? 'text-yellow-500' : 'text-green-500'}`}>
                                {googleOAuthStatus.isExpired 
                                  ? 'Token expired' 
                                  : `Expires in ${googleOAuthStatus.expiresInMinutes} min`}
                              </span>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleGoogleOAuthRefresh}
                              disabled={isRefreshingToken}
                              className="h-7 text-xs"
                            >
                              {isRefreshingToken ? 'Refreshing...' : 'Refresh Token'}
                            </Button>
                          </div>
                        )}
                      </div>
                      
                      {/* Refresh Token */}
                      <div className="space-y-2">
                        <Label htmlFor="google-refresh-token" className="text-xs text-muted-foreground">
                          Refresh Token (permanent - enables auto-refresh)
                        </Label>
                        <Input
                          type="password"
                          id="google-refresh-token"
                          name="googleRefreshToken"
                          value={settings.googleRefreshToken || ''}
                          onChange={handleChange}
                          placeholder="1//0xxxxx... (from OAuth flow)"
                          className="font-mono text-sm"
                        />
                      </div>

                      {/* Client ID & Secret */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="google-client-id" className="text-xs text-muted-foreground">
                            Client ID
                          </Label>
                          <Input
                            type="password"
                            id="google-client-id"
                            name="googleClientId"
                            value={settings.googleClientId || ''}
                            onChange={handleChange}
                            placeholder="xxxxx.apps.googleusercontent.com"
                            className="font-mono text-sm"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="google-client-secret" className="text-xs text-muted-foreground">
                            Client Secret
                          </Label>
                          <Input
                            type="password"
                            id="google-client-secret"
                            name="googleClientSecret"
                            value={settings.googleClientSecret || ''}
                            onChange={handleChange}
                            placeholder="GOCSPX-xxxxx"
                            className="font-mono text-sm"
                          />
                        </div>
                      </div>

                      {/* Help Link */}
                      <p className="text-xs text-muted-foreground">
                        📖 Need help?{' '}
                        <a 
                          href="https://console.cloud.google.com/apis/credentials" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          Create OAuth credentials
                        </a>
                        {' '}→ Create Credentials → OAuth client ID → Desktop app
                      </p>

                      {/* Status Message */}
                      {settings.googleRefreshToken && settings.googleClientId && settings.googleClientSecret ? (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          ✓ Auto-refresh enabled - tokens will be refreshed automatically when they expire
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Enter refresh token + client credentials to enable automatic token refresh.
                          Or enter just an access token below (will expire in ~1 hour).
                        </p>
                      )}

                      {/* Manual Access Token (fallback) */}
                      <details className="pt-2">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          Manual Access Token (advanced)
                        </summary>
                        <div className="space-y-2 pt-2">
                          <Input
                            type="password"
                            id="google-oauth-token"
                            name="googleOAuthToken"
                            value={settings.googleOAuthToken || ''}
                            onChange={handleChange}
                            placeholder="ya29.xxxxx (expires in ~1 hour)"
                            className="font-mono text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            This is auto-populated when using refresh token. Manual entry only needed if not using auto-refresh.
                          </p>
                          <p className="text-xs text-muted-foreground">
                            💡 Generate a temporary token at{' '}
                            <a 
                              href="https://developers.google.com/oauthplayground/" 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              OAuth Playground
                            </a>
                          </p>
                        </div>
                      </details>
                    </div>

                    <div className="space-y-4 pt-2">
                      <Label className="text-sm font-medium text-muted-foreground">Connectors</Label>
                      
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <Switch
                              id="connector-gmail"
                              checked={settings.googleConnectors?.gmail || false}
                              onChange={(e) => handleGoogleConnectorToggle('gmail', e.target.checked)}
                            />
                            <Label htmlFor="connector-gmail" className="font-normal">Gmail</Label>
                          </div>
                          {settings.googleConnectors?.gmail && (
                            <Select
                              value={settings.googleConnectorsApproval?.gmail || 'never'}
                              onValueChange={(value) => handleGoogleConnectorApprovalChange('gmail', value)}
                            >
                              <SelectTrigger className="w-32 h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="never">Auto-approve</SelectItem>
                                <SelectItem value="always">Always ask</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <Switch
                              id="connector-calendar"
                              checked={settings.googleConnectors?.calendar || false}
                              onChange={(e) => handleGoogleConnectorToggle('calendar', e.target.checked)}
                            />
                            <Label htmlFor="connector-calendar" className="font-normal">Google Calendar</Label>
                          </div>
                          {settings.googleConnectors?.calendar && (
                            <Select
                              value={settings.googleConnectorsApproval?.calendar || 'never'}
                              onValueChange={(value) => handleGoogleConnectorApprovalChange('calendar', value)}
                            >
                              <SelectTrigger className="w-32 h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="never">Auto-approve</SelectItem>
                                <SelectItem value="always">Always ask</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <Switch
                              id="connector-drive"
                              checked={settings.googleConnectors?.drive || false}
                              onChange={(e) => handleGoogleConnectorToggle('drive', e.target.checked)}
                            />
                            <Label htmlFor="connector-drive" className="font-normal">Google Drive</Label>
                          </div>
                          {settings.googleConnectors?.drive && (
                            <Select
                              value={settings.googleConnectorsApproval?.drive || 'never'}
                              onValueChange={(value) => handleGoogleConnectorApprovalChange('drive', value)}
                            >
                              <SelectTrigger className="w-32 h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="never">Auto-approve</SelectItem>
                                <SelectItem value="always">Always ask</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Remote MCP Servers Section */}
                    <div className="space-y-4 pt-4 border-t border-muted">
                      <div className="space-y-1">
                        <Label className="text-sm font-medium">Remote MCP Servers</Label>
                        <p className="text-xs text-muted-foreground">
                          Connect to remote MCP servers. Groq handles tool discovery and execution server-side.
                        </p>
                      </div>

                      {/* Configured Remote MCP Servers List */}
                      {Object.keys(settings.remoteMcpServers || {}).length > 0 && (
                        <div className="space-y-3">
                          {Object.entries(settings.remoteMcpServers || {}).map(([id, config]) => {
                            const isEnabled = config.enabled !== false; // Default to true if not specified
                            return (
                              <Card key={id} className={`border-border/50 ${!isEnabled ? 'opacity-60' : ''}`}>
                                <CardContent className="p-3">
                                  <div className="flex justify-between items-start">
                                    <div className="flex items-center space-x-3">
                                      <Switch
                                        id={`remote-mcp-enabled-${id}`}
                                        checked={isEnabled}
                                        onChange={(e) => handleRemoteMcpServerToggle(id, e.target.checked)}
                                      />
                                      <div className="flex-1 space-y-1">
                                        <div className="flex items-center space-x-2">
                                          <Badge variant="secondary" className="text-xs">{config.serverLabel || id}</Badge>
                                          {config.requireApproval === 'always' && (
                                            <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700">
                                              Approval required
                                            </Badge>
                                          )}
                                          {!isEnabled && (
                                            <Badge variant="outline" className="text-xs bg-gray-100 text-gray-500">
                                              Disabled
                                            </Badge>
                                          )}
                                        </div>
                                        
                                        <div className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
                                          {config.serverUrl}
                                        </div>
                                        
                                        {config.serverDescription && (
                                          <div className="text-xs text-muted-foreground truncate max-w-[300px]">
                                            {config.serverDescription}
                                          </div>
                                        )}
                                        
                                        {config.headers && Object.keys(config.headers).length > 0 && (
                                          <div className="text-xs text-muted-foreground">
                                            <span>{Object.keys(config.headers).length} custom header(s)</span>
                                          </div>
                                        )}
                                        
                                        {config.allowedTools && config.allowedTools.length > 0 && (
                                          <div className="text-xs text-muted-foreground">
                                            <span>Allowed tools: {config.allowedTools.join(', ')}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    
                                    <div className="flex space-x-1 ml-2">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 w-7 p-0"
                                        onClick={() => startRemoteMcpEditing(id)}
                                      >
                                        <Edit3 className="h-3 w-3" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                        onClick={() => removeRemoteMcpServer(id)}
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      )}

                      {/* Add New Remote MCP Server Form */}
                      <div className="space-y-3 pt-2">
                        <h5 className="text-xs font-medium flex items-center space-x-1">
                          <Plus className="h-3 w-3" />
                          <span>{editingRemoteMcpServerId ? 'Edit Remote MCP Server' : 'Add Remote MCP Server'}</span>
                        </h5>
                        
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="remote-mcp-id" className="text-xs">Server ID</Label>
                            <Input
                              id="remote-mcp-id"
                              name="id"
                              value={newRemoteMcpServer.id}
                              onChange={handleNewRemoteMcpServerChange}
                              placeholder="e.g., huggingface"
                              className="h-8 text-sm"
                              disabled={editingRemoteMcpServerId !== null}
                            />
                          </div>
                          
                          <div className="space-y-1">
                            <Label htmlFor="remote-mcp-label" className="text-xs">Display Label</Label>
                            <Input
                              id="remote-mcp-label"
                              name="serverLabel"
                              value={newRemoteMcpServer.serverLabel}
                              onChange={handleNewRemoteMcpServerChange}
                              placeholder="e.g., Hugging Face"
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor="remote-mcp-url" className="text-xs">Server URL</Label>
                          <Input
                            id="remote-mcp-url"
                            name="serverUrl"
                            value={newRemoteMcpServer.serverUrl}
                            onChange={handleNewRemoteMcpServerChange}
                            placeholder="https://mcp.example.com"
                            className="h-8 text-sm"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor="remote-mcp-description" className="text-xs">Description (helps model understand when to use)</Label>
                          <Textarea
                            id="remote-mcp-description"
                            name="serverDescription"
                            value={newRemoteMcpServer.serverDescription}
                            onChange={handleNewRemoteMcpServerChange}
                            placeholder="e.g., Search and access AI models from Hugging Face"
                            className="min-h-[60px] text-sm"
                            rows={2}
                          />
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor="remote-mcp-require-approval" className="text-xs">Require Approval</Label>
                          <Select
                            value={newRemoteMcpServer.requireApproval || 'never'}
                            onValueChange={(value) => setNewRemoteMcpServer(prev => ({ ...prev, requireApproval: value }))}
                          >
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="never">Auto-approve (never ask)</SelectItem>
                              <SelectItem value="always">Always ask for approval</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            When set to "Always ask", you'll be prompted before each tool execution.
                          </p>
                        </div>

                        <div className="space-y-1">
                          <Label htmlFor="remote-mcp-allowed-tools" className="text-xs">Allowed Tools (optional)</Label>
                          <Input
                            id="remote-mcp-allowed-tools"
                            name="allowedTools"
                            value={newRemoteMcpServer.allowedTools}
                            onChange={handleNewRemoteMcpServerChange}
                            placeholder="e.g., model_search, paper_search"
                            className="h-8 text-sm"
                          />
                          <p className="text-xs text-muted-foreground">
                            Comma-separated list of tool names to allow. Leave empty for all tools.
                          </p>
                        </div>

                        {/* Headers Section */}
                        <div className="space-y-2">
                          <Label className="text-xs">Authentication Headers</Label>
                          <p className="text-xs text-muted-foreground">
                            Add headers for authentication (e.g., Authorization, X-API-Key)
                          </p>
                          
                          {Object.entries(newRemoteMcpServer.headers || {}).length > 0 && (
                            <div className="space-y-1">
                              {Object.entries(newRemoteMcpServer.headers || {}).map(([key, value]) => (
                                <div key={key} className="flex items-center space-x-2">
                                  <div className="flex-1 grid grid-cols-2 gap-2">
                                    <Input value={key} disabled className="bg-muted h-7 text-xs" />
                                    <Input 
                                      value={
                                        key.toLowerCase().includes('auth') || 
                                        key.toLowerCase().includes('key') || 
                                        key.toLowerCase().includes('token') || 
                                        key.toLowerCase().includes('secret')
                                          ? '*'.repeat(Math.min(value.length, 20))
                                          : (typeof value === 'string' && value.length > 20 ? `${value.substring(0, 17)}...` : value)
                                      } 
                                      disabled 
                                      className="bg-muted h-7 text-xs" 
                                    />
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={() => removeRemoteMcpHeader(key)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                          
                          <div className="flex items-center space-x-2">
                            <Input
                              name="key"
                              value={newRemoteMcpHeader.key}
                              onChange={handleRemoteMcpHeaderChange}
                              placeholder="Header name"
                              className="flex-1 h-7 text-xs"
                            />
                            <Input
                              name="value"
                              value={newRemoteMcpHeader.value}
                              onChange={handleRemoteMcpHeaderChange}
                              placeholder="Header value"
                              className="flex-1 h-7 text-xs"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7"
                              onClick={addRemoteMcpHeader}
                              disabled={!newRemoteMcpHeader.key}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>

                        <div className="flex justify-end space-x-2 pt-2">
                          {editingRemoteMcpServerId && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={cancelRemoteMcpEditing}
                            >
                              <X className="h-3 w-3 mr-1" />
                              Cancel
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setNewRemoteMcpServer({
                                id: '',
                                serverUrl: '',
                                serverLabel: '',
                                serverDescription: '',
                                requireApproval: 'never',
                                allowedTools: '',
                                headers: {}
                              });
                              setEditingRemoteMcpServerId(null);
                            }}
                          >
                            <X className="h-3 w-3 mr-1" />
                            Clear
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleSaveRemoteMcpServer}
                            disabled={!newRemoteMcpServer.id || !newRemoteMcpServer.serverUrl}
                          >
                            <Save className="h-3 w-3 mr-1" />
                            {editingRemoteMcpServerId ? 'Update' : 'Add'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Generation Parameters */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Cpu className="h-5 w-5 text-primary" />
                  <span>Generation Parameters</span>
                </CardTitle>
                <CardDescription>
                  Fine-tune model behavior and response characteristics
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <Label htmlFor="temperature">
                      Temperature: <Badge variant="outline">{settings.temperature}</Badge>
                    </Label>
                    <input
                      type="range"
                      id="temperature"
                      name="temperature"
                      min="0"
                      max="2"
                      step="0.01"
                      value={settings.temperature}
                      onChange={handleNumberChange}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-muted-foreground">
                      Lower values make responses more deterministic, higher values more creative
                    </p>
                  </div>
                  
                  <div className="space-y-3">
                    <Label htmlFor="top_p">
                      Top P: <Badge variant="outline">{settings.top_p}</Badge>
                    </Label>
                    <input
                      type="range"
                      id="top_p"
                      name="top_p"
                      min="0"
                      max="1"
                      step="0.01"
                      value={settings.top_p}
                      onChange={handleNumberChange}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                    />
                    <p className="text-xs text-muted-foreground">
                      Controls diversity by limiting tokens to the most likely ones
                    </p>
                  </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <Label htmlFor="reasoning_effort">
                      Reasoning Effort: <Badge variant="outline">{settings.reasoning_effort}</Badge>
                    </Label>
                    <Select
                      value={settings.reasoning_effort}
                      onValueChange={(value) => handleSelectChange('reasoning_effort', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select reasoning effort" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Controls reasoning depth for gpt-oss models (low: fast, high: more thorough)
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Popup Window Settings */}
            <Card>
              <CardHeader>
                <CardTitle>Popup Window</CardTitle>
                <CardDescription>
                  Enable or disable the global hotkey (Cmd+G or Ctrl+G) to open the popup window for quick context capture.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <Label htmlFor="popup-enabled" className="font-medium">
                    Enable Popup Window
                  </Label>
                  <Switch
                    id="popup-enabled"
                    checked={settings.popupEnabled}
                    onChange={(e) => handleToggleChange('popupEnabled', e.target.checked)}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Thinking Summaries Settings */}
            <Card>
              <CardHeader>
                <CardTitle>Thinking Summaries</CardTitle>
                <CardDescription>
                  Control whether thinking/reasoning summaries are generated during model reasoning. When disabled, only the raw reasoning text will be shown.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <Label htmlFor="disable-thinking-summaries" className="font-medium">
                    Disable Thinking Summaries
                  </Label>
                  <Switch
                    id="disable-thinking-summaries"
                    checked={settings.disableThinkingSummaries || false}
                    onChange={(e) => handleToggleChange('disableThinkingSummaries', e.target.checked)}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  When enabled, thinking summaries will not be generated. Only the raw reasoning text will be displayed.
                </p>
              </CardContent>
            </Card>

            {/* API Request Logging */}
            <Card>
              <CardHeader>
                <CardTitle>API Request Logging</CardTitle>
                <CardDescription>
                  Log API request payloads and responses to /tmp for debugging
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <Label htmlFor="log-api-requests" className="font-medium">
                    Log API Requests
                  </Label>
                  <Switch
                    id="log-api-requests"
                    checked={settings.logApiRequests || false}
                    onChange={(e) => handleToggleChange('logApiRequests', e.target.checked)}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  When enabled, request payloads and response chunks will be written to /tmp with timestamps. File paths are logged to the console.
                </p>
              </CardContent>
            </Card>

            {/* Built-in Tools Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <span>Built-in Tools</span>
                </CardTitle>
                <CardDescription>
                  Enable built-in tools for supported models (OpenAI and Emberfow models only).
                  These tools don't require MCP servers and work directly with the model.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="code-interpreter" className="font-medium">
                        Code Interpreter
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Run Python code for calculations, data analysis, and more
                      </p>
                    </div>
                    <Switch
                      id="code-interpreter"
                      checked={settings.builtInTools?.codeInterpreter || false}
                      onChange={(e) => handleBuiltInToolToggle('codeInterpreter', e.target.checked)}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="browser-search" className="font-medium">
                        Browser Search
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Search the web for real-time information and current events
                      </p>
                    </div>
                    <Switch
                      id="browser-search"
                      checked={settings.builtInTools?.browserSearch || false}
                      onChange={(e) => handleBuiltInToolToggle('browserSearch', e.target.checked)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Custom System Prompt */}
            <Card>
              <CardHeader>
                <CardTitle>Custom System Prompt</CardTitle>
                <CardDescription>
                  Add custom instructions that will be appended to the default system prompt
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Textarea
                    id="custom-system-prompt"
                    name="customSystemPrompt"
                    value={settings.customSystemPrompt || ''}
                    onChange={handleChange}
                    rows={4}
                    placeholder="Optional: Enter your custom system prompt..."
                    className="min-h-[100px]"
                  />
                </div>
              </CardContent>
            </Card>

            {/* MCP Servers */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Server className="h-5 w-5 text-primary" />
                  <span>MCP Servers</span>
                </CardTitle>
                <CardDescription>
                  Configure Model Context Protocol servers for extended AI capabilities
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Configured Servers List */}
                {Object.keys(settings.mcpServers || {}).length > 0 ? (
                  <div className="space-y-4">
                    <h4 className="font-medium text-sm">Configured Servers</h4>
                    <div className="space-y-3">
                      {Object.entries(settings.mcpServers || {}).map(([id, config]) => (
                        <Card key={id} className="border-border/50">
                          <CardContent className="p-4">
                            <div className="flex justify-between items-start">
                              <div className="flex-1 space-y-2">
                                <div className="flex items-center space-x-2">
                                  <Badge variant="secondary">{id}</Badge>
                                  <Badge variant="outline" className="text-xs">
                                    {config.transport === 'sse' ? 'SSE' : 
                                     config.transport === 'streamableHttp' ? 'Streamable HTTP' : 'Stdio'}
                                  </Badge>
                                </div>
                                
                                <div className="text-sm text-muted-foreground font-mono">
                                  {config.transport === 'sse' || config.transport === 'streamableHttp' ? (
                                    <span>URL: {config.url}</span>
                                  ) : (
                                    <span>$ {config.command} {(config.args || []).join(' ')}</span>
                                  )}
                                </div>
                                
                                {config.env && Object.keys(config.env).length > 0 && (
                                  <div className="text-xs text-muted-foreground">
                                    <span>Environment variables: {Object.keys(config.env).length} configured</span>
                                  </div>
                                )}
                                
                                {config.headers && Object.keys(config.headers).length > 0 && (
                                  <div className="text-xs text-muted-foreground">
                                    <span>Custom headers: {Object.keys(config.headers).length} configured</span>
                                  </div>
                                )}
                              </div>
                              
                              <div className="flex space-x-2 ml-4">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => startEditing(id)}
                                >
                                  <Edit3 className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => removeMcpServer(id)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <Server className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No MCP servers configured</p>
                    <p className="text-sm">Add a server below to get started</p>
                  </div>
                )}

                {/* Add New Server Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="font-medium text-sm flex items-center space-x-2">
                    <Plus className="h-4 w-4" />
                    <span>Add New MCP Server</span>
                  </h4>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="server-id">Server ID</Label>
                      <Input
                        id="server-id"
                        name="id"
                        value={newMcpServer.id}
                        onChange={handleNewMcpServerChange}
                        placeholder="e.g., filesystem, postgres"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="transport">Transport Type</Label>
                      <Select
                        value={newMcpServer.transport}
                        onValueChange={handleTransportChange}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select transport type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stdio">Stdio</SelectItem>
                          <SelectItem value="sse">SSE</SelectItem>
                          <SelectItem value="streamableHttp">Streamable HTTP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {newMcpServer.transport === 'stdio' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="command">Command</Label>
                        <Input
                          id="command"
                          name="command"
                          value={newMcpServer.command}
                          onChange={handleNewMcpServerChange}
                          placeholder="e.g., node, python, /path/to/executable"
                        />
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="args">Arguments</Label>
                        <Input
                          id="args"
                          name="args"
                          value={newMcpServer.args}
                          onChange={handleNewMcpServerChange}
                          placeholder="e.g., server.js --port 3000"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="url">URL</Label>
                      <Input
                        id="url"
                        name="url"
                        value={newMcpServer.url}
                        onChange={handleNewMcpServerChange}
                        placeholder="e.g., http://localhost:3000/sse"
                      />
                    </div>
                  )}

                  {/* Headers Section for Remote Transports */}
                  {(newMcpServer.transport === 'sse' || newMcpServer.transport === 'streamableHttp') && (
                    <div className="space-y-4">
                      <div>
                        <Label>Custom Headers</Label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Add custom HTTP headers for authentication or other purposes (e.g., Authorization, X-API-Key)
                        </p>
                        <div className="mt-2 space-y-2">
                          {Object.entries(newMcpServer.headers || {}).map(([key, value]) => (
                            <div key={key} className="flex items-center space-x-2">
                              <div className="flex-1 grid grid-cols-2 gap-2">
                                <Input value={key} disabled className="bg-muted" />
                                <Input 
                                  value={
                                    key.toLowerCase().includes('auth') || 
                                    key.toLowerCase().includes('key') || 
                                    key.toLowerCase().includes('token') || 
                                    key.toLowerCase().includes('secret')
                                      ? '*'.repeat(Math.min(value.length, 20))
                                      : (typeof value === 'string' && value.length > 30 ? `${value.substring(0, 27)}...` : value)
                                  } 
                                  disabled 
                                  className="bg-muted" 
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeHeader(key)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                          
                          <div className="flex items-center space-x-2">
                            <Input
                              name="key"
                              value={newHeader.key}
                              onChange={handleHeaderChange}
                              placeholder="Header name (e.g., Authorization)"
                              className="flex-1"
                            />
                            <Input
                              name="value"
                              value={newHeader.value}
                              onChange={handleHeaderChange}
                              placeholder="Header value (e.g., Bearer token123)"
                              className="flex-1"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={addHeader}
                              disabled={!newHeader.key}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Environment Variables Section */}
                  {newMcpServer.transport === 'stdio' && (
                    <div className="space-y-4">
                      <div>
                        <Label>Environment Variables</Label>
                        <div className="mt-2 space-y-2">
                          {Object.entries(newMcpServer.env || {}).map(([key, value]) => (
                            <div key={key} className="flex items-center space-x-2">
                              <div className="flex-1 grid grid-cols-2 gap-2">
                                <Input value={key} disabled className="bg-muted" />
                                <Input 
                                  value={
                                    key.toLowerCase().includes('key') || 
                                    key.toLowerCase().includes('token') || 
                                    key.toLowerCase().includes('secret')
                                      ? '*'.repeat(key.length)
                                      : (typeof value === 'string' && value.length > 30 ? `${value.substring(0, 27)}...` : value)
                                  } 
                                  disabled 
                                  className="bg-muted" 
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeEnvVar(key)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                          
                          <div className="flex items-center space-x-2">
                            <Input
                              name="key"
                              value={newEnvVar.key}
                              onChange={handleEnvVarChange}
                              placeholder="Variable name"
                              className="flex-1"
                            />
                            <Input
                              name="value"
                              value={newEnvVar.value}
                              onChange={handleEnvVarChange}
                              placeholder="Variable value"
                              className="flex-1"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={addEnvVar}
                              disabled={!newEnvVar.key}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end space-x-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setNewMcpServer({
                          id: '', transport: 'stdio', command: '', args: '', env: {}, url: '', headers: {}
                        });
                        setJsonInput('');
                        setJsonError(null);
                      }}
                    >
                      <X className="h-4 w-4 mr-2" />
                      Clear
                    </Button>
                    <Button
                      onClick={handleSaveMcpServer}
                      disabled={!newMcpServer.id || (newMcpServer.transport === 'stdio' && !newMcpServer.command) || ((newMcpServer.transport === 'sse' || newMcpServer.transport === 'streamableHttp') && !newMcpServer.url)}
                    >
                      <Save className="h-4 w-4 mr-2" />
                      {editingServerId ? 'Update Server' : 'Add Server'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Tool Approvals */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Zap className="h-5 w-5 text-primary" />
                  <span>Tool Approvals</span>
                </CardTitle>
                <CardDescription>
                  Reset tool call approval settings stored in browser
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="destructive"
                  onClick={handleResetToolApprovals}
                  disabled={isSaving}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Reset Tool Approvals
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  This will remove all saved tool approval preferences and prompt you again for each tool
                </p>
              </CardContent>
            </Card>

            {/* Custom Models */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Cpu className="h-5 w-5 text-primary" />
                  <span>Custom Models</span>
                </CardTitle>
                <CardDescription>
                  Define custom AI models with their context sizes and capabilities
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Configured Custom Models List */}
                {Object.keys(settings.customModels || {}).length > 0 ? (
                  <div className="space-y-4">
                    <h4 className="font-medium text-sm">Configured Custom Models</h4>
                    <div className="space-y-3">
                      {Object.entries(settings.customModels || {}).map(([id, config]) => (
                        <Card key={id} className="border-border/50">
                          <CardContent className="p-4">
                            <div className="flex justify-between items-start">
                              <div className="flex-1 space-y-2">
                                <div className="flex items-center space-x-2">
                                  <Badge variant="secondary">{config.displayName || id}</Badge>
                                  <Badge variant="outline" className="text-xs">
                                    {config.context?.toLocaleString() || '8,192'} tokens
                                  </Badge>
                                  {config.vision_supported && (
                                    <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700">
                                      Vision
                                    </Badge>
                                  )}
                                  {config.builtin_tools_supported && (
                                    <Badge variant="outline" className="text-xs bg-green-50 text-green-700">
                                      Built-in Tools
                                    </Badge>
                                  )}
                                </div>
                                
                                <div className="text-sm text-muted-foreground font-mono">
                                  Model ID: {id}
                                </div>
                              </div>
                              
                              <div className="flex space-x-2 ml-4">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => startModelEditing(id)}
                                >
                                  <Edit3 className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => removeCustomModel(id)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <Cpu className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>No custom models configured</p>
                    <p className="text-sm">Add a custom model below to get started</p>
                  </div>
                )}

                {/* Add New Custom Model Section */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="font-medium text-sm flex items-center space-x-2">
                    <Plus className="h-4 w-4" />
                    <span>{editingModelId ? 'Edit Custom Model' : 'Add New Custom Model'}</span>
                  </h4>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="model-id">Model ID</Label>
                      <Input
                        id="model-id"
                        name="id"
                        value={newCustomModel.id}
                        onChange={handleNewCustomModelChange}
                        placeholder="e.g., my-custom-model, local/llama-7b"
                        disabled={editingModelId !== null}
                      />
                      <p className="text-xs text-muted-foreground">
                        Unique identifier for the model (cannot be changed after creation)
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="model-display-name">Display Name</Label>
                      <Input
                        id="model-display-name"
                        name="displayName"
                        value={newCustomModel.displayName}
                        onChange={handleNewCustomModelChange}
                        placeholder="e.g., My Custom Model, Local Llama 7B"
                      />
                      <p className="text-xs text-muted-foreground">
                        Friendly name shown in the model selector
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="model-context">Context Size (tokens)</Label>
                      <Input
                        id="model-context"
                        name="context"
                        type="number"
                        value={newCustomModel.context}
                        onChange={handleNewCustomModelChange}
                        placeholder="8192"
                        min="1024"
                        max="1000000"
                      />
                      <p className="text-xs text-muted-foreground">
                        Maximum number of tokens the model can process
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="model-vision">Capabilities</Label>
                      <div className="space-y-3 pt-2">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="model-vision"
                            name="vision_supported"
                            checked={newCustomModel.vision_supported}
                            onChange={handleNewCustomModelChange}
                            className="rounded border-gray-300"
                          />
                          <Label htmlFor="model-vision" className="text-sm font-normal">
                            Supports vision/image inputs
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id="model-builtin-tools"
                            name="builtin_tools_supported"
                            checked={newCustomModel.builtin_tools_supported}
                            onChange={handleNewCustomModelChange}
                            className="rounded border-gray-300"
                          />
                          <Label htmlFor="model-builtin-tools" className="text-sm font-normal">
                            Supports built-in tools (code interpreter, browser search)
                          </Label>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Enable capabilities based on what the model supports
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-end space-x-2">
                    {editingModelId && (
                      <Button
                        variant="outline"
                        onClick={cancelModelEditing}
                      >
                        <X className="h-4 w-4 mr-2" />
                        Cancel
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setNewCustomModel({
                          id: '', displayName: '', context: 8192, vision_supported: false, builtin_tools_supported: false
                        });
                        setEditingModelId(null);
                      }}
                    >
                      <X className="h-4 w-4 mr-2" />
                      Clear
                    </Button>
                    <Button
                      onClick={handleSaveCustomModel}
                      disabled={!newCustomModel.id || !newCustomModel.displayName}
                    >
                      <Save className="h-4 w-4 mr-2" />
                      {editingModelId ? 'Update Model' : 'Add Model'}
                    </Button>
                  </div>
                </div>

                {/* Model Filter */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="font-medium text-sm">Model Filter</h4>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Filter models shown in the model selector. Enter one filter term per line (case-insensitive). Only models matching any filter term will be displayed.
                    </p>
                    <Textarea
                      id="model-filter"
                      name="modelFilter"
                      value={settings.modelFilter || ''}
                      onChange={handleChange}
                      rows={6}
                      placeholder="Enter one filter term per line (e.g., gpt, kimi, llama)"
                      className="min-h-[120px] font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Example: Enter "gpt" on one line and "kimi" on another to show only models containing "gpt" or "kimi" (case-insensitive).
                    </p>
                  </div>
                </div>

                {/* Model Filter Exclude */}
                <div className="border-t pt-6 space-y-4">
                  <h4 className="font-medium text-sm">Filter Out Models</h4>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Models containing these words will be filtered out regardless of inclusion filters. Enter one filter term per line (case-insensitive).
                    </p>
                    <Textarea
                      id="model-filter-exclude"
                      name="modelFilterExclude"
                      value={settings.modelFilterExclude || ''}
                      onChange={handleChange}
                      rows={6}
                      placeholder="Enter one filter term per line (e.g., deprecated, legacy, test)"
                      className="min-h-[120px] font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Example: Enter "deprecated" on one line to hide all models containing "deprecated" in their name, even if they match inclusion filters.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

export default Settings; 