import React, { useState, useEffect, useRef } from 'react';
import AnsiToHtml from 'ansi-to-html';

// ANSI colors render as inline styles, so they can't switch with the theme.
// Use mid-tone values that stay legible on bg-muted in both light and dark mode.
const converter = new AnsiToHtml({ newline: true, colors: {
    0: '#6B7280', // black (mid gray so it survives dark surfaces)
    1: '#DC2626', // red
    2: '#16A34A', // green
    3: '#B45309', // yellow (amber, readable on light surfaces)
    4: '#3B82F6', // blue
    5: '#C026D3', // magenta
    6: '#0891B2', // cyan
    7: '#71717A', // white (mid gray so it survives light surfaces)
    8: '#6B7280', // bright black (dark gray)
    9: '#EF4444', // bright red
    10: '#22C55E', // bright green
    11: '#D97706', // bright yellow
    12: '#3B82F6', // bright blue (same as blue for better contrast)
    13: '#D946EF', // bright magenta
    14: '#06B6D4', // bright cyan
    15: '#9CA3AF'  // bright white
}}); // Create a converter instance

// Custom hook for LogViewerModal to separate logic
function useLogViewer(serverId, transportType) {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const logsEndRef = useRef(null);

  // Function to scroll to the bottom of the logs
  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Fetch initial logs or set SSE message
  useEffect(() => {
    if (transportType === 'sse') {
      // For SSE, just display the info message and don't fetch
      setLogs(["[Info: Logs for SSE servers must be checked directly on the server. Stdout/stderr is not captured.]"]);
      setIsLoading(false);
      setError(null);
      return; // Skip fetching and live updates for SSE
    }

    // Proceed with fetching for stdio
    const fetchLogs = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await window.electron.getMcpServerLogs(serverId);
        setLogs(result?.logs || ['No logs available yet.']);
      } catch (err) {
        console.error(`Error fetching logs for ${serverId}:`, err);
        setError(`Failed to load logs: ${err.message}`);
        setLogs([`[Error loading logs: ${err.message}]`]);
      } finally {
        setIsLoading(false);
      }
    };

    if (serverId) {
      fetchLogs();
    } else {
       setLogs(['[No server ID specified]']);
       setIsLoading(false);
    }
  }, [serverId, transportType]);

  // Subscribe to live log updates
  useEffect(() => {
    // Only subscribe for stdio transports
    if (!serverId || transportType === 'sse') {
        return;
    }

    const handleLogUpdate = (updatedServerId, logChunk) => {
      if (updatedServerId === serverId) {
        setLogs(prevLogs => {
           // Append new lines, splitting the chunk if it contains multiple lines
           const newLines = logChunk.split('\n');
           const updated = [...prevLogs, ...newLines];
           // Maintain max lines (optional, main process already limits buffer)
           // const MAX_VIEW_LINES = 1000; // Example limit for frontend display
           // return updated.slice(-MAX_VIEW_LINES);
           return updated;
        });
      }
    };

    // Register listener and get cleanup function
    const removeListener = window.electron.onMcpLogUpdate(handleLogUpdate);

    // Cleanup listener on component unmount or serverId change
    return () => {
      removeListener();
    };
  }, [serverId, transportType]);

  // Scroll to bottom when logs update
  useEffect(() => {
    scrollToBottom();
  }, [logs]); // Trigger scroll whenever logs state changes

  return { logs, isLoading, error };
}

function LogViewerModal({ serverId, transportType, onClose }) {
  const logsEndRef = useRef(null);
  // Pass transportType to the custom hook
  const { logs, isLoading, error } = useLogViewer(serverId, transportType);

  return (
    <div className="fixed inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center z-[60]"> {/* Higher z-index than ToolsPanel */}
      <div className="glass-card w-full max-w-4xl max-h-[90vh] rounded-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border flex justify-between items-center">
          <h2 className="text-lg font-semibold text-foreground">
            Logs for Server: <span className="font-mono text-primary">{serverId}</span>
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close log viewer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Log Content */}
        <div className="flex-1 overflow-y-auto p-4 bg-muted text-sm font-mono">
          {isLoading ? (
            <p className="text-muted-foreground">Loading logs...</p>
          ) : error ? (
             <p className="text-red-600 dark:text-red-400">{error}</p>
          ) : (
            <pre className="text-foreground whitespace-pre-wrap break-words">
              {/* Render each log line processed by ansi-to-html */}
              {logs.map((line, index) => (
                  <div key={index} dangerouslySetInnerHTML={{ __html: converter.toHtml(line) }} />
              ))}
              {/* Invisible element to scroll to */}
              <div ref={logsEndRef} />
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border flex justify-end">
          <button
            onClick={onClose}
            className="py-2 px-4 bg-secondary hover:bg-accent text-secondary-foreground rounded transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default LogViewerModal; 