'use strict';
// Browser test of the built app. Set CHROME_PATH to use an existing browser.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

const waitNodes = (page, n) => page.waitForFunction((v) => document.querySelector('#status').dataset.nodes === String(v), n);
const rowTexts = (page) => page.$$eval('.row:not([hidden])', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
const rowByKey = (page, key) => page.locator('.row:not([hidden])').filter({ has: page.locator('.key', { hasText: new RegExp(`^${key}$`) }) }).first();
const setInput = async (page, text, nodes) => {
  await page.fill('#input', text);
  await waitNodes(page, nodes);
};

async function checkDesktop(browser, url, colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const problems = [];
  const external = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(url) && !r.url().startsWith('data:')) external.push(r.url()); });

  await page.goto(url);
  await page.waitForSelector('.row');
  assert.strictEqual(await page.title(), 'JSON Tree Viewer');
  assert.ok((await rowTexts(page)).some((t) => t.includes('status') && t.includes('"shipped"')), 'sample renders');
  assert.match(await page.textContent('#status'), /Valid/);

  // Expand and collapse.
  await page.click('#btn-collapse');
  assert.strictEqual((await rowTexts(page)).length, 2);
  await rowByKey(page, 'order').locator('.caret').click();
  assert.ok((await rowTexts(page)).some((t) => t.startsWith('status')));
  await page.click('#btn-expand');
  assert.ok((await rowTexts(page)).some((t) => t.includes('Springfield')));

  // Search reveals a value inside collapsed nodes.
  await page.click('#btn-collapse');
  await page.fill('#search', 'springfield');
  await page.waitForFunction(() => document.querySelector('#match-count').textContent === '1/1');
  assert.strictEqual(await page.textContent('#ins-path'), '$.order.customer.address.city');
  assert.strictEqual(await page.textContent('mark'), 'Springfield');
  await page.click('#btn-case');
  await page.waitForFunction(() => document.querySelector('#match-count').textContent === '0');
  await page.click('#btn-case');
  await page.press('#search', 'Escape');
  assert.strictEqual(await page.locator('mark').count(), 0);

  // Paths and copying.
  await rowByKey(page, 'city').click();
  await page.click('#btn-copy-path');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Path copied');
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), '$.order.customer.address.city');
  await page.selectOption('#path-format', 'pointer');
  assert.strictEqual(await page.textContent('#ins-path'), '/order/customer/address/city');
  await page.selectOption('#path-format', 'jqPath');
  assert.strictEqual(await page.textContent('#ins-path'), '.order.customer.address.city');
  await page.selectOption('#path-format', 'jsonPath');
  await page.click('#btn-copy-value');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Value copied');
  assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Springfield');

  // Keyboard navigation.
  await page.focus('#tree');
  await page.keyboard.press('Home');
  assert.strictEqual(await page.textContent('#ins-path'), '$');
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.textContent('#ins-path'), '$.order');
  await page.keyboard.press('ArrowLeft');
  assert.ok(!(await rowTexts(page)).some((t) => t.startsWith('status')), 'left collapses');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await page.textContent('#ins-path'), '$.order.id');
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await page.textContent('#ins-path'), '$.order');
  assert.ok(await page.getAttribute('#tree', 'aria-activedescendant'));

  // Expansion survives edits.
  await page.click('#btn-collapse');
  await rowByKey(page, 'order').locator('.caret').click();
  const edited = (await page.inputValue('#input')).replace('"shipped"', '"returned"');
  await page.fill('#input', edited);
  await page.waitForFunction(() => document.querySelector('.tree-pane').innerText.includes('returned'));
  assert.ok(!(await rowTexts(page)).some((t) => t.includes('Springfield')), 'collapsed nodes stay collapsed');

  // Invalid JSON points at the error.
  await page.fill('#input', '{\n  "a": 1,\n  "b": tru\n}');
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.textContent('#error-msg'), /line 3, column 8/);
  await page.click('#btn-jump');
  await page.waitForFunction(() => document.activeElement.id === 'input' && document.activeElement.selectionStart === 19);

  // Exact numbers and format round trip.
  await setInput(page, '{"big":12345678901234567890,"price":1.10,"z":1,"a":2}', 5);
  await page.click('#btn-format');
  await page.waitForFunction(() => document.querySelector('#input').value.includes('\n'));
  assert.strictEqual(await page.inputValue('#input'), '{\n  "big": 12345678901234567890,\n  "price": 1.10,\n  "z": 1,\n  "a": 2\n}');
  await page.click('#btn-minify');
  assert.strictEqual(await page.inputValue('#input'), '{"big":12345678901234567890,"price":1.10,"z":1,"a":2}');

  // Untrusted text is never treated as HTML.
  const payload = '<img src=x onerror=window.__xss=1>';
  await setInput(page, JSON.stringify({ [payload]: payload, list: [payload] }), 4);
  await page.click('#btn-expand');
  await page.fill('#search', 'img');
  await page.waitForFunction(() => document.querySelector('#match-count').textContent.endsWith('/2'));
  await page.waitForTimeout(100);
  assert.strictEqual(await page.locator('#tree img, #inspector img').count(), 0);
  assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
  await page.press('#search', 'Escape');

  // Duplicate keys are flagged.
  await setInput(page, '{"a":1,"a":2}', 3);
  assert.strictEqual(await page.locator('.row.dup').count(), 1);
  assert.match(await page.textContent('#status'), /1 duplicate key/);

  // Large documents stay virtualized.
  const large = JSON.stringify(Array.from({ length: 100000 }, (_, i) => ({ id: i, name: `item-${i}` })));
  await page.evaluate((text) => {
    const input = document.querySelector('#input');
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }, large);
  await waitNodes(page, 300001);
  await page.click('#btn-expand');
  assert.ok((await page.locator('.row:not([hidden])').count()) < 100, 'rows are virtualized');
  await page.focus('#tree');
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('#ins-path').textContent === '$[99999].name');
  assert.ok((await rowTexts(page)).some((t) => t.includes('item-99999')));
  await page.fill('#search', 'item-77777');
  await page.waitForFunction(() => document.querySelector('#ins-path').textContent === '$[77777].name');
  assert.ok((await rowTexts(page)).some((t) => t.includes('item-77777')));
  await page.press('#search', 'Escape');

  // Work is restored after reload.
  await setInput(page, '{"saved":true}', 2);
  await page.waitForFunction(() => localStorage.getItem('json-tree:input:v1') === '{"saved":true}');
  await page.reload();
  await waitNodes(page, 2);
  assert.strictEqual(await page.inputValue('#input'), '{"saved":true}');

  // Clearing shows the empty state.
  await page.click('#btn-clear');
  await page.waitForSelector('#empty:not([hidden])');
  await page.click('#btn-empty-sample');
  await page.waitForSelector('.row');

  assert.deepStrictEqual(problems, [], 'no console or page errors');
  assert.deepStrictEqual(external, [], 'no external requests');
  await context.close();
}

async function checkGraphAndHeader(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1470, height: 900 }, colorScheme: 'dark', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const problems = [];
  const external = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', (r) => { if (!/^(data:|blob:)/.test(r.url()) && !r.url().startsWith(url)) external.push(r.url()); });
  await page.goto(url);
  await page.waitForSelector('.row');

  const cards = () => page.$eval('#graph', (c) => Number(c.dataset.cards));
  const point = (ptr, part) => page.evaluate(([p, k]) => window.__jsonTreeGraph.point(p, k), [ptr, part]);
  const clickNode = async (ptr, part) => {
    const at = await point(ptr, part);
    await page.mouse.click(at.x, at.y);
  };
  const path = () => page.textContent('#ins-path');
  const waitPath = (p) => page.waitForFunction((v) => document.querySelector('#ins-path').textContent === v, p);
  const camera = () => page.evaluate(() => window.__jsonTreeGraph.camera());

  // Header actions are present, and zoom waits for the graph.
  for (const id of ['btn-import', 'btn-schema', 'btn-stats', 'btn-download', 'btn-zoom-in', 'btn-zoom-out', 'btn-fit', 'btn-theme', 'btn-shortcuts']) {
    assert.ok(await page.isVisible(`#${id}`), `${id} is visible`);
  }
  assert.ok(await page.isDisabled('#btn-zoom-in'), 'zoom is off in tree view');

  // Graph renders real pixels.
  await page.click('#mode-graph');
  await page.waitForFunction(() => Number(document.querySelector('#graph').dataset.cards) > 8);
  assert.ok(!(await page.isVisible('#tree')));
  assert.ok(!(await page.isDisabled('#btn-zoom-in')));
  await page.waitForTimeout(80);
  const initialCamera = await camera();
  await page.click('#btn-fit');
  assert.deepStrictEqual(await camera(), initialCamera, 'the graph fits when first opened');
  const colors = await page.$eval('#graph', (c) => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 64) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size;
  });
  assert.ok(colors > 4, `graph drew content (${colors} colors)`);

  // Selecting a row updates the shared inspector.
  await clickNode('/order/status');
  await waitPath('$.order.status');
  await clickNode('/order/items');
  await waitPath('$.order.items');
  await page.click('#btn-panel');
  assert.ok(!(await page.isVisible('#input')));
  await page.click('#btn-show');
  await page.waitForFunction(() => document.activeElement.id === 'input');
  assert.ok(await page.isVisible('#input'), 'Show in input reopens the editor');

  // Branches collapse and reopen.
  const before = await cards();
  await clickNode('/order/items', 'toggle');
  await page.waitForFunction((n) => Number(document.querySelector('#graph').dataset.cards) < n, before);
  await clickNode('/order/items', 'toggle');
  await page.waitForFunction((n) => Number(document.querySelector('#graph').dataset.cards) === n, before);

  // Search reveals a node in a collapsed branch.
  await page.click('#btn-collapse');
  await page.waitForFunction((n) => Number(document.querySelector('#graph').dataset.cards) < n, before);
  await page.fill('#search', 'springfield');
  await waitPath('$.order.customer.address.city');
  await page.press('#search', 'Escape');

  // Keyboard navigation works on the canvas.
  await page.focus('#graph');
  await page.keyboard.press('Home');
  await waitPath('$');
  await page.keyboard.press('ArrowDown');
  await waitPath('$.order');

  // Pan and zoom.
  await page.click('#btn-expand');
  await page.waitForFunction((n) => Number(document.querySelector('#graph').dataset.cards) === n, before);
  await page.click('#btn-fit');
  await page.waitForTimeout(40);
  const k0 = (await camera()).k;
  await page.click('#btn-zoom-in');
  assert.ok((await camera()).k > k0, 'zoom in');
  await page.click('#btn-zoom-out');
  assert.ok(Math.abs((await camera()).k - k0) < 0.001, 'zoom out');
  const box = await page.locator('#graph').boundingBox();
  const c0 = await camera();
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 72, box.y + 52, { steps: 4 });
  await page.mouse.up();
  const c1 = await camera();
  assert.ok(Math.abs(c1.x - c0.x - 60) < 5 && Math.abs(c1.y - c0.y - 40) < 5, 'drag pans');

  // Downloads.
  let [file] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  assert.strictEqual(file.suggestedFilename(), 'json-graph.png');
  const png = fs.readFileSync(await file.path());
  assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');

  // Schema and stats dialogs.
  await page.click('#btn-schema');
  await page.waitForSelector('#dlg-schema[open]');
  const schema = JSON.parse(await page.textContent('#schema-text'));
  assert.strictEqual(schema.properties.order.properties.total.type, 'number');
  await page.click('#btn-schema-copy');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Schema copied');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dlg-schema:not([open])', { state: 'attached' });
  await page.click('#btn-stats');
  assert.match(await page.textContent('#stats-list'), /Nodes43/);
  await page.click('#dlg-stats [data-close]');

  // Import and shortcuts menus.
  await page.click('#btn-shortcuts');
  assert.ok(await page.isVisible('#menu-shortcuts'));
  await page.keyboard.press('Escape');
  assert.ok(!(await page.isVisible('#menu-shortcuts')));
  await page.click('#btn-import');
  assert.ok(await page.isVisible('#btn-sample'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-open')]);
  await chooser.setFiles({ name: 'upload.json', mimeType: 'application/json', buffer: Buffer.from('{"uploaded":[1,2]}') });
  await waitNodes(page, 4);
  assert.strictEqual(await page.inputValue('#input'), '{"uploaded":[1,2]}');

  // Theme switch persists.
  await page.click('#btn-theme');
  assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status').dataset.nodes === '4');
  assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.strictEqual(await page.getAttribute('#mode-graph', 'aria-pressed'), 'true', 'graph mode is remembered');
  await page.click('#btn-theme');

  // Paging reaches the far end of long arrays.
  await setInput(page, JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => `v${i}`) }), 122);
  await clickNode('/items', 'pager');
  await page.fill('#search', 'v75');
  await waitPath('$.items[75]');
  await page.press('#search', 'Escape');

  // Large documents stay capped and responsive.
  const large = JSON.stringify(Array.from({ length: 50000 }, (_, i) => ({ id: i, tags: ['a', 'b'] })));
  await page.evaluate((text) => {
    const input = document.querySelector('#input');
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }, large);
  await waitNodes(page, 250001);
  await page.waitForFunction(() => Number(document.querySelector('#graph').dataset.cards) > 0);
  assert.ok((await cards()) <= 4100);
  await page.fill('#search', '49999');
  await waitPath('$[49999].id');
  await page.press('#search', 'Escape');

  // Selection carries back to the tree.
  await page.click('#mode-tree');
  assert.ok(await page.isVisible('#tree'));
  assert.strictEqual(await path(), '$[49999].id');
  assert.ok((await rowTexts(page)).some((t) => t.includes('49999')));

  assert.deepStrictEqual(problems, [], 'no console or page errors');
  assert.deepStrictEqual(external, [], 'no external requests');
  await context.close();
}

async function checkMobile(browser, url) {
  const context = await browser.newContext({ viewport: { width: 360, height: 700 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(url);
  await page.waitForSelector('.row');
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(await noOverflow(), 'tree view fits a phone');
  assert.ok(!(await page.isVisible('#input')), 'input is on its own tab');
  await page.tap('#tab-input');
  assert.ok(await page.isVisible('#input'));
  assert.ok(await noOverflow(), 'input view fits a phone');
  await page.tap('#tab-tree');
  await page.waitForSelector('.row');
  assert.ok((await rowTexts(page)).length > 3, 'rows repaint after switching tabs');
  await page.tap('#tab-input');
  await page.tap('#mode-graph');
  await page.waitForFunction(() => Number(document.querySelector('#graph').dataset.cards) > 8);
  assert.ok(await page.isVisible('#graph'), 'graph shows on a phone');
  assert.ok(await noOverflow(), 'graph view fits a phone');
  await page.tap('#btn-shortcuts');
  const menu = await page.locator('#menu-shortcuts').boundingBox();
  assert.ok(menu.x >= 0 && menu.x + menu.width <= 360, 'menu fits a phone');
  await page.tap('#btn-shortcuts');
  assert.deepStrictEqual(problems, []);
  await context.close();
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const scheme of ['dark', 'light']) await checkDesktop(browser, url, scheme);
    await checkGraphAndHeader(browser, url);
    await checkMobile(browser, url);
    console.log('e2e: all browser checks passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
