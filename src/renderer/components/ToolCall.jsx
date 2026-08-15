import React, { useState, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { codeTheme, codeBackground } from '../lib/codeTheme';

function ToolCall({ toolCall, toolResult }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setResult(null);
    setError(null);

    if (toolResult) {
      try {
        const parsedResult = JSON.parse(toolResult);
        if (parsedResult.error) {
          setError(parsedResult.error);
        } else {
          setResult(JSON.stringify(parsedResult, null, 2));
        }
      } catch (e) {
        setResult(toolResult);
      }
    }
  }, [toolResult]);

  const formatFunctionName = (name) => {
    if (!name) return '';
    
    const words = name.split('_');
    
    const firstWord = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    const restWords = words.slice(1);
    
    return [firstWord, ...restWords].join(' ');
  };

  if (!toolCall) return null;

  const { function: func, server_label } = toolCall;
  const functionName = func.name;
  const formattedName = formatFunctionName(functionName);
  const isPending = toolResult === null || toolResult === undefined;

  // Arguments stream in token by token, so mid-stream they are an incomplete
  // JSON fragment (`{"`). Show the raw text until it parses instead of treating
  // a partial payload as an error.
  const rawArgs = func.arguments || '';
  let args = null;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch (e) {
    // Only a finished call with unparseable arguments is a real problem.
    if (!isPending) {
      console.error("Failed to parse tool call arguments:", rawArgs, e);
    }
  }
  const displayArgs = args === null ? rawArgs : JSON.stringify(args, null, 2);

  return (
    <div className="tool-call-container w-fit max-w-full">
      <div className="border border-border rounded-lg p-2 shadow-sm">
        <div 
          className="flex justify-between items-center cursor-pointer"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center">
            <span className="bg-primary/10 text-primary text-xs px-2.5 py-0.5 rounded-full mr-2">
              {server_label ? `${server_label}` : 'Tool'}
            </span>
            <span className="text-sm font-normal">{formattedName}</span>
            {isPending && !isExpanded && (
              <svg className="animate-spin ml-2 h-4 w-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            )}
          </div>
          <button className="text-muted-foreground ml-2 hover:text-foreground">
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              className={`h-5 w-5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} 
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-sm font-medium text-foreground mb-1">Arguments:</div>
            <div className="rounded-md text-sm overflow-x-auto">
              <SyntaxHighlighter 
                language="json" 
                style={codeTheme}
                customStyle={{
                  borderRadius: '0.375rem', 
                  margin: 0,
                  padding: '0.5rem',
                  fontSize: '0.8rem',
                  backgroundColor: codeBackground
                }}
                wrapLongLines={true}
              >
                {displayArgs}
              </SyntaxHighlighter>
            </div>

            {isPending && (
              <div className="text-sm flex items-center text-foreground mt-2">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Executing...
              </div>
            )}

            {error && (
              <div className="text-destructive text-sm mt-2 p-2 bg-destructive/10 border border-destructive/30 rounded-md">
                <div className="font-medium mb-1">Error:</div>
                <pre className="whitespace-pre-wrap break-words">{error}</pre>
              </div>
            )}

            {result && !error && (
              <div className="mt-2">
                <div className="text-sm font-medium text-foreground mb-1 flex items-center justify-between">
                  <span>Result:</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {result.length.toLocaleString()} characters
                  </span>
                </div>
                <div className="rounded-md text-sm overflow-x-auto">
                  <SyntaxHighlighter 
                    language="json" 
                    style={codeTheme}
                    customStyle={{
                      borderRadius: '0.375rem', 
                      margin: 0,
                      padding: '0.5rem',
                      fontSize: '0.8rem',
                      backgroundColor: codeBackground
                    }}
                    wrapLongLines={true}
                  >
                    {result}
                  </SyntaxHighlighter>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ToolCall; 