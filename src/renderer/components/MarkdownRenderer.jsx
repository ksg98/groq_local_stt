import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { codeTheme } from '../lib/codeTheme';
import rehypeKatex from 'rehype-katex';
import "katex/dist/katex.min.css";
import MermaidDiagram from './MermaidDiagram';

// Bold the first part of every word ("bionic" reading): the eye lands on the
// bold anchor and completes the rest. Code, math and links' hrefs are left alone.
const WORD_START_RE = /\p{L}[\p{L}\p{N}'’]*/gu;
const BOLD_SKIP_TAGS = new Set(['code', 'pre', 'script', 'style', 'math', 'svg', 'kbd']);
function rehypeBoldWordStarts() {
  const splitText = (node) => {
    const parts = [];
    let last = 0;
    let match;
    WORD_START_RE.lastIndex = 0;
    while ((match = WORD_START_RE.exec(node.value)) !== null) {
      const word = match[0];
      if (match.index > last) parts.push({ type: 'text', value: node.value.slice(last, match.index) });
      const bold = word.length <= 3 ? 1 : Math.ceil(word.length * 0.4);
      parts.push({ type: 'element', tagName: 'b', properties: { className: ['bw'] }, children: [{ type: 'text', value: word.slice(0, bold) }] });
      if (bold < word.length) parts.push({ type: 'text', value: word.slice(bold) });
      last = match.index + word.length;
    }
    if (!parts.length) return null;
    if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
    return parts;
  };
  const visit = (node) => {
    if (!node.children) return;
    if (node.type === 'element') {
      const classes = node.properties?.className || [];
      if (BOLD_SKIP_TAGS.has(node.tagName) || classes.some((c) => String(c).includes('katex'))) return;
    }
    const next = [];
    for (const child of node.children) {
      if (child.type === 'text') {
        const parts = splitText(child);
        if (parts) next.push(...parts);
        else next.push(child);
      } else {
        visit(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree) => visit(tree);
}

const newLineRegex = /\n/;
const newLineAtTheEndRegex = /\n$/;
const codeLanguageRegex = /language-(\w+)/;
const imageFileExtensionsRegex = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;
const components = {
          span: ({ node, children, ...props }) => {
            // Apply word-wrap styles to KaTeX elements to prevent overflow
            if (props.className && props.className.includes('katex')) {
              return (
                <span 
                  {...props} 
                  style={{
                    wordWrap: 'break-word',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-all',
                    ...props.style
                  }}
                >
                  {children}
                </span>
              );
            }
            return <span {...props}>{children}</span>;
          },
          // Custom renderer for code blocks to add syntax highlighting
          code({ node, inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            if (!inline && match && match[1] === 'mermaid') {
              return <MermaidDiagram code={String(children).replace(/\n$/, '')} />;
            }
            return !inline && match ? (
              <SyntaxHighlighter
                style={codeTheme}
                language={match[1]}
                PreTag="div"
                className="rounded-xl"
                customStyle={{ fontSize: '0.875rem' }} // Make code blocks smaller (text-sm equivalent)
                {...props}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          h1: ({ node: _, children, ...props }) => (
            <h1 className="text-xl font-bold mb-4 mt-3" {...props}>
              {children}
            </h1>
          ),
          h2: ({ node: _, children, ...props }) => (
            <h2 className="text-lg font-semibold mb-3 mt-3" {...props}>
              {children}
            </h2>
          ),
          h3: ({ node: _, children, ...props }) => (
            <h3 className="text-base font-medium mb-3 mt-8" {...props}>
              {children}
            </h3>
          ),
          h4: ({ node: _, children, ...props }) => (
            <h4 className="text-sm font-medium mb-2 mt-7" {...props}>
              {children}
            </h4>
          ),
          h5: ({ node: _, children, ...props }) => (
            <h5 className="text-sm font-medium mb-2 mt-7" {...props}>
              {children}
            </h5>
          ),
          h6: ({ node: _, children, ...props }) => (
            <h6 className="text-xs font-medium mb-1 mt-6" {...props}>
              {children}
            </h6>
          ),
          tr: ({ node: _, ...props }) => <tr className="border-b" {...props} />,
          td: ({ node: _, children, ...props }) => {
            return (
              <td
                className="border-r border-border p-2 font-normal first:border-l text-left text-sm"
                {...props}
              >
                {children}
              </td>
            );
          },
          th: ({ node: _, children, ...props }) => {
            return (
              <th
                className="border-r border-border p-2 font-medium first:border-l border-t text-left text-sm"
                {...props}
              >
                {children}
              </th>
            );
          },
          table: ({ node: _, ...props }) => (
            <table className="table-auto w-full mb-1" {...props} />
          ),
          thead: ({ node: _, ...props }) => (
            <thead className="text-left" {...props} />
          ),
          tbody: ({ node: _, ...props }) => <tbody {...props} />,
          ol: ({ node: _, children, ...props }) => {
            return (
              <ol
                className="ml-0 mb-1 list-decimal"
                {...props}
              >
                {children}
              </ol>
            );
          },
          ul: ({ node: _, children, ...props }) => {
            return (
              <ul
                className="ml-0 mb-1 list-disc"
                {...props}
              >
                {children}
              </ul>
            );
          },
          li: ({ node: _, ...props }) => <li className="ml-10 mb-2" {...props} />,
          p({ children, ...props }) {
            return (
              <p className="text-left mb-3 text-sm" {...props}>
                {children}
              </p>
            );
          },
          img({ src, alt, ...props }) {
            // biome-ignore lint/a11y/useAltText: <explanation>
            return <img src={src} alt={alt} {...props} />;
          },
          a({ href, children, ...props }) {
            // Check if the href is an image link
            const isImageLink = href && imageFileExtensionsRegex.test(href);
            if (isImageLink) {
              return (
                <div>
                  <a href={href} {...props} target={"_blank"} rel="noreferrer">
                    {children}
                  </a>
                  <div className="mt-2">
                    <img
                      src={href}
                      alt={`Image at ${href}`}
                      className="max-w-full h-auto"
                    />
                  </div>
                </div>
              );
            }
            // Default link rendering for non-image links
            return (
              <a
                href={href}
                {...props}
                target={"_blank"}
                rel="noreferrer"
                className="text-primary hover:text-primary/80"
              >
                {children}
              </a>
            );
          },
        }
function MarkdownRenderer({ content, disableMath = false, boldWordStarts = false }) {
  // Filter out reference lines like 【4†L24-L30】【4†L32-L35】
  content = content.replace(/【\d+†L\d+-L\d+】/g, '');
  
  // Only process LaTeX if math rendering is enabled
  if (!disableMath) {
    content = content.replace(/\\\[/g, "$$$$\n")
      .replace(/\\\]/g, "\n$$$$")
      .replace(/\\\(/g, "$$")
      .replace(/\\\)/g, "$$")
      .replace(/```latex([\s\S]*?)```/g, "$$$$$1$$$$");
  }

  // Conditionally include math plugins based on disableMath prop
  // Configure remarkMath to only use $$ for display math, not single $ (to avoid conflicts with dollar amounts)
  const remarkPlugins = disableMath ? [remarkGfm] : [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
  const rehypePlugins = disableMath ? [] : [rehypeKatex];
  if (boldWordStarts) rehypePlugins.push(rehypeBoldWordStarts);

  return (
    <div className="markdown-content text-sm">
      <ReactMarkdown
        components={components}
        remarkPlugins={remarkPlugins} // Enable GitHub Flavored Markdown, conditionally enable math
        rehypePlugins={rehypePlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Memoised: the transcript re-renders a few times a second while a reply is
// being read aloud, and parsing markdown each time would be wasted work.
export default React.memo(MarkdownRenderer); 