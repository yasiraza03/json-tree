'use strict';
const test = require('node:test');
const assert = require('node:assert');
const J = require('../src/jsontree.js');

const SAMPLE = JSON.stringify({
  name: 'demo',
  version: '1.0.0',
  private: true,
  authors: [{ name: 'Sam' }, { url: 'https://example.com' }],
  scripts: { dev: 'run dev', build: 'run build' },
  dependencies: { a: '^1.0.0', b: '2.0.0' },
  empty: {},
  list: [],
});

const byPtr = (doc, ptr) => J.resolvePointer(doc, ptr);

function assertNoOverlap(graph) {
  graph.levels.forEach((level) => {
    for (let i = 1; i < level.length; i++) {
      assert.ok(level[i - 1].y + level[i - 1].h <= level[i].y, 'cards in a column must not overlap');
    }
  });
  for (const c of graph.cards) {
    assert.ok(c.x >= 0 && c.y >= -1 && c.w > 0 && c.h > 0);
    assert.ok(c.x + c.w <= graph.width + 1 && c.y + c.h <= graph.height + 1);
    if (c.parent) assert.ok(c.x > c.parent.x + c.parent.w, 'children sit to the right of parents');
  }
}

test('groups scalars into a card and links containers through branch cards', () => {
  const doc = J.parse(SAMPLE);
  const graph = J.buildGraph(doc);
  const root = graph.cards[0];
  assert.strictEqual(root.kind, 'object');
  assert.deepStrictEqual(root.rows.map((r) => `${r.key}: ${r.text}`), [
    'name: demo', 'version: 1.0.0', 'private: true', 'authors: [2]', 'scripts: {2}', 'dependencies: {2}', 'empty: {}', 'list: []',
  ]);
  assert.deepStrictEqual(root.children.map((c) => [c.kind, c.label, c.count]), [
    ['branch', 'authors', '[2]'], ['branch', 'scripts', '{2}'], ['branch', 'dependencies', '{2}'],
  ]);
  const authors = root.children[0];
  assert.deepStrictEqual(authors.children.map((c) => c.kind), ['object', 'object']);
  assert.strictEqual(root.children[1].children[0].rows[0].text, 'run dev');
  assert.strictEqual(graph.where.get(byPtr(doc, '/scripts').id).card, root.children[1]);
  assertNoOverlap(graph);
});

test('edges start at the row of their key', () => {
  const graph = J.buildGraph(J.parse(SAMPLE));
  const root = graph.cards[0];
  const authors = root.children[0];
  assert.strictEqual(authors.parentRow, 3);
  assert.strictEqual(authors.edgeY, root.y + J.GRAPH.padY + J.GRAPH.rowH * 3.5);
  assert.strictEqual(authors.edgeX, root.x + root.w);
});

test('handles array, scalar and empty roots', () => {
  const array = J.buildGraph(J.parse('[1,"x",{"a":1},[2]]'));
  assert.strictEqual(array.cards[0].kind, 'branch');
  assert.deepStrictEqual(array.cards[0].children.map((c) => c.kind), ['value', 'value', 'object', 'branch']);
  assert.strictEqual(J.buildGraph(J.parse('42')).cards[0].rows[0].text, '42');
  assert.strictEqual(J.buildGraph(J.parse('{}')).cards[0].rows[0].text, '{}');
  assert.strictEqual(J.buildGraph(J.parse('[]')).cards[0].rows[0].text, '[]');
});

test('closing a branch hides its subtree', () => {
  const doc = J.parse(SAMPLE);
  const open = J.buildGraph(doc);
  const authors = byPtr(doc, '/authors');
  const shut = J.buildGraph(doc, { closed: new Set([authors.id]) });
  assert.strictEqual(shut.cards.length, open.cards.length - 2);
  assert.ok(shut.where.has(authors.id));
  assert.ok(!shut.where.has(byPtr(doc, '/authors/0/name').id));
});

test('pages long arrays and objects', () => {
  const doc = J.parse(JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => i) }));
  const items = byPtr(doc, '/items');
  const first = J.buildGraph(doc);
  const branch = first.where.get(items.id).card;
  assert.strictEqual(branch.children.length, 51);
  assert.strictEqual(branch.children[50].kind, 'pager');
  assert.strictEqual(branch.children[50].rows[0].start, 50);
  const second = J.buildGraph(doc, { pages: new Map([[items.id, 50]]) });
  assert.strictEqual(second.where.get(items.id).card.children.length, 52);
  assert.ok(second.where.has(byPtr(doc, '/items/75').id));
  assert.ok(!second.where.has(byPtr(doc, '/items/0').id));

  const wide = J.parse(JSON.stringify(Object.fromEntries(Array.from({ length: 95 }, (_, i) => [`k${i}`, i]))));
  const card = J.buildGraph(wide).cards[0];
  assert.strictEqual(card.rows.length, 41);
  assert.strictEqual(card.rows[40].text, '↓ 55 more');
});

test('caps huge documents but keeps the focused node', () => {
  const doc = J.parse(JSON.stringify(Array.from({ length: 40 }, (_, a) => Array.from({ length: 40 }, (_, b) => ({ a, b, c: [1, 2, 3] })))));
  const focus = byPtr(doc, '/39/39/c/2');
  const graph = J.buildGraph(doc, { maxCards: 200, focus });
  assert.ok(graph.truncated);
  assert.ok(graph.cards.length <= 210, `got ${graph.cards.length}`);
  assert.ok(graph.where.has(focus.id));
  assertNoOverlap(graph);
});

test('survives very deep nesting', () => {
  const depth = 100000;
  const doc = J.parse('['.repeat(depth) + ']'.repeat(depth));
  const graph = J.buildGraph(doc);
  assert.ok(graph.truncated);
  assert.strictEqual(graph.cards.length, J.GRAPH.maxCards);
});

test('hit testing finds rows, toggles and empty space', () => {
  const doc = J.parse(SAMPLE);
  const graph = J.buildGraph(doc);
  const root = graph.cards[0];
  const hit = J.hitGraph(graph, root.x + 5, root.y + J.GRAPH.padY + J.GRAPH.rowH * 1.5);
  assert.strictEqual(J.pointer(hit.node), '/version');
  const branch = root.children[0];
  assert.strictEqual(J.hitGraph(graph, branch.x + branch.w - 10, branch.y + 10).toggle, true);
  assert.strictEqual(J.hitGraph(graph, branch.x + 5, branch.y + 10).toggle, false);
  assert.strictEqual(J.hitGraph(graph, -50, -50), null);
});

test('view queries return only intersecting cards', () => {
  const graph = J.buildGraph(J.parse(SAMPLE));
  assert.strictEqual(J.graphCardsInView(graph, -1, -1, graph.width + 1, graph.height + 1).length, graph.cards.length);
  assert.strictEqual(J.graphCardsInView(graph, -100, -100, -50, -50).length, 0);
});

test('shortens long text and escapes control characters', () => {
  const doc = J.parse(JSON.stringify({ text: 'x'.repeat(500), nl: 'a\nb', emoji: '😀'.repeat(60) }));
  const rows = J.buildGraph(doc).cards[0].rows;
  assert.strictEqual(rows[0].text.length, J.GRAPH.valueChars);
  assert.ok(rows[0].text.endsWith('…'));
  assert.strictEqual(rows[1].text, 'a\\nb');
  assert.ok(!/[\ud800-\udbff]…$/.test(rows[2].text), 'never splits a surrogate pair');
});

test('resolves JSON Pointers', () => {
  const doc = J.parse('{"a/b":[{"c~d":1}],"":2,"x":1,"x":3}');
  assert.strictEqual(J.resolvePointer(doc, ''), doc.root);
  assert.strictEqual(J.resolvePointer(doc, '/a~1b/0/c~0d').value, '1');
  assert.strictEqual(J.resolvePointer(doc, '/').value, '2');
  assert.strictEqual(J.resolvePointer(doc, '/x').value, '3');
  assert.strictEqual(J.resolvePointer(doc, '/missing'), null);
  assert.strictEqual(J.resolvePointer(doc, '/a~1b/01'), null);
});

test('infers a JSON Schema', () => {
  const doc = J.parse('{"id":1,"price":1.5,"tags":["a"],"users":[{"name":"x","age":3},{"name":"y","age":null,"__proto__":true}],"mix":[1,2.5]}');
  const schema = J.inferSchema(doc);
  assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.strictEqual(schema.type, 'object');
  assert.deepStrictEqual(schema.required, ['id', 'price', 'tags', 'users', 'mix']);
  assert.strictEqual(schema.properties.id.type, 'integer');
  assert.strictEqual(schema.properties.price.type, 'number');
  assert.deepStrictEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.strictEqual(schema.properties.mix.items.type, 'number');
  const user = schema.properties.users.items;
  assert.deepStrictEqual(user.required, ['name', 'age']);
  assert.deepStrictEqual(user.properties.age.type, ['integer', 'null']);
  assert.ok(Object.keys(user.properties).includes('__proto__'));
  assert.strictEqual({}.polluted, undefined);
});

test('schema inference handles very deep documents', () => {
  const depth = 100000;
  const doc = J.parse('['.repeat(depth) + ']'.repeat(depth));
  assert.doesNotThrow(() => JSON.stringify(J.inferSchema(doc)));
});
