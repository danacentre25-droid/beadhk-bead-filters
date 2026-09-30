// BEAD.hk Refine bar — nightly data build (v2).
// Reads visible products + their 5 filter custom fields from BigCommerce and writes small JSON files
// into ./docs (served by GitHub Pages):
//   docs/index.json      category address -> id (c), id -> exact address (u), JPG landing pages with counts (l)
//   docs/c/<id>.json     products of one category
//   docs/p/<n>.json      product id -> [family category, list page category]  (for product pages)
//
// JPG landing pages (e.g. Gemstone Bracelet) hold no products themselves. Their JPG image map links
// to small code categories (e.g. bb1, b01). This build follows those links and collects all products
// behind a landing page, so the Refine bar can filter them there.
//
// Environment (GitHub → Settings → Secrets and variables → Actions):
//   BC_STORE_HASH  store hash, e.g. vctoi4lzb9
//   BC_TOKEN       token of the "Filter Data Nightly" API account (Products: read-only)

import { mkdir, writeFile, rm } from 'node:fs/promises';

const STORE = process.env.BC_STORE_HASH;
const TOKEN = process.env.BC_TOKEN;
const API = process.env.BC_API_BASE || `https://api.bigcommerce.com/stores/${STORE}/v3`;
const OUT = 'docs';
const FIELDS = ['Bead Size', 'Shape', 'Color', 'Treatment', 'Material'];
const MIN_LIST = 12;      // a landing page needs at least this many products
const MAX_LIST = 10000;   // larger landing pages (e.g. "Shop by 45,000+ Styles") are skipped to keep pages fast

if (!process.env.BC_API_BASE && (!STORE || !TOKEN)) {
  console.error('Missing BC_STORE_HASH or BC_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-Auth-Token': TOKEN || '', Accept: 'application/json' } });
    if (res.status === 429) {
      await sleep(Number(res.headers.get('X-Rate-Limit-Time-Reset-Ms') || 2000) + 200);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`Rate limited too many times: ${path}`);
}

async function getAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await api(`${path}${sep}limit=250&page=${page}`);
    out.push(...(j.data || []));
    const p = j.meta && j.meta.pagination;
    if (!p || page >= p.total_pages) break;
  }
  return out;
}

const normPath = (p) => ('/' + String(p || '').trim()
  .replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '')).toLowerCase();

async function main() {
  // 1) Categories: address + links found in the description (JPG image map <area href="...">)
  const cats = await getAll('/catalog/trees/categories');
  const catPath = {}, pathCat = {}, links = {}, catUrl = {};
  for (const c of cats) {
    if (c.is_visible === false) continue;
    const path = c.url && (c.url.path || c.url.url);
    if (!path) continue;
    catPath[c.category_id] = normPath(path);
    catUrl[c.category_id] = String(path).replace(/^https?:\/\/[^/]+/i, '');
    pathCat[normPath(path)] = c.category_id;
  }
  for (const c of cats) {
    if (!catPath[c.category_id]) continue;
    const found = new Set();
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(c.description || ''))) {
      const target = pathCat[normPath(m[1])];
      if (target && target !== c.category_id) found.add(target);
    }
    if (found.size) links[c.category_id] = [...found];
  }

  // 2) Products
  const products = await getAll(
    '/catalog/products?is_visible=true&include=custom_fields,primary_image' +
    '&include_fields=id,name,price,categories,custom_url,order_quantity_minimum'
  );

  // Row format (keep in sync with the website scripts):
  // [id, name, url, image, price, size, shape, color, treatment, material, priceA, priceB, priceC, minQty]
  const byCat = {};
  for (const p of products) {
    const cf = {};
    for (const f of p.custom_fields || []) cf[f.name] = f.value;
    const img = p.primary_image ? (p.primary_image.url_standard || p.primary_image.url_thumbnail || '') : '';
    const minQty = p.order_quantity_minimum > 0 ? p.order_quantity_minimum : (/bracelet/i.test(p.name) ? 30 : 1);
    const row = [
      p.id,
      p.name,
      (p.custom_url && p.custom_url.url) || '',
      img,
      Number(p.price) || 0,
      cf['Bead Size'] || '',
      cf['Shape'] || '',
      cf['Color'] || '',
      cf['Treatment'] || '',
      cf['Material'] || '',
      cf['Unit Price A'] || '',
      cf['Unit Price B'] || '',
      cf['Unit Price C'] || '',
      minQty
    ];
    for (const cid of p.categories || []) {
      if (!catPath[cid]) continue;
      (byCat[cid] = byCat[cid] || []).push(row);
    }
  }

  // 3) Landing pages: all products behind the JPG links (followed through several levels)
  const landing = {};
  for (const cid of Object.keys(links).map(Number)) {
    const seen = new Set([cid]), stack = [cid], rows = new Map();
    while (stack.length) {
      const cur = stack.pop();
      for (const r of byCat[cur] || []) rows.set(r[0], r);
      for (const next of links[cur] || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    if (rows.size >= MIN_LIST && rows.size <= MAX_LIST) landing[cid] = [...rows.values()];
  }

  // 4) Write files
  await rm(`${OUT}/c`, { recursive: true, force: true });
  await mkdir(`${OUT}/c`, { recursive: true });
  const index = {}, urls = {};
  const lists = { ...byCat, ...landing };
  for (const [cid, rows] of Object.entries(lists)) {
    index[catPath[cid]] = Number(cid);
    urls[cid] = catUrl[cid];
    await writeFile(`${OUT}/c/${cid}.json`, JSON.stringify(rows));
  }

  // Product pages: family = smallest real category; list = smallest landing page that contains the product
  const inLanding = {};
  for (const [cid, rows] of Object.entries(landing)) {
    for (const r of rows) {
      const cur = inLanding[r[0]];
      if (!cur || landing[cur].length > rows.length) inLanding[r[0]] = Number(cid);
    }
  }
  const count = (cid) => (byCat[cid] ? byCat[cid].length : 0);
  const buckets = {};
  for (const p of products) {
    const cs = (p.categories || []).filter((cid) => byCat[cid]);
    if (!cs.length) continue;
    const fam = cs.slice().sort((a, b) => count(a) - count(b))[0];
    const list = inLanding[p.id] || cs.slice().sort((a, b) => count(b) - count(a))[0];
    const b = Math.floor(p.id / 1000);
    (buckets[b] = buckets[b] || {})[p.id] = [fam, list];
  }
  await rm(`${OUT}/p`, { recursive: true, force: true });
  await mkdir(`${OUT}/p`, { recursive: true });
  for (const [b, map] of Object.entries(buckets)) await writeFile(`${OUT}/p/${b}.json`, JSON.stringify(map));

  await writeFile(`${OUT}/index.json`, JSON.stringify({
    updated: new Date().toISOString(), c: index, u: urls,
    l: Object.fromEntries(Object.entries(landing).map(([cid, rows]) => [cid, rows.length]))
  }));
  await writeFile(`${OUT}/.nojekyll`, '');
  console.log(`Done: ${products.length} products, ${Object.keys(index).length} lists, ${Object.keys(landing).length} JPG landing pages.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
