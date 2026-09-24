// Reads token usage out of an upstream response as it streams past, without changing a byte.
// Understands Anthropic Messages (SSE and JSON) and OpenAI Responses (SSE and JSON).
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export class UsageTap {
  constructor(contentType = '') {
    this.sse = contentType.includes('text/event-stream');
    this.decoder = new TextDecoder();
    this.pending = '';
    this.json = '';
    this.raw = {};
    this.model = undefined;
  }

  push(chunk) {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.json.length < MAX_JSON_BYTES) this.json += text;
      return;
    }
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop();
    for (const line of lines) if (line.startsWith('data:')) this.#event(line.slice(5).trim());
  }

  #event(data) {
    if (!data || data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === 'message_start') {
      this.model = event.message?.model;
      Object.assign(this.raw, event.message?.usage);
    } else if (event.type === 'message_delta') Object.assign(this.raw, event.usage);
    else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      this.model = event.response?.model;
      Object.assign(this.raw, event.response?.usage);
    }
  }

  // { input, cacheRead, cacheWrite, output }, with input counting uncached input tokens only.
  result() {
    if (!this.sse && this.json) {
      try {
        const body = JSON.parse(this.json);
        this.model = body.model;
        Object.assign(this.raw, body.usage);
      } catch {
        /* not JSON, or cut off */
      }
    }
    const u = this.raw;
    if (u.input_tokens === undefined && u.output_tokens === undefined) return undefined;
    const cached = u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
    const responsesApi = u.input_tokens_details !== undefined;
    return {
      input: Math.max(0, (u.input_tokens ?? 0) - (responsesApi ? cached : 0)),
      cacheRead: cached,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
  }
}

// Estimated USD for one request. Prices are per million tokens; unknown models return undefined.
export function costOf(model, usage, prices) {
  if (!usage || !model) return undefined;
  const p = prices[model] ?? prices[model.replace(/-\d{8}$/, '')];
  if (!p) return undefined;
  const usd =
    (usage.input * p.in + usage.cacheRead * (p.cacheRead ?? p.in) + usage.cacheWrite * (p.cacheWrite ?? p.in) + usage.output * p.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
