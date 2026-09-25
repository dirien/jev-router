// Questions for `jev-router setup`. On a terminal, a secret is typed in raw mode and never echoed;
// from a pipe, every answer is one line. One reader serves every question, so lines that arrive
// together, as piped answers do, aren't lost between questions.

/** Ends a run of questions: the person pressed Ctrl-C (exit code 130), or the input ended (1). */
export class PromptAbort extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   */
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * @typedef {object} Keys
 * @property {string} value the secret so far
 * @property {string} rest input after Enter, left for the next question
 * @property {boolean} done Enter was pressed
 * @property {number} [abort] 130 for Ctrl-C, 1 for Ctrl-D on an empty line
 */

/**
 * Applies what a terminal in raw mode sent to a secret being typed: Enter ends it, Backspace
 * removes the last character, Ctrl-U clears it, Ctrl-C aborts, Ctrl-D aborts an empty line and ends
 * another, and escape sequences (arrow keys, bracketed paste marks) and other control characters are
 * dropped. A paste arrives as one chunk and is taken in one piece.
 * @param {string} value the secret so far
 * @param {string} input what arrived
 * @returns {Keys}
 */
export function typeKeys(value, input) {
  let typed = value;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '\r' || char === '\n') {
      const next = char === '\r' && input[i + 1] === '\n' ? i + 2 : i + 1;
      return { value: typed, rest: input.slice(next), done: true };
    }
    if (char === '\u0003') return { value: '', rest: '', done: true, abort: 130 };
    if (char === '\u0004')
      return typed ? { value: typed, rest: input.slice(i + 1), done: true } : { value: '', rest: '', done: true, abort: 1 };
    if (char === '\u007f' || char === '\b') typed = Array.from(typed).slice(0, -1).join('');
    else if (char === '\u0015') typed = '';
    else if (char === '\u001b') i += escapeLength(input, i) - 1;
    else if (char >= ' ') typed += char;
  }
  return { value: typed, rest: '', done: false };
}

/**
 * How long the escape sequence at `start` is: CSI (ESC [ … final byte), SS3 (ESC O and one), or ESC alone.
 * @param {string} input
 * @param {number} start
 */
function escapeLength(input, start) {
  const next = input[start + 1];
  if (next === 'O') return Math.min(3, input.length - start);
  if (next !== '[') return 1;
  const end = input.slice(start + 2).search(/[@-~]/);
  return end < 0 ? input.length - start : end + 3;
}

/** Asks questions on `input` and writes them to `output`. */
export class Prompter {
  #input;
  #output;
  #buffer = '';
  #ended = false;
  #listening = false;
  /** @type {PromptAbort | undefined} */
  #aborted;
  /** @type {() => void} */
  #wake = () => undefined;
  /** @param {string} chunk */
  #onData = (chunk) => {
    this.#buffer += chunk;
    this.#wake();
  };
  #onEnd = () => {
    this.#ended = true;
    this.#wake();
  };

  /**
   * @param {NodeJS.ReadStream} input
   * @param {NodeJS.WritableStream} output
   */
  constructor(input, output) {
    this.#input = input;
    this.#output = output;
  }

  /** Whether a person types the answers, rather than a pipe sending them. */
  get terminal() {
    return Boolean(this.#input.isTTY);
  }

  /**
   * Prints text for the person answering.
   * @param {string} text
   */
  say(text) {
    this.#output.write(text);
  }

  /**
   * Asks a question and waits for one line.
   * @param {string} question
   * @returns {Promise<string>} the answer, trimmed
   */
  async ask(question) {
    this.#output.write(question);
    const answer = (await this.#line()).trim();
    if (!this.terminal) this.#output.write(`${answer}\n`); // a terminal has echoed it already
    return answer;
  }

  /**
   * Asks for a secret. A terminal doesn't show it; nothing here ever prints it.
   * @param {string} question
   * @returns {Promise<string>} the secret, trimmed
   */
  async secret(question) {
    this.#output.write(question);
    const value = this.terminal ? await this.#hidden() : await this.#line();
    this.#output.write('\n');
    return value.trim();
  }

  /**
   * Asks a yes-or-no question until it gets an answer; Enter takes the default.
   * @param {string} question
   * @param {boolean} yes the default
   * @returns {Promise<boolean>}
   */
  async confirm(question, yes) {
    for (;;) {
      const answer = (await this.ask(`${question} ${yes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
      if (!answer) return yes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      this.#output.write('Please answer y or n.\n');
    }
  }

  /** Makes the question being asked, and every later one, fail with exit code 130: Ctrl-C outside raw mode. */
  interrupt() {
    this.#aborted = new PromptAbort('interrupted', 130);
    this.#wake();
  }

  /** Stops reading, so the process can exit. */
  close() {
    if (!this.#listening) return;
    this.#listening = false;
    this.#input.off('data', this.#onData);
    this.#input.off('end', this.#onEnd);
    this.#input.pause();
  }

  #listen() {
    if (this.#listening) return;
    this.#listening = true;
    this.#input.setEncoding('utf8');
    this.#input.on('data', this.#onData);
    this.#input.on('end', this.#onEnd);
    this.#input.resume();
  }

  /** Waits until more input arrives, the input ends, or the questions are interrupted. */
  async #more() {
    if (!this.#aborted && !this.#ended)
      await new Promise((resolve) => {
        this.#wake = () => resolve(undefined);
      });
    this.#wake = () => undefined;
    if (this.#aborted) throw this.#aborted;
  }

  /** @returns {Promise<string>} the next line, without its line break */
  async #line() {
    this.#listen();
    for (;;) {
      if (this.#aborted) throw this.#aborted;
      const newline = this.#buffer.indexOf('\n');
      if (newline >= 0 || (this.#ended && this.#buffer)) {
        const end = newline >= 0 ? newline : this.#buffer.length;
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        return line.replace(/\r$/, '');
      }
      if (this.#ended) throw new PromptAbort('the input ended', 1);
      await this.#more();
    }
  }

  /** @returns {Promise<string>} a secret typed on the terminal in raw mode */
  async #hidden() {
    const input = /** @type {import('node:tty').ReadStream} */ (this.#input);
    this.#listen();
    input.setRawMode(true);
    try {
      let value = '';
      for (;;) {
        const keys = typeKeys(value, this.#buffer);
        this.#buffer = keys.rest;
        value = keys.value;
        if (keys.abort) throw new PromptAbort(keys.abort === 130 ? 'interrupted' : 'the input ended', keys.abort);
        if (keys.done) return value;
        if (this.#ended) throw new PromptAbort('the input ended', 1);
        await this.#more();
      }
    } finally {
      input.setRawMode(false);
    }
  }
}
