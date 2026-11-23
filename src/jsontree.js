/*!
 * jsontree: a dependency-free JSON tree model.
 * Strict, non-recursive parser that keeps key order and exact number text.
 * Works as a CommonJS module and as window.JsonTree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JsonTree = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ESCAPES = { __proto__: null, '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const HEX4 = /^[0-9a-fA-F]{4}$/;
  const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** Returns the 1-based line and column of a character offset. */
  function locate(text, offset) {
    const end = Math.min(offset, text.length);
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, column: end - lineStart + 1 };
  }

  class JsonTreeError extends Error {
    constructor(message, text, offset) {
      const { line, column } = locate(text, offset);
      super(`${message} (line ${line}, column ${column})`);
      this.name = 'JsonTreeError';
      this.reason = message;
      this.offset = offset;
      this.line = line;
      this.column = column;
    }
  }

  /**
   * Parses JSON into a document: { root, nodes, stats }.
   * `nodes` is in depth-first order, so a node's subtree is ids id..lastId.
   * A number node's `value` is its original source text.
   */
  function parse(text) {
    if (typeof text !== 'string') throw new TypeError('parse() expects a string');
    const n = text.length;
    const nodes = [];
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let cur = null;
    let pendingKey = null;
    let duplicates = 0;

    const fail = (message, at = i) => {
      throw new JsonTreeError(message, text, at);
    };
    const describe = () => (i >= n ? 'end of input' : `'${String.fromCodePoint(text.codePointAt(i))}'`);
    const skipWs = () => {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break;
        i++;
      }
    };

    const readString = () => {
      const open = i;
      let out = '';
      let chunk = ++i;
      for (;;) {
        if (i >= n) fail('Unterminated string', open);
        const c = text.charCodeAt(i);
        if (c === 34) {
          out += text.slice(chunk, i);
          i++;
          return out;
        }
        if (c < 32) fail('Unescaped control character in string');
        if (c !== 92) {
          i++;
          continue;
        }
        out += text.slice(chunk, i);
        const slash = i++;
        if (i >= n) fail('Unterminated string', open);
        const e = text[i];
        if (ESCAPES[e] !== undefined) {
          out += ESCAPES[e];
          i++;
        } else if (e === 'u') {
          const hex = text.slice(i + 1, i + 5);
          if (!HEX4.test(hex)) fail('Invalid \\u escape', slash);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          fail('Invalid escape sequence', slash);
        }
        chunk = i;
      }
    };

    const readKey = () => {
      if (text[i] !== '"') fail(`Expected a quoted key but found ${describe()}`);
      pendingKey = readString();
      skipWs();
      if (text[i] !== ':') fail(`Expected ':' after key but found ${describe()}`);
      i++;
      skipWs();
    };

    const add = (type, start, value) => {
      const isContainer = type === 'object' || type === 'array';
      const index = cur ? cur.children.length : 0;
      const node = {
        id: nodes.length,
        parent: cur,
        key: cur ? (cur.type === 'array' ? index : pendingKey) : null,
        index,
        depth: cur ? cur.depth + 1 : 0,
        type,
        value,
        start,
        end: i,
        lastId: nodes.length,
        children: isContainer ? [] : null,
        overridden: false,
      };
      nodes.push(node);
      if (cur) cur.children.push(node);
      return node;
    };

    const close = (node) => {
      node.end = i;
      node.lastId = nodes.length - 1;
      if (node.type !== 'object' || node.children.length < 2) return;
      const seen = new Map();
      for (const child of node.children) {
        const earlier = seen.get(child.key);
        if (earlier) {
          earlier.overridden = true;
          duplicates++;
        }
        seen.set(child.key, child);
      }
    };

    skipWs();
    for (;;) {
      if (i >= n) fail('Unexpected end of input, expected a value');
      const start = i;
      const ch = text[i];

      if (ch === '{' || ch === '[') {
        const node = add(ch === '{' ? 'object' : 'array', start, null);
        i++;
        skipWs();
        if (text[i] === (ch === '{' ? '}' : ']')) {
          i++;
          close(node);
        } else {
          cur = node;
          if (ch === '{') readKey();
          continue;
        }
      } else if (ch === '"') {
        const value = readString();
        add('string', start, value);
      } else if (text.startsWith('true', i)) {
        i += 4;
        add('boolean', start, true);
      } else if (text.startsWith('false', i)) {
        i += 5;
        add('boolean', start, false);
      } else if (text.startsWith('null', i)) {
        i += 4;
        add('null', start, null);
      } else {
        NUMBER.lastIndex = i;
        const match = NUMBER.exec(text);
        if (!match) fail(`Unexpected ${describe()}, expected a value`);
        i += match[0].length;
        add('number', start, match[0]);
      }

      // A value just ended: consume closers until the next value starts.
      let more = false;
      while (!more) {
        skipWs();
        if (!cur) {
          if (i < n) fail(`Unexpected ${describe()} after the JSON value`);
          const root = nodes[0];
          return { root, nodes, stats: computeStats(nodes, duplicates) };
        }
        const closer = cur.type === 'object' ? '}' : ']';
        const c = text[i];
        if (c === closer) {
          i++;
          const done = cur;
          cur = cur.parent;
          close(done);
        } else if (c === ',') {
          const comma = i++;
          skipWs();
          if (cur.type === 'object') {
            if (text[i] === '}') fail("Trailing comma before '}'", comma);
            readKey();
          } else if (text[i] === ']') {
            fail("Trailing comma before ']'", comma);
          }
          more = true;
        } else {
          fail(`Expected ',' or '${closer}' but found ${describe()}`);
        }
      }
    }
  }

  function computeStats(nodes, duplicates) {
    const stats = { nodes: nodes.length, maxDepth: 0, object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0, duplicates };
    for (const node of nodes) {
      stats[node.type]++;
      if (node.depth > stats.maxDepth) stats.maxDepth = node.depth;
    }
    return stats;
  }

  /** Walks from the root to `node`, returning the nodes after the root. */
  function lineage(node) {
    const out = [];
    for (let x = node; x.parent; x = x.parent) out.push(x);
    return out.reverse();
  }

  const pointerToken = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

  /** RFC 6901 JSON Pointer. The root is the empty string. */
  function pointer(node) {
    return lineage(node).map((x) => '/' + pointerToken(x.key)).join('');
  }

  /** RFC 9535 JSONPath. */
  function jsonPath(node) {
    let out = '$';
    for (const x of lineage(node)) {
      if (typeof x.key === 'number') out += `[${x.key}]`;
      else if (IDENTIFIER.test(x.key)) out += '.' + x.key;
      else out += `[${JSON.stringify(x.key)}]`;
    }
    return out;
  }

  /** A jq filter that selects the node. */
  function jqPath(node) {
    let out = '';
    for (const x of lineage(node)) {
      if (typeof x.key === 'number') out += `[${x.key}]`;
      else if (IDENTIFIER.test(x.key)) out += '.' + x.key;
      else out += `.${JSON.stringify(x.key)}`;
    }
    if (!out) return '.';
    return out[0] === '[' ? '.' + out : out;
  }

  function scalarText(node) {
    if (node.type === 'string' || node.type === 'number') return node.value;
    return String(node.value);
  }

  function serialize(node, indent, limit) {
    const unit = ' '.repeat(indent);
    const nl = indent ? '\n' : '';
    const colon = indent ? ': ' : ':';
    const out = [];
    const stack = [];
    let size = 0;
    let truncated = false;

    const write = (s) => {
      out.push(s);
      size += s.length;
    };
    const scalar = (x) => (x.type === 'string' ? JSON.stringify(x.value) : scalarText(x));
    const emit = (x) => {
      if (!x.children) return write(scalar(x));
      const kids = x.type === 'object' ? x.children.filter((c) => !c.overridden) : x.children;
      const brackets = x.type === 'object' ? '{}' : '[]';
      if (!kids.length) return write(brackets);
      write(brackets[0]);
      stack.push({ x, kids, at: 0, end: brackets[1] });
    };

    emit(node);
    while (stack.length) {
      if (size > limit) {
        truncated = true;
        break;
      }
      const frame = stack[stack.length - 1];
      if (frame.at === frame.kids.length) {
        stack.pop();
        write(nl + unit.repeat(stack.length) + frame.end);
        continue;
      }
      const child = frame.kids[frame.at];
      write((frame.at ? ',' : '') + nl + unit.repeat(stack.length));
      frame.at++;
      if (frame.x.type === 'object') write(JSON.stringify(child.key) + colon);
      emit(child);
    }
    const text = out.join('');
    if (text.length > limit) return { text: text.slice(0, limit), truncated: true };
    return { text, truncated };
  }

  /** Serializes a node, keeping key order and number text. Overridden duplicate keys are dropped. */
  function toJSON(node, indent = 2) {
    return serialize(node, indent, Infinity).text;
  }

  /** Like toJSON, but stops near `limit` characters. Returns { text, truncated }. */
  function preview(node, limit = 20000, indent = 2) {
    return serialize(node, indent, limit);
  }

  /** The value as a person would copy it: raw text for strings, JSON otherwise. */
  function copyText(node) {
    return node.type === 'string' ? node.value : toJSON(node, 2);
  }

  /** Ids of nodes whose key or scalar value contains `query`. */
  function search(doc, query, options = {}) {
    if (!query) return [];
    const caseSensitive = !!options.caseSensitive;
    const needle = caseSensitive ? query : query.toLowerCase();
    const has = (s) => (caseSensitive ? s : s.toLowerCase()).includes(needle);
    const hits = [];
    for (const node of doc.nodes) {
      if ((typeof node.key === 'string' && has(node.key)) || (!node.children && has(scalarText(node)))) {
        hits.push(node.id);
      }
    }
    return hits;
  }

  /** The nodes visible for a set of expanded ids, in display order. */
  function visibleNodes(doc, expanded) {
    const out = [];
    const total = doc.nodes.length;
    let i = 0;
    while (i < total) {
      const node = doc.nodes[i];
      out.push(node);
      i = node.children && !expanded.has(node.id) ? node.lastId + 1 : i + 1;
    }
    return out;
  }

  /** Ids to expand so that `levels` levels below the root are visible. */
  function expandToDepth(doc, levels = Infinity) {
    const expanded = new Set();
    for (const node of doc.nodes) {
      if (node.children && node.children.length && node.depth < levels) expanded.add(node.id);
    }
    return expanded;
  }

  return {
    JsonTreeError,
    parse,
    locate,
    pointer,
    pointerToken,
    jsonPath,
    jqPath,
    scalarText,
    toJSON,
    preview,
    copyText,
    search,
    visibleNodes,
    expandToDepth,
  };
});
