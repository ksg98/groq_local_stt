import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChat } from '../context/ChatContext';
import { Button } from './ui/button';
import {
  MessageSquare,
  Plus,
  ChevronLeft,
  ChevronRight,
  Trash2,
  MoreVertical,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  ArrowLeft,
  Pencil,
  BookOpen,
  FileText
} from 'lucide-react';

// LocalStorage key for sidebar width
const SIDEBAR_WIDTH_KEY = 'chat_sidebar_width';
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 256; // w-64 = 16rem = 256px
const COLLAPSED_WIDTH = 64; // w-16 = 4rem = 64px

// Format relative time for chat items
function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Group chats by time period
function groupChatsByDate(chats) {
  const groups = {
    today: [],
    yesterday: [],
    thisWeek: [],
    thisMonth: [],
    older: []
  };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart - 86400000);
  const weekStart = new Date(todayStart - 6 * 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  chats.forEach(chat => {
    const chatDate = new Date(chat.updatedAt);

    if (chatDate >= todayStart) {
      groups.today.push(chat);
    } else if (chatDate >= yesterdayStart) {
      groups.yesterday.push(chat);
    } else if (chatDate >= weekStart) {
      groups.thisWeek.push(chat);
    } else if (chatDate >= monthStart) {
      groups.thisMonth.push(chat);
    } else {
      groups.older.push(chat);
    }
  });

  return groups;
}

function ChatHistorySidebar({
  onNewChat,
  onChatLoaded,
  loading,
  onCreateProject,
  onEditProject,
  onOpenProjectKnowledge
}) {
  const {
    chatList,
    currentChatId,
    loadChat,
    deleteChat,
    isSidebarCollapsed,
    toggleSidebar,
    isLoadingChats,
    projects,
    currentProject,
    currentProjectId,
    selectProject,
    deleteProject
  } = useChat();

  const [hoveredId, setHoveredId] = useState(null);
  // Open ⋯ menu: { type: 'chat' | 'project', id }
  const [openMenu, setOpenMenu] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuButtonRefs = useRef({});

  // Resize state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return savedWidth ? parseInt(savedWidth, 10) : DEFAULT_SIDEBAR_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef(null);

  // Handle mouse move during resize
  const handleMouseMove = useCallback((e) => {
    if (!isResizing) return;

    const newWidth = e.clientX;
    const clampedWidth = Math.min(Math.max(newWidth, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
    setSidebarWidth(clampedWidth);
  }, [isResizing]);

  // Handle mouse up to stop resizing
  const handleMouseUp = useCallback(() => {
    if (isResizing) {
      setIsResizing(false);
      // Save to localStorage
      localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
    }
  }, [isResizing, sidebarWidth]);

  // Start resizing
  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // Add/remove event listeners for resize
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // Prevent text selection during resize
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleChatClick = async (chatId) => {
    if (loading) return; // Don't switch chats while loading
    if (chatId === currentChatId) return; // Already on this chat
    const chat = await loadChat(chatId);
    if (chat) {
      const protocol = chat.useResponsesApi ? 'Responses API' : 'Chat Completions API';
      console.log(`[Chat Selected] "${chat.title || 'New Chat'}" | ID: ${chat.id} | Model: ${chat.model} | Protocol: ${protocol}`);
      if (onChatLoaded) {
        onChatLoaded(chat);
      }
    }
  };

  const handleProjectClick = (projectId) => {
    if (loading) return;
    if (projectId === currentProjectId) return;
    selectProject(projectId);
  };

  const handleLeaveProject = () => {
    if (loading) return;
    selectProject(null);
  };

  const handleDeleteChat = async (e, chatId) => {
    e.stopPropagation();
    setDeletingId(chatId);
    await deleteChat(chatId);
    setDeletingId(null);
    setOpenMenu(null);
  };

  const handleDeleteProject = async (e, project) => {
    e.stopPropagation();
    setOpenMenu(null);
    const chatCount = chatList.filter(c => c.projectId === project.id).length;
    const what = chatCount
      ? `"${project.name}" and its ${chatCount} chat${chatCount === 1 ? '' : 's'}`
      : `"${project.name}"`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    setDeletingId(project.id);
    await deleteProject(project.id);
    setDeletingId(null);
  };

  const handleMenuToggle = (e, type, id) => {
    e.stopPropagation();
    if (openMenu && openMenu.type === type && openMenu.id === id) {
      setOpenMenu(null);
    } else {
      // Calculate position for fixed dropdown
      const button = menuButtonRefs.current[`${type}:${id}`];
      if (button) {
        const rect = button.getBoundingClientRect();
        setMenuPosition({
          top: rect.bottom + 4,
          left: rect.right - 140, // 140px is the min-width of dropdown
        });
      }
      setOpenMenu({ type, id });
    }
  };

  const isMenuOpen = (type, id) => !!openMenu && openMenu.type === type && openMenu.id === id;

  // Project chats live under their project; the main list shows the rest
  const visibleChats = useMemo(
    () => chatList.filter(chat => (currentProjectId ? chat.projectId === currentProjectId : !chat.projectId)),
    [chatList, currentProjectId]
  );
  const groupedChats = groupChatsByDate(visibleChats);

  const renderChatGroup = (title, chats) => {
    if (chats.length === 0) return null;

    return (
      <div className="mb-4">
        {!isSidebarCollapsed && (
          <div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </div>
        )}
        <div className="space-y-0.5">
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`
                relative group flex items-center gap-2 px-3 py-2 cursor-pointer
                rounded-lg mx-2 transition-colors duration-150
                ${currentChatId === chat.id
                  ? 'bg-secondary text-foreground'
                  : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'}
                ${deletingId === chat.id ? 'opacity-50' : ''}
              `}
              onClick={() => handleChatClick(chat.id)}
              onMouseEnter={() => setHoveredId(chat.id)}
              onMouseLeave={() => {
                setHoveredId(null);
                if (isMenuOpen('chat', chat.id)) setOpenMenu(null);
              }}
              title={isSidebarCollapsed ? (chat.title || 'New Chat') : undefined}
            >
              <MessageSquare className="h-4 w-4 flex-shrink-0" />

              {!isSidebarCollapsed && (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {chat.title || 'New Chat'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span>{formatRelativeTime(chat.updatedAt)}</span>
                    </div>
                  </div>

                  {/* Action menu */}
                  {(hoveredId === chat.id || isMenuOpen('chat', chat.id)) && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      <button
                        ref={(el) => menuButtonRefs.current[`chat:${chat.id}`] = el}
                        onClick={(e) => handleMenuToggle(e, 'chat', chat.id)}
                        className="p-1 rounded hover:bg-accent/60 transition-colors"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </div>
                  )}

                  {/* Dropdown menu - rendered with fixed position to escape overflow clipping */}
                  {isMenuOpen('chat', chat.id) && (
                    <div
                      className="fixed py-1 glass-card rounded-md min-w-[140px]"
                      style={{
                        top: menuPosition.top,
                        left: menuPosition.left,
                        zIndex: 9999
                      }}
                    >
                      <button
                        onClick={(e) => handleDeleteChat(e, chat.id)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderProjectItem = (project) => {
    const fileCount = project.files?.length || 0;
    const chatCount = chatList.filter(c => c.projectId === project.id).length;
    return (
      <div
        key={project.id}
        className={`
          relative group flex items-center gap-2 px-3 py-2 cursor-pointer
          rounded-lg mx-2 transition-colors duration-150
          hover:bg-muted/50 text-foreground/80 hover:text-foreground
          ${deletingId === project.id ? 'opacity-50' : ''}
        `}
        onClick={() => handleProjectClick(project.id)}
        onMouseEnter={() => setHoveredId(project.id)}
        onMouseLeave={() => {
          setHoveredId(null);
          if (isMenuOpen('project', project.id)) setOpenMenu(null);
        }}
        title={isSidebarCollapsed ? project.name : undefined}
      >
        <Folder className="h-4 w-4 flex-shrink-0 text-primary" />

        {!isSidebarCollapsed && (
          <>
            <div className="flex-1 min-w-0">
              <span className="block truncate text-sm font-medium">{project.name}</span>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>{chatCount} chat{chatCount === 1 ? '' : 's'}</span>
                <span>·</span>
                <span>{fileCount} file{fileCount === 1 ? '' : 's'}</span>
              </div>
            </div>

            {(hoveredId === project.id || isMenuOpen('project', project.id)) && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <button
                  ref={(el) => menuButtonRefs.current[`project:${project.id}`] = el}
                  onClick={(e) => handleMenuToggle(e, 'project', project.id)}
                  className="p-1 rounded hover:bg-accent/60 transition-colors"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </div>
            )}

            {isMenuOpen('project', project.id) && (
              <div
                className="fixed py-1 glass-card rounded-md min-w-[140px]"
                style={{ top: menuPosition.top, left: menuPosition.left, zIndex: 9999 }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setOpenMenu(null); onEditProject?.(project); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/60 transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
                <button
                  onClick={(e) => handleDeleteProject(e, project)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderProjectsSection = () => (
    <div className="mb-4">
      {!isSidebarCollapsed ? (
        <div className="flex items-center justify-between pl-3 pr-2 py-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
          <button
            onClick={onCreateProject}
            className="p-1 rounded hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
            title="New project"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex justify-center py-1">
          <button
            onClick={onCreateProject}
            className="p-1.5 rounded hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
            title="New project"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
      )}
      {projects.length === 0 ? (
        !isSidebarCollapsed && (
          <button
            onClick={onCreateProject}
            className="mx-2 w-[calc(100%-1rem)] text-left px-3 py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
          >
            Create a project to give chats shared instructions and files
          </button>
        )
      ) : (
        <div className="space-y-0.5">
          {projects.map(renderProjectItem)}
        </div>
      )}
    </div>
  );

  const renderProjectHeaderCard = () => {
    if (!currentProject || isSidebarCollapsed) return null;
    const fileCount = currentProject.files?.length || 0;
    const hasInstructions = !!(currentProject.instructions || '').trim();
    return (
      <div className="mx-2 mb-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
        {currentProject.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{currentProject.description}</p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <BookOpen className="h-3 w-3" />
            {hasInstructions ? 'Instructions set' : 'No instructions'}
          </span>
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {fileCount} file{fileCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs flex-1"
            onClick={() => onOpenProjectKnowledge?.(currentProject)}
          >
            <BookOpen className="h-3.5 w-3.5 mr-1" />
            Knowledge
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onEditProject?.(currentProject)}
            title="Edit project"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={sidebarRef}
      className={`
        flex flex-col h-full glass relative
        ${isResizing ? '' : 'transition-all duration-300 ease-in-out'}
      `}
      style={{
        width: isSidebarCollapsed ? COLLAPSED_WIDTH : sidebarWidth,
        minWidth: isSidebarCollapsed ? COLLAPSED_WIDTH : MIN_SIDEBAR_WIDTH,
        maxWidth: isSidebarCollapsed ? COLLAPSED_WIDTH : MAX_SIDEBAR_WIDTH
      }}
    >
      {/* Resize handle - only show when not collapsed */}
      {!isSidebarCollapsed && (
        <div
          className={`
            absolute top-0 right-0 w-1 h-full cursor-col-resize z-10
            hover:bg-primary/30 active:bg-primary/50
            ${isResizing ? 'bg-primary/50' : 'bg-transparent'}
            transition-colors duration-150
          `}
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border gap-1">
        {!isSidebarCollapsed && (
          currentProject ? (
            <div className="flex items-center gap-1 min-w-0 flex-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLeaveProject}
                className="h-7 w-7 flex-shrink-0"
                title="Back to all chats"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <FolderOpen className="h-4 w-4 text-primary flex-shrink-0" />
              <h2 className="font-semibold text-sm truncate" title={currentProject.name}>
                {currentProject.name}
              </h2>
            </div>
          ) : (
            <h2 className="font-semibold text-sm">Chats</h2>
          )
        )}
        <div className={`flex items-center gap-1 ${isSidebarCollapsed ? 'w-full justify-center' : 'flex-shrink-0'}`}>
          {isSidebarCollapsed && currentProject && (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLeaveProject}
              className="h-8 w-8"
              title={`Leave ${currentProject.name}`}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            className="h-8 w-8"
            title={currentProject ? `New chat in ${currentProject.name}` : 'New Chat'}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            className="h-8 w-8"
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isSidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoadingChats ? (
          <div className="flex items-center justify-center py-8">
            <div className="loading-spinner" />
          </div>
        ) : currentProject ? (
          <>
            {renderProjectHeaderCard()}
            {visibleChats.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                {isSidebarCollapsed ? (
                  <MessageSquare className="h-6 w-6 mx-auto opacity-50" />
                ) : (
                  <>
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No chats in this project yet</p>
                    <p className="text-xs mt-1">Send a message to start one</p>
                  </>
                )}
              </div>
            ) : (
              <>
                {renderChatGroup('Today', groupedChats.today)}
                {renderChatGroup('Yesterday', groupedChats.yesterday)}
                {renderChatGroup('This Week', groupedChats.thisWeek)}
                {renderChatGroup('This Month', groupedChats.thisMonth)}
                {renderChatGroup('Older', groupedChats.older)}
              </>
            )}
          </>
        ) : (
          <>
            {renderProjectsSection()}
            {visibleChats.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {isSidebarCollapsed ? (
                  <MessageSquare className="h-6 w-6 mx-auto opacity-50" />
                ) : (
                  <>
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No chats yet</p>
                    <p className="text-xs mt-1">Start a new conversation</p>
                  </>
                )}
              </div>
            ) : (
              <>
                {renderChatGroup('Today', groupedChats.today)}
                {renderChatGroup('Yesterday', groupedChats.yesterday)}
                {renderChatGroup('This Week', groupedChats.thisWeek)}
                {renderChatGroup('This Month', groupedChats.thisMonth)}
                {renderChatGroup('Older', groupedChats.older)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default ChatHistorySidebar;
