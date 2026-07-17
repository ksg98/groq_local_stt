// Built-in web search tool (Firecrawl / Tavily).
// Exposed to the model as a first-class `web_search` tool without spawning an
// MCP subprocess. Every value (provider, API key, limits, endpoints) comes from
// settings — nothing is hardcoded here beyond public API default base URLs,
// which are themselves overridable via settings.

const { limitContentLength } = require('./utils');

const WEB_SEARCH_SERVER_ID = '__builtin_web_search';
const WEB_SEARCH_TOOL_NAME = 'web_search';

const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com';
const DEFAULT_FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_DUCKDUCKGO_BASE_URL = 'https://html.duckduckgo.com';

function isWebSearchTool(name) {
    return name === WEB_SEARCH_TOOL_NAME;
}

// Which provider is usable given current settings, or null. DuckDuckGo needs no key.
function resolveProvider(settings) {
    if (!settings || !settings.webSearchEnabled) return null;
    const provider = settings.webSearchProvider || 'tavily';
    if (provider === 'duckduckgo') return 'duckduckgo';
    if (provider === 'tavily' && (settings.TAVILY_API_KEY || '').trim()) return 'tavily';
    if (provider === 'firecrawl' && (settings.FIRECRAWL_API_KEY || '').trim()) return 'firecrawl';
    return null;
}

// Returns the built-in tool definitions (same shape as MCP-discovered tools),
// or [] when web search is disabled / unconfigured.
function getWebSearchTools(settings) {
    if (!resolveProvider(settings)) return [];
    return [{
        name: WEB_SEARCH_TOOL_NAME,
        description:
            'Search the live web for current information, news, facts, or documentation. ' +
            'Returns titles, URLs, and content snippets from the top results. ' +
            'Use this whenever the user asks about recent events or anything you are unsure about.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query.' },
                max_results: {
                    type: 'integer',
                    description: 'Maximum number of results to return.',
                    minimum: 1,
                    maximum: 20
                }
            },
            required: ['query']
        },
        serverId: WEB_SEARCH_SERVER_ID
    }];
}

async function searchTavily(query, maxResults, settings) {
    const baseUrl = (settings.webSearchTavilyBaseUrl || DEFAULT_TAVILY_BASE_URL).replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.TAVILY_API_KEY}`
        },
        body: JSON.stringify({
            query,
            max_results: maxResults,
            search_depth: settings.webSearchDepth || 'basic',
            include_answer: settings.webSearchIncludeAnswer ?? true
        })
    });
    if (!resp.ok) {
        throw new Error(`Tavily API error ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const parts = [];
    if (data.answer) parts.push(`Answer: ${data.answer}\n`);
    (data.results || []).forEach((r, i) => {
        parts.push(`${i + 1}. ${r.title || 'Untitled'}\n${r.url || ''}\n${r.content || ''}`);
    });
    return parts.join('\n\n') || 'No results found.';
}

// Minimal HTML entity + tag stripping for the DuckDuckGo HTML endpoint.
function stripHtml(s) {
    return (s || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .trim();
}

// DuckDuckGo wraps result links in a redirect (…/l/?uddg=<encoded>); unwrap it.
function decodeDdgUrl(href) {
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
    if (href.startsWith('//')) return 'https:' + href;
    return href;
}

function parseDuckDuckGoHtml(html, maxResults) {
    const results = [];
    // Match each result link, then grab the snippet that follows it (before the
    // next result link) so alignment survives skipped ads.
    const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/g;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
    let m;
    while ((m = anchorRe.exec(html)) !== null && results.length < maxResults) {
        const rawHref = m[1];
        // Skip sponsored/ad results (DuckDuckGo routes them through /y.js redirects).
        if (/y\.js|ad_provider|ad_domain/.test(rawHref)) continue;
        const url = decodeDdgUrl(rawHref);
        const title = stripHtml(m[2]);
        if (!title || !url || /duckduckgo\.com\/y\.js/.test(url)) continue;
        const sm = snippetRe.exec(m[3] || '');
        results.push({ title, url, snippet: sm ? stripHtml(sm[1]) : '' });
    }
    return results;
}

async function searchDuckDuckGo(query, maxResults, settings) {
    const baseUrl = (settings.webSearchDuckDuckGoBaseUrl || DEFAULT_DUCKDUCKGO_BASE_URL).replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/html/?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html'
        }
    });
    if (!resp.ok) {
        throw new Error(`DuckDuckGo error ${resp.status} (may be rate-limited — try again shortly).`);
    }
    const results = parseDuckDuckGoHtml(await resp.text(), maxResults);
    if (!results.length) return 'No results found.';
    return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}

async function searchFirecrawl(query, maxResults, settings) {
    const baseUrl = (settings.webSearchFirecrawlBaseUrl || DEFAULT_FIRECRAWL_BASE_URL).replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/v1/search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.FIRECRAWL_API_KEY}`
        },
        body: JSON.stringify({ query, limit: maxResults })
    });
    if (!resp.ok) {
        throw new Error(`Firecrawl API error ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const results = data.data || data.results || [];
    const parts = results.map((r, i) =>
        `${i + 1}. ${r.title || 'Untitled'}\n${r.url || ''}\n${r.description || r.markdown || r.content || ''}`
    );
    return parts.join('\n\n') || 'No results found.';
}

// Executes a `web_search` tool call. Returns the same {result|error, tool_call_id}
// shape as toolHandler.handleExecuteToolCall so callers can treat both uniformly.
async function executeWebSearch(toolCall, settings) {
    const toolCallId = toolCall?.id || 'unknown';
    const provider = resolveProvider(settings);
    if (!provider) {
        return { error: 'Web search is not enabled or no API key is configured in Settings.', tool_call_id: toolCallId };
    }

    let args;
    try {
        const raw = toolCall?.function?.arguments;
        args = raw && raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
        return { error: `Failed to parse web_search arguments: ${e.message}`, tool_call_id: toolCallId };
    }

    const query = (args.query || '').trim();
    if (!query) {
        return { error: 'web_search requires a non-empty "query" argument.', tool_call_id: toolCallId };
    }

    const configuredMax = Number(settings.webSearchMaxResults) || 5;
    const maxResults = Math.max(1, Math.min(20, Number(args.max_results) || configuredMax));

    try {
        const text = provider === 'firecrawl'
            ? await searchFirecrawl(query, maxResults, settings)
            : provider === 'duckduckgo'
                ? await searchDuckDuckGo(query, maxResults, settings)
                : await searchTavily(query, maxResults, settings);
        return { result: limitContentLength(text, settings.toolOutputLimit), tool_call_id: toolCallId };
    } catch (error) {
        console.error(`[WebSearch] ${provider} search failed:`, error.message);
        return { error: limitContentLength(`Web search failed: ${error.message}`, settings.toolOutputLimit), tool_call_id: toolCallId };
    }
}

module.exports = {
    WEB_SEARCH_SERVER_ID,
    WEB_SEARCH_TOOL_NAME,
    isWebSearchTool,
    getWebSearchTools,
    executeWebSearch
};
