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
  assert.deepStrictEqual(problems, []);
  await context.close();
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    for (const scheme of ['dark', 'light']) await checkDesktop(browser, url, scheme);
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
