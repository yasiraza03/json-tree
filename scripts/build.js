#!/usr/bin/env node
'use strict';
// Inlines src/jsontree.js into web/template.html and writes one self-contained dist/index.html.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = fs.readFileSync(path.join(root, 'src', 'jsontree.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'web', 'template.html'), 'utf8');
const marker = '/*__JSONTREE__*/';

if (/<\/script/i.test(lib)) throw new Error('library source contains "</script" and cannot be inlined');
if (!template.includes(marker)) throw new Error(`template is missing the ${marker} placeholder`);

// The deploy workflow reads this tag to confirm the live site serves the commit it just shipped.
const sha = process.env.GITHUB_SHA || '';
const build = /^[0-9a-f]{40}$/.test(sha) ? sha : 'local';
const html = template
  .replace(marker, () => lib)
  .replace('<title>', () => `<meta name="build" content="${build}">\n<title>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html written (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
