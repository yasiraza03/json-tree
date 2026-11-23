'use strict';
const test = require('node:test');
const assert = require('node:assert');
const J = require('../src/jsontree.js');

function rng(seed) {
  let s = seed >>> 0;
  return (max) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * max);
  };
}

const find = (doc, ptr) => doc.nodes.find((n) => J.pointer(n) === ptr);

function randomValue(r, depth) {
  const strings = ['', 'a', 'a b', 'é✓', '😀', 'line\nbreak', 'quote"', 'back\\slash', '/', '~', '__proto__', 'constructor', ' ', '\u0001'];
  const kind = r(depth > 4 ? 5 : 7);
  if (kind === 0) return null;
  if (kind === 1) return r(2) === 0;
  if (kind === 2) return r(100000) / 7 - 5000;
  if (kind === 3) return r(1000);
  if (kind === 4) return strings[r(strings.length)];
  if (kind === 5) return Array.from({ length: r(5) }, () => randomValue(r, depth + 1));
  const out = {};
  for (let i = r(5); i > 0; i--) {
    Object.defineProperty(out, strings[r(strings.length)] + (r(3) ? '' : r(9)), {
      value: randomValue(r, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

test('parses every JSON type', () => {
  const doc = J.parse('{"s":"x","n":-1.5e2,"t":true,"f":false,"z":null,"a":[1],"o":{}}');
  assert.deepStrictEqual(doc.root.children.map((c) => c.type), ['string', 'number', 'boolean', 'boolean', 'null', 'array', 'object']);
  assert.strictEqual(doc.stats.nodes, 9);
  assert.strictEqual(doc.stats.maxDepth, 2);
});

test('parses scalar roots and a leading BOM', () => {
  assert.strictEqual(J.parse('42').root.value, '42');
  assert.strictEqual(J.parse(' "x" ').root.value, 'x');
  assert.strictEqual(J.parse('﻿[]').root.type, 'array');
});

test('keeps key order and exact number text', () => {
  const text = '{"b":1,"2":12345678901234567890,"a":1.10,"1":-0,"e":1E+400}';
  const doc = J.parse(text);
  assert.deepStrictEqual(doc.root.children.map((c) => c.key), ['b', '2', 'a', '1', 'e']);
  assert.strictEqual(J.toJSON(doc.root, 0), text);
});

test('decodes string escapes', () => {
  const doc = J.parse(String.raw`"\"\\\/\b\f\n\r\té😀"`);
  assert.strictEqual(doc.root.value, '"\\/\b\f\n\r\té😀');
});

test('reports errors with line and column', () => {
  const cases = [
    ['{\n  "a": 1,\n  "b": tru\n}', 3, 8],
    ['[1, 2,]', 1, 6],
    ['{"a":1,}', 1, 7],
    ['{"a" 1}', 1, 6],
    ['"abc', 1, 1],
    ['[1 2]', 1, 4],
    ['01', 1, 2],
    ['{} x', 1, 4],
    ['', 1, 1],
  ];
  for (const [text, line, column] of cases) {
    assert.throws(() => J.parse(text), (e) => {
      assert.ok(e instanceof J.JsonTreeError, text);
      assert.strictEqual(e.line, line, `${JSON.stringify(text)} line, got ${e.message}`);
      assert.strictEqual(e.column, column, `${JSON.stringify(text)} column, got ${e.message}`);
      return true;
    });
  }
});

test('accepts and rejects exactly what JSON.parse does, with the same values', () => {
  const r = rng(20261123);
  const alphabet = '{}[]",:0123456789-+.eEtruefalsn \n\t\\/u';
  let accepted = 0;
  for (let round = 0; round < 15000; round++) {
    let text = JSON.stringify(randomValue(r, 0), null, r(3));
    for (let m = r(4); m > 0; m--) {
      const at = r(text.length + 1);
      const c = alphabet[r(alphabet.length)];
      const op = r(3);
      text = op === 0 ? text.slice(0, at) + c + text.slice(at)
        : op === 1 ? text.slice(0, at) + text.slice(at + 1)
          : text.slice(0, at) + c + text.slice(at + 1);
    }
    let expected;
    let ok = true;
    try { expected = JSON.parse(text); } catch (_) { ok = false; }
    let doc = null;
    try { doc = J.parse(text); } catch (e) {
      assert.ok(e instanceof J.JsonTreeError, e.stack);
    }
    assert.strictEqual(!!doc, ok, `disagrees with JSON.parse on ${JSON.stringify(text)}`);
    if (ok) {
      accepted++;
      assert.deepStrictEqual(JSON.parse(J.toJSON(doc.root, r(2) * 2)), expected, text);
    }
  }
  assert.ok(accepted > 1000, `only ${accepted} valid samples`);
});

test('handles very deep nesting without recursion', () => {
  const depth = 200000;
  const text = '['.repeat(depth) + ']'.repeat(depth);
  const doc = J.parse(text);
  assert.strictEqual(doc.stats.maxDepth, depth - 1);
  assert.strictEqual(J.toJSON(doc.root, 0), text);
  assert.strictEqual(J.preview(doc.root, 100).truncated, true);
});

test('marks earlier duplicate keys as overridden, like JSON.parse', () => {
  const text = '{"a":1,"b":2,"a":3}';
  const doc = J.parse(text);
  assert.strictEqual(doc.stats.duplicates, 1);
  assert.strictEqual(doc.root.children[0].overridden, true);
  assert.strictEqual(doc.root.children[2].overridden, false);
  assert.deepStrictEqual(JSON.parse(J.toJSON(doc.root)), JSON.parse(text));
});

test('treats __proto__ as a plain key', () => {
  const doc = J.parse('{"__proto__":{"polluted":true}}');
  assert.strictEqual(doc.root.children[0].key, '__proto__');
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(J.toJSON(doc.root, 0), '{"__proto__":{"polluted":true}}');
});

test('builds JSON Pointer, JSONPath and jq paths', () => {
  const doc = J.parse('{"a":{"b c":[{"d/e~f":1}]},"":2,"x\\"y":3}');
  const n = find(doc, '/a/b c/0/d~1e~0f');
  assert.ok(n);
  assert.strictEqual(J.jsonPath(n), '$.a["b c"][0]["d/e~f"]');
  assert.strictEqual(J.jqPath(n), '.a."b c"[0]."d/e~f"');
  assert.strictEqual(J.pointer(doc.root), '');
  assert.strictEqual(J.jsonPath(doc.root), '$');
  assert.strictEqual(J.jqPath(doc.root), '.');
  assert.strictEqual(J.jsonPath(doc.root.children[1]), '$[""]');
  assert.strictEqual(J.jqPath(doc.root.children[2]), '."x\\"y"');
  assert.strictEqual(J.jqPath(J.parse('[[7]]').nodes[2]), '.[0][0]');
});

test('every JSON Pointer resolves back to its value', () => {
  const r = rng(7);
  const resolve = (value, ptr) => ptr.split('/').slice(1)
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((v, t) => v[t], value);
  for (let round = 0; round < 400; round++) {
    const value = randomValue(r, 0);
    const doc = J.parse(JSON.stringify(value));
    for (const node of doc.nodes) {
      assert.deepStrictEqual(JSON.parse(J.toJSON(node)), resolve(value, J.pointer(node)));
    }
  }
});

test('search matches keys and values, with optional case sensitivity', () => {
  const doc = J.parse('{"Name":"alice","other":"ALICE","n":42,"list":[true,null]}');
  const keys = (hits) => hits.map((id) => J.pointer(doc.nodes[id]));
  assert.deepStrictEqual(keys(J.search(doc, 'alice')), ['/Name', '/other']);
  assert.deepStrictEqual(keys(J.search(doc, 'ALICE', { caseSensitive: true })), ['/other']);
  assert.deepStrictEqual(keys(J.search(doc, 'name')), ['/Name']);
  assert.deepStrictEqual(keys(J.search(doc, '42')), ['/n']);
  assert.deepStrictEqual(keys(J.search(doc, 'null')), ['/list/1']);
  assert.deepStrictEqual(J.search(doc, ''), []);
});

test('visible nodes follow the expanded set', () => {
  const doc = J.parse('{"a":{"b":{"c":1}},"d":[1,2]}');
  const ptrs = (set) => J.visibleNodes(doc, set).map((n) => J.pointer(n));
  assert.deepStrictEqual(ptrs(new Set()), ['']);
  assert.deepStrictEqual(ptrs(J.expandToDepth(doc, 1)), ['', '/a', '/d']);
  assert.deepStrictEqual(ptrs(J.expandToDepth(doc, 2)), ['', '/a', '/a/b', '/d', '/d/0', '/d/1']);
  assert.strictEqual(ptrs(J.expandToDepth(doc)).length, doc.nodes.length);
});

test('subtree ranges and source offsets are correct', () => {
  const text = ' {"a": [1, {"b": 2}], "c": "x"} ';
  const doc = J.parse(text);
  for (const node of doc.nodes) {
    const slice = text.slice(node.start, node.end);
    assert.deepStrictEqual(JSON.parse(slice), JSON.parse(J.toJSON(node)));
    if (node.children) {
      const last = node.children.length ? node.children[node.children.length - 1].lastId : node.id;
      assert.strictEqual(node.lastId, last);
    }
  }
});

test('copyText gives raw strings and JSON for everything else', () => {
  const doc = J.parse('{"s":"a\\nb","n":1.10,"o":{"x":1}}');
  assert.strictEqual(J.copyText(doc.root.children[0]), 'a\nb');
  assert.strictEqual(J.copyText(doc.root.children[1]), '1.10');
  assert.strictEqual(J.copyText(doc.root.children[2]), '{\n  "x": 1\n}');
});

test('parses an 800,001-node document', () => {
  const text = '[' + Array.from({ length: 200000 }, (_, i) => `{"id":${i},"ok":true,"v":"x"}`).join(',') + ']';
  const doc = J.parse(text);
  assert.strictEqual(doc.stats.nodes, 800001);
  assert.strictEqual(doc.root.children[199999].children[0].value, '199999');
});
