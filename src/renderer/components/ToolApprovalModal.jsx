import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { codeTheme, codeBackground } from '../lib/codeTheme';

function ToolApprovalModal({ toolCall, onApprove }) {
  if (!toolCall) return null;

  // Handle both local tool calls and remote MCP approval requests
  // Local tool calls have: { function: { name, arguments }, id, ... }
  // MCP approval requests have: { name, arguments, id, server_label, type: 'mcp_approval_request' }
  const isMcpApprovalRequest = toolCall.type === 'mcp_approval_request';
  
  let toolName;
  let args = {};
  let serverLabel = null;

  if (isMcpApprovalRequest) {
    // Remote MCP approval request format
    toolName = toolCall.name;
    serverLabel = toolCall.server_label;
    try {
      const argsString = toolCall.arguments ?? '{}';
      args = typeof argsString === 'string' ? JSON.parse(argsString) : argsString;
    } catch (e) {
      console.error("Failed to parse MCP approval request arguments:", toolCall.arguments, e);
      args = { parse_error: "Could not parse arguments", original_arguments: toolCall.arguments };
    }
  } else {
    // Local tool call format
    const { function: func } = toolCall;
    toolName = func.name;
    try {
      const argsString = func.arguments ?? '{}';
      args = JSON.parse(argsString);
    } catch (e) {
      console.error("Failed to parse tool call arguments for modal:", toolCall.function?.arguments, e);
      args = { parse_error: "Could not parse arguments", original_arguments: toolCall.function?.arguments };
    }
  }

  const handleChoice = (choice) => {
    if (onApprove) {
      onApprove(choice, toolCall);
    }
  };

  // Risk-level colors are semantic (blue/green/yellow); text is literal white
  // on those fills, not the primary-foreground token
  const baseButtonClass = "w-full sm:w-auto px-4 py-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition duration-150 ease-in-out text-sm font-medium text-white";
  const buttonClasses = {
    once:   `bg-blue-700 hover:bg-blue-800 ${baseButtonClass}`,
    always: `bg-green-700 hover:bg-green-800 ${baseButtonClass}`,
    yolo:   `bg-yellow-700 hover:bg-yellow-800 ${baseButtonClass}`,
    deny:   `bg-destructive hover:bg-destructive/90 ${baseButtonClass}`,
  };

  return (
    <div className="fixed inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="glass-card w-full max-w-xl rounded-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {isMcpApprovalRequest ? 'Remote Tool Approval Required' : 'Tool Call Approval Required'}
          </h2>
          {isMcpApprovalRequest && serverLabel && (
            <p className="text-sm text-muted-foreground mt-1 ml-7">
              Server: <span className="text-primary">{serverLabel}</span>
            </p>
          )}
        </div>

        <div className="p-5 overflow-y-auto max-h-[60vh] space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">Tool Name:</label>
            <div className="bg-muted p-3 rounded text-foreground font-mono text-sm border border-border">
              {toolName}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wider">Arguments:</label>
            <div className="rounded-md text-sm overflow-x-auto border border-border">
              <SyntaxHighlighter
                language="json"
                style={codeTheme}
                customStyle={{
                  borderRadius: '0.3rem',
                  margin: 0,
                  padding: '0.75rem',
                  fontSize: '0.875rem',
                  backgroundColor: codeBackground
                }}
                codeTagProps={{ style: { fontFamily: "'Fira Code', monospace" } }}
                wrapLongLines={true}
              >
                {JSON.stringify(args, null, 2)}
              </SyntaxHighlighter>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-border bg-muted/30 flex flex-wrap gap-3 justify-end">
           <button
            onClick={() => handleChoice('once')}
            className={buttonClasses.once}
          >
            Allow Once
          </button>
          <button
            onClick={() => handleChoice('always')}
            className={buttonClasses.always}
          >
            Always Allow This Tool
          </button>
           <button
            onClick={() => handleChoice('yolo')}
            title="Always Allow Any Tool (Warning: potential security risk from prompt injection)"
            className={buttonClasses.yolo}
          >
            YOLO Mode
          </button>
          <button
            onClick={() => handleChoice('deny')}
            className={buttonClasses.deny}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

export default ToolApprovalModal;
