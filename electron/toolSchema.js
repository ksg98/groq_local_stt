// Shared JSON-Schema sanitizer for tool definitions.
//
// Tool schemas reach us from MCP servers (and our built-in tools) in arbitrary
// shapes. Providers are picky in different ways, so we rebuild each schema from
// a known-safe subset of keywords instead of forwarding it as-is.
//
// Two rules matter in practice:
//   * `additionalProperties: false` must be present on EVERY object node.
//     Groq and OpenAI-compatible endpoints (including the Codex CLI proxy)
//     reject the tool outright without it when strict validation is on.
//   * strict mode additionally requires `required` to list every property.
//     Schemas with optional arguments can't satisfy that, so we only advertise
//     `strict: true` for schemas that already do.

// Non-structural keywords we forward untouched.
const SCALAR_KEYS = ['description', 'enum', 'minimum', 'maximum'];

function sanitizeNode(node) {
    if (!node || typeof node !== 'object') return { type: 'string' };

    const out = {};
    if (node.type) out.type = node.type;
    for (const key of SCALAR_KEYS) {
        if (node[key] !== undefined) out[key] = node[key];
    }

    // Treat anything carrying `properties` as an object even if `type` is absent.
    if (out.type === 'object' || (!out.type && node.properties)) {
        out.type = 'object';
        out.properties = {};
        const source = node.properties && typeof node.properties === 'object' ? node.properties : {};
        for (const [key, value] of Object.entries(source)) {
            out.properties[key] = sanitizeNode(value);
        }
        const known = Object.keys(out.properties);
        const required = Array.isArray(node.required) ? node.required.filter((r) => known.includes(r)) : [];
        if (required.length) out.required = required;
        out.additionalProperties = false;
    } else if (out.type === 'array') {
        // Without `items` the model has no idea what to put in the array.
        out.items = sanitizeNode(node.items);
    }

    return out;
}

// True when every object in the tree lists all of its properties as required —
// the precondition for `strict: true`.
function isStrictSafe(node) {
    if (!node || typeof node !== 'object') return true;
    if (node.type === 'object') {
        const keys = Object.keys(node.properties || {});
        const required = node.required || [];
        if (keys.some((k) => !required.includes(k))) return false;
        return keys.every((k) => isStrictSafe(node.properties[k]));
    }
    if (node.type === 'array') return isStrictSafe(node.items);
    return true;
}

/**
 * @param {object} inputSchema - a tool's raw JSON schema (MCP `input_schema`)
 * @returns {{schema: object, strictSafe: boolean}}
 */
function sanitizeToolSchema(inputSchema) {
    let schema;
    try {
        schema = sanitizeNode(inputSchema && typeof inputSchema === 'object' ? inputSchema : { type: 'object' });
    } catch (e) {
        console.error('[ToolSchema] Failed to sanitize schema:', e);
        schema = { type: 'object', properties: {}, additionalProperties: false };
    }
    if (schema.type !== 'object') {
        schema = { type: 'object', properties: {}, additionalProperties: false };
    }
    return { schema, strictSafe: isStrictSafe(schema) };
}

module.exports = { sanitizeToolSchema };
