# JSON Tree Viewer

[![Live demo](https://img.shields.io/badge/Live%20demo-Open%20the%20app-2ea44f?style=for-the-badge)](https://yasiraza03.github.io/json-tree/)
[![Test and deploy](https://github.com/yasiraza03/json-tree/actions/workflows/deploy.yml/badge.svg)](https://github.com/yasiraza03/json-tree/actions/workflows/deploy.yml)

**Try it in your browser: <https://yasiraza03.github.io/json-tree/>**

Paste or open a JSON file and explore it as a fast, searchable tree. The app is a single HTML file with no runtime dependencies. Your data stays in your browser, and the page's security policy blocks it from making network requests.

## Features

- **Handles large files.** Only the visible rows are rendered, so documents with hundreds of thousands of nodes stay responsive.
- **Search keys and values.** Matches inside collapsed branches are revealed, with next/previous and a match-case option.
- **Copy paths.** Get any node's path as JSONPath, JSON Pointer or a jq filter, or copy its value.
- **Keeps your data exact.** Key order and number text are preserved, so `1.10` and `12345678901234567890` stay unchanged, even after Format or Minify.
- **Clear errors.** Invalid JSON is reported with its line and column, and one click jumps to the problem.
- **Flags duplicate keys.** Overridden keys are marked in the tree.
- **Works everywhere.** Includes full keyboard navigation, light and dark themes, a phone layout, and file drag and drop.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `Enter` / `Shift+Enter` in search | Next / previous match |
| `Esc` in search | Clear search |
| `↑` `↓` `PageUp` `PageDown` `Home` `End` | Move through the tree |
| `→` / `←` | Expand or enter / collapse or go to parent |
| `Enter` or `Space` | Toggle the selected node |

In the input box, `Tab` inserts two spaces. Press `Esc` first to move focus out with `Tab`.

## Run it locally

```bash
npm install
npm run build        # writes dist/index.html
npm test             # parser, path and tree tests
npx playwright install chromium
npm run test:e2e     # builds, then tests the app in a real browser
```

Open `dist/index.html` in a browser to use the local build.

## Use the library

`src/jsontree.js` works in Node and in browsers (as `window.JsonTree`).

```js
const J = require('./src/jsontree.js');

const doc = J.parse('{"users":[{"name":"Sam"}]}');
const id = J.search(doc, 'Sam')[0];
const node = doc.nodes[id];

J.jsonPath(node);        // $.users[0].name
J.pointer(node);         // /users/0/name
J.jqPath(node);          // .users[0].name
J.toJSON(doc.root, 2);   // formatted JSON with key order and numbers preserved
```

## Deployment

Every push to `main` runs [the workflow](.github/workflows/deploy.yml), which:

1. runs the unit and browser tests,
2. builds the site and deploys it to GitHub Pages, and
3. checks that the live site is serving the new commit.

If the tests fail, nothing is deployed. Pull requests run the tests only.

## License

[MIT](LICENSE)
