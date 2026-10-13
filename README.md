# Budget

Phone-first monthly budget. Static page on GitHub Pages; data lives in a private Google Sheet behind
an Apps Script JSON endpoint that answers only with the key.

- `index.html` – markup + styles. `app.js` – cache-first render, optimistic writes, sync queue.
- `model.js` – pure month math (also runs in node). `node tests/model.test.js`
- `?mock=1` – invented demo data, no network.

No financial data is ever committed here.
