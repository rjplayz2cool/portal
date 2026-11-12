// Simple web proxy — no dependencies, needs Node 18+
// Run: node server.js   then open http://localhost:3000
const http = require('http');

const PORT = process.env.PORT || 3000;

const HOME = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portal</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
       background:#0f1115;color:#e8e8e8}
  .box{width:min(640px,92vw);text-align:center}
  h1{font-weight:600;letter-spacing:-.5px;margin-bottom:24px}
  form{display:flex;gap:8px}
  input{flex:1;padding:14px 16px;border-radius:12px;border:1px solid #2a2f3a;background:#171a21;
        color:inherit;font-size:16px;outline:none}
  input:focus{border-color:#5b8cff}
  button{padding:14px 20px;border:0;border-radius:12px;background:#5b8cff;color:#fff;font-size:16px;cursor:pointer}
</style></head>
<body><div class="box">
  <h1>Portal</h1>
  <form action="/p" method="get">
    <input name="url" placeholder="Type a URL, e.g. wikipedia.org" autofocus required>
    <button>Go</button>
  </form>
</div></body></html>`;

function toolbar(current) {
  const safe = current.replace(/"/g, '&quot;');
  return `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:6px;
    padding:6px;background:#0f1115;font:14px system-ui,sans-serif">
    <a href="/" style="color:#fff;text-decoration:none;padding:6px 10px">&#8962;</a>
    <form action="/p" method="get" style="flex:1;display:flex;margin:0">
      <input name="url" value="${safe}" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid #2a2f3a;
        background:#171a21;color:#e8e8e8;font-size:14px">
    </form></div><div style="height:44px"></div>`;
}

function normalize(input) {
  input = (input || '').trim();
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input;
  return new URL(input).href;
}

function toProxy(raw, base) {
  if (!raw) return raw;
  const v = raw.trim();
  if (/^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(v)) return raw;
  try {
    return '/p?url=' + encodeURIComponent(new URL(v.replace(/&amp;/g, '&'), base).href);
  } catch { return raw; }
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => `url(${q}${toProxy(u, base)}${q})`)
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => `@import ${q}${toProxy(u, base)}${q}`);
}

function rewriteHtml(html, base) {
  // Normal link/resource attributes
  html = html.replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi,
    (m, attr, q, val) => attr + q + toProxy(val, base) + q);
  // srcset="a.jpg 1x, b.jpg 2x"
  html = html.replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, attr, q, val) =>
    attr + q + val.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [toProxy(u, base), ...rest].join(' ');
    }).join(', ') + q);
  // Inline <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, base) + c);
  // Remove <base> tags and integrity checks (rewritten files won't match their hashes)
  html = html.replace(/<base[^>]*>/gi, '').replace(/\sintegrity\s*=\s*(["']).*?\1/gi, '');
  // Add the address bar
  if (/<body[^>]*>/i.test(html)) html = html.replace(/<body[^>]*>/i, m => m + toolbar(base));
  else html = toolbar(base) + html;
  return html;
}

const DROP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'content-encoding', 'content-length', 'transfer-encoding', 'set-cookie',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'connection', 'keep-alive',
]);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const here = new URL(req.url, 'http://local');

  if (here.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HOME);
  }

  // Pages often request things like "/api/data" directly. Use the Referer to figure out
  // which site they meant and send them back through the proxy.
  if (here.pathname !== '/p') {
    const ref = req.headers.referer;
    try {
      const refTarget = new URL(ref).searchParams.get('url');
      if (refTarget) {
        const fixed = new URL(here.pathname + here.search, refTarget).href;
        res.writeHead(302, { location: '/p?url=' + encodeURIComponent(fixed) });
        return res.end();
      }
    } catch {}
    res.writeHead(404); return res.end('Not found');
  }

  let target;
  try { target = normalize(here.searchParams.get('url')); }
  catch { res.writeHead(400); return res.end('Bad URL'); }

  // Forms that submit with GET add their fields as extra query params — fold them back in.
  if (req.method === 'GET') {
    const extra = [...here.searchParams].filter(([k]) => k !== 'url');
    if (extra.length && here.searchParams.get('url') !== target) {
      const t = new URL(target);
      for (const [k, v] of extra) t.searchParams.append(k, v);
      target = t.href;
    }
  }

  try {
    const headers = {
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'accept': req.headers.accept || '*/*',
      'accept-language': req.headers['accept-language'] || 'en-US,en',
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);

    const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'follow' });
    const finalUrl = upstream.url || target;
    const type = upstream.headers.get('content-type') || '';

    const outHeaders = {};
    upstream.headers.forEach((v, k) => { if (!DROP_HEADERS.has(k)) outHeaders[k] = v; });

    if (type.includes('text/html')) {
      const html = rewriteHtml(await upstream.text(), finalUrl);
      res.writeHead(upstream.status, { ...outHeaders, 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (type.includes('text/css')) {
      const css = rewriteCss(await upstream.text(), finalUrl);
      res.writeHead(upstream.status, { ...outHeaders, 'content-type': 'text/css; charset=utf-8' });
      return res.end(css);
    }
    res.writeHead(upstream.status, outHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Could not load that page: ' + err.message);
  }
});

server.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
