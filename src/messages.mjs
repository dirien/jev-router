// What a coding-agent request says about its conversation: which messages a human wrote, what the
// assistant said last, which tools are in use, and which client sent it. Handles Anthropic Messages
// bodies (Claude Code) and OpenAI Responses bodies (Codex CLI).

// Harness text wrapped around or instead of a prompt: reminders, shell-mode input and output, slash
// commands, hook output, notifications. None of it is the user's request.
// Tags seen in Claude Code 2.1.281 and Codex CLI 0.156.1.
const WRAPPER_TAGS = [
  'system-reminder', 'bash-input', 'bash-stdout', 'bash-stderr', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'persisted-output', 'task-notification',
  'teammate-message', 'user-memory-input', 'user-prompt-submit-hook',
  'environment_context', 'user_shell_command', 'turn_aborted', 'user_instructions',
];
const WRAPPERS = new RegExp(`<(${WRAPPER_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');
// Codex sends AGENTS.md as a user message: "# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>…</INSTRUCTIONS>".
const AGENTS_MD = /# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g;
const CODE_FENCE = /```[\s\S]*?(```|$)/g;

export const items = (body) => body.messages ?? (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []);
const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
export const stripWrappers = (text) => text.replace(WRAPPERS, '').replace(AGENTS_MD, '').trim();

// Messages a human wrote: user messages with prose or images and no tool results. `index` points into
// the body's message (or input item) list.
export function humanTurns(body) {
  const turns = [];
  for (const [index, item] of items(body).entries()) {
    if (item?.role !== 'user' || (item.type && item.type !== 'message')) continue;
    const parts = blocks(item.content);
    if (parts.some((part) => part?.type === 'tool_result')) continue;
    const text = stripWrappers(parts.filter((p) => p?.type === 'text' || p?.type === 'input_text').map((p) => p.text ?? '').join('\n'));
    const images = parts.filter((p) => p?.type === 'image' || p?.type === 'input_image').length;
    if (text || images) turns.push({ index, text, images });
  }
  return turns;
}

// The assistant's last prose, without thinking or tool calls.
export function lastAssistantText(body) {
  for (const item of items(body).toReversed()) {
    if (item?.role !== 'assistant') continue;
    const text = blocks(item.content).filter((p) => p?.type === 'text' || p?.type === 'output_text').map((p) => p.text ?? '').join('\n').trim();
    if (text) return text;
  }
  return '';
}

// "Bash 6 times, Edit 3 times" over the most recent tool calls.
export function recentTools(body, last = 20) {
  const names = [];
  for (const item of items(body)) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') names.push(item.name);
    else if (item?.role === 'assistant') for (const part of blocks(item.content)) if (part?.type === 'tool_use') names.push(part.name);
  }
  const counts = new Map();
  for (const name of names.slice(-last)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n} ${n === 1 ? 'time' : 'times'}`).join(', ');
}

export function harness(headers) {
  const agent = headers['user-agent'] ?? '';
  if (agent.startsWith('claude-cli') || headers['x-claude-code-session-id']) return 'Claude Code';
  if (headers.originator?.startsWith('codex') || /codex/i.test(agent)) return 'Codex CLI';
  return 'unknown';
}

// A tier tag counts only as the first or last word of the typed text, outside code blocks, so a
// "#fast" inside a pasted script or log can't switch tiers.
export function tierTag(text, tiers) {
  const typed = text.replace(CODE_FENCE, ' ').trim();
  const names = tiers.map((t) => t.replace(/[^\w-]/g, '')).join('|');
  const match = typed.match(new RegExp(`^#(${names})(?![\\w-])`)) ?? typed.match(new RegExp(`(?:^|\\s)#(${names})[.!?]?$`));
  return match?.[1];
}

// Code blocks become a one-line description: Jev judges the request, not the pasted code, and shell
// snippets in code blocks are what TypeSafe's firewall blocks.
export const describeCode = (text) => text.replace(CODE_FENCE, (block) => {
  const lang = block.match(/^```([\w+-]*)/)?.[1];
  const lines = block.split('\n').length - 2;
  return `[code block${lang ? ` (${lang})` : ''}, ${Math.max(lines, 1)} lines]`;
});

// Keeps the start and the end of a long text. The question usually comes after the pasted material.
export function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return `${text.slice(0, head)} … [${text.length - max} characters omitted] … ${text.slice(-tail)}`;
}
