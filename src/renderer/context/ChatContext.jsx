import React, { createContext, useState, useContext, useCallback, useEffect, useRef, useMemo } from 'react';

// Create the context
export const ChatContext = createContext();

// Create a provider component
export const ChatProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [chatList, setChatList] = useState([]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isLoadingChats, setIsLoadingChats] = useState(true);

  // Projects: instructions + files shared by the chats inside them. A chat
  // created while a project is selected belongs to that project.
  const [projects, setProjects] = useState([]);
  const [currentProjectId, setCurrentProjectId] = useState(null);

  // Use refs to track current ids for immediate access (state updates are async)
  const currentChatIdRef = useRef(null);
  const currentProjectIdRef = useRef(null);

  // Track if we need to generate a title after first user message
  const needsTitleGeneration = useRef(false);
  // Chats whose title request is in flight (a stale "New Chat" being retitled
  // on load must not block the title of a chat that just started)
  const titleGenerationInProgress = useRef(new Set());

  // Keep refs in sync with state
  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);
  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);

  // Load the list of chats
  const loadChatList = useCallback(async () => {
    try {
      setIsLoadingChats(true);
      const chats = await window.electron.chatHistory.list();
      setChatList(chats || []);
    } catch (error) {
      console.error('Error loading chat list:', error);
      setChatList([]);
    } finally {
      setIsLoadingChats(false);
    }
  }, []);

  // Load the list of projects
  const loadProjects = useCallback(async () => {
    try {
      const list = await window.electron.projects.list();
      setProjects(list || []);
    } catch (error) {
      console.error('Error loading projects:', error);
      setProjects([]);
    }
  }, []);

  // Load chats and projects on mount
  useEffect(() => {
    loadChatList();
    loadProjects();
  }, [loadChatList, loadProjects]);

  // Generate and update chat title
  const generateAndUpdateTitle = useCallback(async (chatId, userMessage) => {
    if (!chatId || titleGenerationInProgress.current.has(chatId)) return;

    titleGenerationInProgress.current.add(chatId);
    console.log('[ChatContext] Generating title for chat:', chatId);

    try {
      // Extract text content if structured message
      let textContent = userMessage;
      if (Array.isArray(userMessage)) {
        textContent = userMessage
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join(' ');
      }

      // The chat's own model produces the title
      const title = await window.electron.chatHistory.generateTitle(textContent, chatId);
      console.log('[ChatContext] Generated title:', title);

      if (title && title !== 'New Chat') {
        await window.electron.chatHistory.updateTitle(chatId, title);
        // Refresh chat list to show new title
        await loadChatList();
      }
    } catch (error) {
      console.error('Error generating chat title:', error);
    } finally {
      titleGenerationInProgress.current.delete(chatId);
      if (chatId === currentChatIdRef.current) {
        needsTitleGeneration.current = false;
      }
    }
  }, [loadChatList]);

  // Create a new chat. It belongs to the selected project unless told otherwise.
  const createNewChat = useCallback(async (model, useResponsesApi = false, projectId) => {
    const targetProjectId = projectId === undefined ? currentProjectIdRef.current : projectId;
    try {
      const chat = await window.electron.chatHistory.create(model, useResponsesApi, targetProjectId || null);
      if (chat) {
        // Update both state and ref immediately
        currentChatIdRef.current = chat.id;
        setCurrentChatId(chat.id);
        setMessages([]);
        needsTitleGeneration.current = true;
        // Refresh the chat list
        await loadChatList();
        console.log('[ChatContext] Created new chat:', chat.id, 'useResponsesApi:', useResponsesApi, 'project:', targetProjectId || null);
        return chat;
      }
    } catch (error) {
      console.error('Error creating new chat:', error);
    }
    return null;
  }, [loadChatList]);

  // Load a specific chat (and switch to its project, if it has one)
  const loadChat = useCallback(async (chatId) => {
    try {
      const chat = await window.electron.chatHistory.load(chatId);
      if (chat) {
        currentChatIdRef.current = chat.id;
        setCurrentChatId(chat.id);
        setMessages(chat.messages || []);
        const projectId = chat.projectId || null;
        currentProjectIdRef.current = projectId;
        setCurrentProjectId(projectId);
        // Don't need title generation for existing chats
        needsTitleGeneration.current = false;
        // Chats that never got a title (title generation was failing for a
        // while) pick one up the first time they are opened again
        if (!chat.title || chat.title === 'New Chat') {
          const firstUserMessage = (chat.messages || []).find(m => m.role === 'user');
          if (firstUserMessage) {
            generateAndUpdateTitle(chat.id, firstUserMessage.content);
          }
        }
        return chat;
      }
    } catch (error) {
      console.error('Error loading chat:', error);
    }
    return null;
  }, [generateAndUpdateTitle]);

  // Update the timestamp of a chat locally without reloading the entire list
  const updateChatTimestampLocally = useCallback((chatId) => {
    setChatList(prev => {
      const updatedList = prev.map(chat =>
        chat.id === chatId
          ? { ...chat, updatedAt: new Date().toISOString() }
          : chat
      );
      // Re-sort by updatedAt (most recent first)
      return updatedList.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    });
  }, []);

  // Save current chat messages
  const saveCurrentChat = useCallback(async (updatedMessages) => {
    const chatId = currentChatIdRef.current;
    if (!chatId) return;

    try {
      await window.electron.chatHistory.updateMessages(chatId, updatedMessages || messages);
      // Update timestamp locally instead of reloading the entire list
      updateChatTimestampLocally(chatId);
    } catch (error) {
      console.error('Error saving chat:', error);
    }
  }, [messages, updateChatTimestampLocally]);

  // Delete a chat
  const deleteChat = useCallback(async (chatId) => {
    try {
      const result = await window.electron.chatHistory.delete(chatId);
      if (result.success) {
        // If we deleted the current chat, clear the state
        if (chatId === currentChatIdRef.current) {
          currentChatIdRef.current = null;
          setCurrentChatId(null);
          setMessages([]);
        }
        // Refresh chat list
        await loadChatList();
        return true;
      }
    } catch (error) {
      console.error('Error deleting chat:', error);
    }
    return false;
  }, [loadChatList]);

  // Start a fresh chat (clear current without creating new). Stays in the
  // selected project, if any.
  const startFreshChat = useCallback(() => {
    currentChatIdRef.current = null;
    setCurrentChatId(null);
    setMessages([]);
    needsTitleGeneration.current = false;
  }, []);

  // --- Projects ---

  // Select a project (null leaves projects). Clears the open chat so the
  // next message starts a chat inside (or outside) the project.
  const selectProject = useCallback((projectId) => {
    const next = projectId || null;
    currentProjectIdRef.current = next;
    setCurrentProjectId(next);
    startFreshChat();
  }, [startFreshChat]);

  // Replace one project in the list without re-sorting (autosaves must not
  // shuffle the sidebar under the cursor)
  const replaceProject = useCallback((project) => {
    if (!project) return;
    setProjects(prev => {
      const exists = prev.some(p => p.id === project.id);
      return exists ? prev.map(p => (p.id === project.id ? project : p)) : [project, ...prev];
    });
  }, []);

  const createProject = useCallback(async (data) => {
    try {
      const project = await window.electron.projects.create(data);
      if (project) {
        await loadProjects();
        selectProject(project.id);
        return project;
      }
    } catch (error) {
      console.error('Error creating project:', error);
    }
    return null;
  }, [loadProjects, selectProject]);

  const updateProject = useCallback(async (projectId, patch) => {
    const project = await window.electron.projects.update(projectId, patch);
    replaceProject(project);
    return project;
  }, [replaceProject]);

  const deleteProject = useCallback(async (projectId) => {
    try {
      const result = await window.electron.projects.delete(projectId);
      if (result?.success) {
        if (projectId === currentProjectIdRef.current) {
          selectProject(null);
        }
        await Promise.all([loadProjects(), loadChatList()]);
        return true;
      }
    } catch (error) {
      console.error('Error deleting project:', error);
    }
    return false;
  }, [loadProjects, loadChatList, selectProject]);

  // Native file picker (files are read by the main process)
  const pickProjectFiles = useCallback(async (projectId) => {
    const result = await window.electron.projects.pickFiles(projectId);
    if (result?.project) replaceProject(result.project);
    return result;
  }, [replaceProject]);

  // Dropped file bytes: { name, type, data: Uint8Array }
  const addProjectFile = useCallback(async (projectId, file) => {
    const result = await window.electron.projects.addFile(projectId, file);
    if (result?.project) replaceProject(result.project);
    return result;
  }, [replaceProject]);

  const removeProjectFile = useCallback(async (projectId, fileId) => {
    const project = await window.electron.projects.removeFile(projectId, fileId);
    replaceProject(project);
    return project;
  }, [replaceProject]);

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId) || null,
    [projects, currentProjectId]
  );

  // Toggle sidebar collapsed state
  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => !prev);
  }, []);

  // Wrapper for setMessages that also handles saving and title generation
  const setMessagesWithSave = useCallback((updater) => {
    setMessages(prev => {
      const newMessages = typeof updater === 'function' ? updater(prev) : updater;

      // Use ref for immediate access to current chat ID
      const chatId = currentChatIdRef.current;

      // If we have a current chat, save the messages
      if (chatId && newMessages.length > 0) {
        // Save asynchronously without blocking
        window.electron.chatHistory.updateMessages(chatId, newMessages)
          .then(() => {
            // Update timestamp locally instead of reloading entire list
            updateChatTimestampLocally(chatId);
          })
          .catch(err => console.error('Error auto-saving chat:', err));
      }

      // Check if we need to generate a title (first user message added)
      if (needsTitleGeneration.current && chatId) {
        const userMessages = newMessages.filter(m => m.role === 'user');
        if (userMessages.length === 1) {
          // First user message - generate title. Cleared right away so the
          // stream of assistant updates that follows doesn't re-trigger it.
          needsTitleGeneration.current = false;
          console.log('[ChatContext] First user message detected, generating title...');
          generateAndUpdateTitle(chatId, userMessages[0].content);
        }
      }

      return newMessages;
    });
  }, [generateAndUpdateTitle, updateChatTimestampLocally]);

  // Provide the state and methods to children
  const value = {
    messages,
    setMessages: setMessagesWithSave,
    currentChatId,
    chatList,
    isLoadingChats,
    isSidebarCollapsed,
    loadChatList,
    createNewChat,
    loadChat,
    saveCurrentChat,
    deleteChat,
    startFreshChat,
    toggleSidebar,
    needsTitleGeneration,
    // Projects
    projects,
    currentProjectId,
    currentProject,
    loadProjects,
    selectProject,
    createProject,
    updateProject,
    deleteProject,
    pickProjectFiles,
    addProjectFile,
    removeProjectFile,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

// Create a custom hook for easy context consumption
export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
