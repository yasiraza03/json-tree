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

  /** Finds a node by RFC 6901 JSON Pointer, or returns null. */
  function resolvePointer(doc, ptr) {
    if (ptr === '') return doc.root;
    let cur = doc.root;
    for (const raw of ptr.slice(1).split('/')) {
      if (!cur.children) return null;
      const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      let next = null;
      if (cur.type === 'array') {
        if (/^(?:0|[1-9]\d*)$/.test(token)) next = cur.children[Number(token)] || null;
      } else {
        next = cur.children.find((c) => c.key === token && !c.overridden) || null;
      }
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** Infers a JSON Schema (draft 2020-12) from the document. */
  function inferSchema(doc, options = {}) {
    const maxDepth = options.maxDepth || 64;
    const blank = () => ({ types: new Set(), objects: 0, props: new Map(), items: null });
    const top = blank();
    const stack = [[top, doc.root, 0]];
    while (stack.length) {
      const [summary, node, depth] = stack.pop();
      const type = node.type === 'number' && /^-?\d+$/.test(node.value) ? 'integer' : node.type;
      summary.types.add(type);
      if (!node.children || depth >= maxDepth) {
        if (node.type === 'object') summary.objects++;
        continue;
      }
      if (node.type === 'object') {
        summary.objects++;
        for (const child of node.children) {
          if (child.overridden) continue;
          let entry = summary.props.get(child.key);
          if (!entry) {
            entry = { summary: blank(), count: 0 };
            summary.props.set(child.key, entry);
          }
          entry.count++;
          stack.push([entry.summary, child, depth + 1]);
        }
      } else if (node.children.length) {
        if (!summary.items) summary.items = blank();
        for (const child of node.children) stack.push([summary.items, child, depth + 1]);
      }
    }
    const emit = (s) => {
      const out = {};
      let types = [...s.types];
      if (types.includes('number')) types = types.filter((t) => t !== 'integer');
      if (types.length === 1) out.type = types[0];
      else if (types.length) out.type = types.sort();
      if (s.props.size) {
        out.properties = Object.fromEntries([...s.props].map(([k, e]) => [k, emit(e.summary)]));
        const required = [...s.props].filter(([, e]) => e.count === s.objects).map(([k]) => k);
        if (required.length) out.required = required;
      }
      if (s.items) out.items = emit(s.items);
      return out;
    };
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...emit(top) };
  }

  /* ---------- graph view ---------- */

  const GRAPH = Object.freeze({
    rowH: 17, padX: 13, padY: 10, branchH: 38, pagerH: 30, toggle: 30, gapX: 110, gapY: 18,
    keyChars: 30, valueChars: 44, rowPage: 40, itemPage: 50, maxCards: 4000,
  });

  function shorten(s, max) {
    if (s.length <= max) return s;
    let cut = max - 1;
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    return s.slice(0, cut) + '…';
  }

  function printable(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 32 || c === 127) return JSON.stringify(s).slice(1, -1);
    }
    return s;
  }

  function graphKey(node) {
    if (node.parent === null) return 'root';
    if (typeof node.key === 'number') return String(node.key);
    if (node.key === '') return '""';
    return shorten(printable(node.key.slice(0, GRAPH.keyChars + 1)), GRAPH.keyChars);
  }

  function graphValue(node) {
    if (node.children) {
      const n = node.children.length;
      if (node.type === 'object') return n ? `{${n}}` : '{}';
      return n ? `[${n}]` : '[]';
    }
    const text = node.type === 'string' ? node.value.slice(0, GRAPH.valueChars + 1) : scalarText(node);
    return shorten(printable(text), GRAPH.valueChars);
  }

  /**
   * Builds a positioned left-to-right graph. `closed` holds container ids the user collapsed and
   * `pages` holds each long container's first shown child. `focus` stays visible past maxCards.
   */
  function buildGraph(doc, options = {}) {
    const closed = options.closed || new Set();
    const pages = options.pages || new Map();
    const maxCards = options.maxCards || GRAPH.maxCards;
    const measure = options.measure || ((s) => s.length * 7.5);
    const required = new Set();
    for (let x = options.focus || null; x; x = x.parent) required.add(x.id);
    const cards = [];
    let truncated = false;

    const addCard = (kind, node, parent, parentRow) => {
      const card = {
        index: cards.length, kind, node, parent, parentRow, level: parent ? parent.level + 1 : 0,
        rows: [], children: [], x: 0, y: 0, w: 0, h: 0, span: 0, edgeX: 0, edgeY: 0, label: '', count: '',
      };
      cards.push(card);
      if (parent) parent.children.push(card);
      return card;
    };
    const hasRoom = (node) => {
      if (cards.length < maxCards || required.has(node.id)) return true;
      truncated = true;
      return false;
    };
    const pageStart = (node, size) => {
      const last = Math.floor((node.children.length - 1) / size) * size;
      return Math.max(0, Math.min(pages.get(node.id) || 0, last));
    };
    const pagerRow = (target, start, text) => ({ pager: true, target, start: Math.max(0, start), text, key: null, node: null });
    const valueRow = (node, key) => ({ pager: false, node, key, text: graphValue(node), type: node.type, overridden: node.overridden });

    const addObject = (node, parent, parentRow) => {
      const card = addCard('object', node, parent, parentRow);
      const size = GRAPH.rowPage;
      const start = pageStart(node, size);
      const end = Math.min(node.children.length, start + size);
      if (start) card.rows.push(pagerRow(node, start - size, `↑ ${start} earlier`));
      for (let i = start; i < end; i++) card.rows.push(valueRow(node.children[i], graphKey(node.children[i])));
      if (end < node.children.length) card.rows.push(pagerRow(node, end, `↓ ${node.children.length - end} more`));
      return card;
    };
    const addPager = (target, parent, start, text) => {
      const card = addCard('pager', target, parent, -1);
      card.rows.push(pagerRow(target, start, text));
    };
    const addItem = (item, parent) => {
      if (!hasRoom(item)) return;
      if (item.children && item.children.length) {
        if (item.type === 'object') addObject(item, parent, -1);
        else addCard('branch', item, parent, -1);
        return;
      }
      addCard('value', item, parent, -1).rows.push(valueRow(item, null));
    };

    const root = doc.root;
    if (root.type === 'object' && root.children.length) addObject(root, null, -1);
    else if (root.type === 'array' && root.children.length) addCard('branch', root, null, -1);
    else addCard('value', root, null, -1).rows.push(valueRow(root, null));

    // Breadth-first, so a card limit trims the deepest detail first.
    for (let q = 0; q < cards.length; q++) {
      const card = cards[q];
      if (card.kind === 'object') {
        card.rows.forEach((row, i) => {
          if (row.pager || !row.node.children || !row.node.children.length) return;
          if (hasRoom(row.node)) addCard('branch', row.node, card, i);
        });
      } else if (card.kind === 'branch' && !closed.has(card.node.id)) {
        const node = card.node;
        if (node.type === 'object') {
          if (hasRoom(node.children[0]) || required.has(node.id)) addObject(node, card, -1);
        } else {
          const size = GRAPH.itemPage;
          const start = pageStart(node, size);
          const end = Math.min(node.children.length, start + size);
          if (start) addPager(node, card, start - size, `↑ ${start} earlier`);
          for (let i = start; i < end; i++) addItem(node.children[i], card);
          if (end < node.children.length) addPager(node, card, end, `↓ ${node.children.length - end} more`);
        }
      }
    }

    // Size every card.
    const rowText = (row) => (row.key === null ? row.text : `${row.key}: ${row.text}`);
    for (const c of cards) {
      if (c.kind === 'branch') {
        c.label = graphKey(c.node);
        c.count = graphValue(c.node);
        c.w = Math.ceil(GRAPH.padX * 2 + measure(c.label) + 18 + measure(c.count) + GRAPH.toggle);
        c.h = GRAPH.branchH;
      } else if (c.kind === 'pager') {
        c.w = Math.ceil(GRAPH.padX * 2 + measure(c.rows[0].text));
        c.h = GRAPH.pagerH;
      } else {
        let widest = 0;
        for (const row of c.rows) widest = Math.max(widest, measure(rowText(row)));
        c.w = Math.ceil(Math.max(56, GRAPH.padX * 2 + widest));
        c.h = GRAPH.padY * 2 + c.rows.length * GRAPH.rowH;
      }
    }

    // Columns.
    const levels = [];
    for (const c of cards) (levels[c.level] || (levels[c.level] = [])).push(c);
    const levelW = levels.map((lv) => lv.reduce((w, c) => Math.max(w, c.w), 0));
    const levelX = [];
    let cursor = 0;
    for (let i = 0; i < levels.length; i++) {
      levelX[i] = cursor;
      cursor += levelW[i] + GRAPH.gapX;
    }

    // Subtree heights from the leaves up, then positions from the root down.
    const blockOf = (c) => c.children.reduce((sum, k) => sum + k.span, 0) + Math.max(0, c.children.length - 1) * GRAPH.gapY;
    for (let i = cards.length - 1; i >= 0; i--) cards[i].span = Math.max(cards[i].h, blockOf(cards[i]));
    const tops = new Array(cards.length).fill(0);
    for (const c of cards) {
      const top = tops[c.index];
      c.y = Math.round(top + (c.span - c.h) / 2);
      c.x = levelX[c.level] + (c.kind === 'branch' ? Math.round((levelW[c.level] - c.w) / 2) : 0);
      let at = top + (c.span - blockOf(c)) / 2;
      for (const k of c.children) {
        tops[k.index] = at;
        at += k.span + GRAPH.gapY;
      }
    }
    for (const c of cards) {
      c.children.forEach((k, i) => {
        k.edgeX = c.x + c.w;
        if (k.parentRow >= 0) {
          k.edgeY = c.y + GRAPH.padY + GRAPH.rowH * (k.parentRow + 0.5);
        } else {
          const spread = Math.min(7, (c.h - 14) / Math.max(1, c.children.length));
          k.edgeY = c.y + c.h / 2 + (i - (c.children.length - 1) / 2) * spread;
        }
      });
    }

    // Where each JSON node appears. A branch card wins over its row in the parent.
    const where = new Map();
    for (const c of cards) {
      c.rows.forEach((row, i) => {
        if (row.node) where.set(row.node.id, { card: c, row: i });
      });
      if (c.kind === 'branch' || (c.kind === 'object' && !where.has(c.node.id))) {
        where.set(c.node.id, { card: c, row: -1 });
      }
    }
    const visible = [...where.keys()].sort((a, b) => a - b).map((id) => doc.nodes[id]);

    return {
      cards, levels, levelX, levelW, where, visible, truncated,
      width: Math.max(0, cursor - GRAPH.gapX),
      height: cards[0].span,
    };
  }

  /** Cards that intersect a rectangle in graph coordinates. */
  function graphCardsInView(graph, x0, y0, x1, y1) {
    const out = [];
    graph.levels.forEach((level, i) => {
      if (graph.levelX[i] > x1 || graph.levelX[i] + graph.levelW[i] < x0) return;
      let lo = 0;
      let hi = level.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (level[mid].y + level[mid].h < y0) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < level.length && level[k].y <= y1; k++) {
        if (level[k].x <= x1 && level[k].x + level[k].w >= x0) out.push(level[k]);
      }
    });
    return out;
  }

  /** What is at a point in graph coordinates: { card, node, row, toggle, pager }, or null. */
  function hitGraph(graph, x, y) {
    const [card] = graphCardsInView(graph, x, y, x, y);
    if (!card) return null;
    if (card.kind === 'pager') return { card, node: null, row: 0, toggle: false, pager: card.rows[0] };
    if (card.kind === 'branch') {
      return { card, node: card.node, row: -1, toggle: x >= card.x + card.w - GRAPH.toggle - 4, pager: null };
    }
    const index = Math.floor((y - card.y - GRAPH.padY) / GRAPH.rowH);
    const row = card.rows[index];
    if (!row) return { card, node: card.node, row: -1, toggle: false, pager: null };
    if (row.pager) return { card, node: null, row: index, toggle: false, pager: row };
    return { card, node: row.node, row: index, toggle: false, pager: null };
  }

  return {
    JsonTreeError,
    GRAPH,
    buildGraph,
    graphCardsInView,
    hitGraph,
    inferSchema,
    resolvePointer,
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
