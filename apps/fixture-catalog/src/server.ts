import { createServer } from 'node:http';
import { Cart, PRODUCTS, formatPence } from './catalog.ts';
import { ACTION_MANIFEST, runAction } from './actions.ts';

/**
 * A dependency-free development server for the fixture catalogue. It serves a
 * visible UI (phone and desktop friendly), a small JSON API and the structured
 * action endpoints. One process-wide cart keeps the demo simple; a real app
 * would scope per session.
 */

const cart = new Cart();

function page(): string {
  const rows = PRODUCTS.map(
    (product) => `
      <li class="product" data-sku="${product.id}">
        <span class="name">${product.name}</span>
        <span class="price">${formatPence(product.pricePence)}</span>
        <button data-add="${product.id}">Add</button>
      </li>`
  ).join('');
  const totals = cart.totals();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forge Fixture Catalogue</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem; max-width: 720px; margin-inline: auto; }
  h1 { font-size: 1.4rem; }
  ul { list-style: none; padding: 0; display: grid; gap: .5rem; }
  .product { display: flex; align-items: center; gap: 1rem; padding: .75rem 1rem; border: 1px solid #8883; border-radius: .5rem; }
  .name { flex: 1; }
  .price { font-variant-numeric: tabular-nums; }
  #cart { margin-top: 1.5rem; padding: 1rem; border-radius: .5rem; background: #8881; }
  button { padding: .4rem .8rem; border-radius: .4rem; border: 1px solid #8886; cursor: pointer; }
  @media (max-width: 420px) { body { padding: 1rem; } .product { flex-wrap: wrap; } }
</style></head>
<body>
  <h1>Forge Fixture Catalogue</h1>
  <ul id="catalogue">${rows}</ul>
  <section id="cart" aria-live="polite">
    <strong>Cart:</strong> <span id="count">${totals.itemCount}</span> item(s) ·
    total <span id="total">${formatPence(totals.totalPence)}</span>
  </section>
  <script>
    async function refresh() {
      const res = await fetch('/api/cart');
      const totals = await res.json();
      document.getElementById('count').textContent = totals.itemCount;
      document.getElementById('total').textContent = '£' + (totals.totalPence / 100).toFixed(2);
    }
    document.getElementById('catalogue').addEventListener('click', async (event) => {
      const sku = event.target.getAttribute('data-add');
      if (!sku) return;
      await fetch('/api/cart/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: sku, quantity: 1 }) });
      refresh();
    });
  </script>
</body></html>`;
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/') {
    const html = page();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/products') return json(res, 200, { products: PRODUCTS });
  if (req.method === 'GET' && pathname === '/api/cart') return json(res, 200, cart.totals());
  if (req.method === 'POST' && pathname === '/api/cart/add') {
    const body = await readJson(req);
    const result = runAction(cart, 'add_to_cart', body);
    return json(res, result.ok ? 200 : 400, result);
  }
  // Structured action surface a protected preview would expose.
  if (req.method === 'GET' && pathname === '/__forge/actions') return json(res, 200, ACTION_MANIFEST);
  if (req.method === 'POST' && pathname.startsWith('/__forge/actions/')) {
    const name = decodeURIComponent(pathname.slice('/__forge/actions/'.length));
    const body = await readJson(req);
    const result = runAction(cart, name, body);
    return json(res, result.ok ? 200 : 400, result);
  }
  json(res, 404, { error: 'not found' });
});

const port = Number(process.env.PORT ?? 4321);
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Forge fixture catalogue on http://localhost:${port}`);
});
