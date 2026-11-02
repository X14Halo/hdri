// Exports through the page's own writer in headless Chromium (WebGPU on SwiftShader), saved for checking.
// usage: node next/test/export.mjs <outDir> 'name={"W":512,"spp":2,"kind":"image","P":{settings}}' ...
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outDir, ...cases] = process.argv.slice(2); fs.mkdirSync(outDir, {recursive: true});
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f, (e, d) => { if (e){ r.statusCode = 404; r.end(); return; } r.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'application/octet-stream'); r.end(d); }); }).listen(0);
const port = srv.address().port;
const b = await chromium.launch({channel:'chromium', args:['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader']});
const p = await b.newPage({viewport:{width:1400, height:860}}); p.setDefaultTimeout(3600000);
p.on('pageerror', e => console.log('PAGEERROR', e.message)); p.on('console', m => { if (m.text().startsWith('[worker]')) console.log(m.text()); if (m.type() === 'error' && !/TUNNEL|net::|fonts/.test(m.text())) console.log('ERR', m.text().slice(0, 2000)); });
const t0 = Date.now();
await p.goto(`http://localhost:${port}/` + '?p=' + encodeURIComponent(JSON.stringify({noPresent:true, ...(process.env.Q ? JSON.parse(process.env.Q) : {})})));
for (let k = 0; ; k++){ const st = await p.evaluate(() => window.__sky ? [window.__sky.ready(), window.__sky.error || '', document.querySelector('#ldStep').textContent] : [false, '', 'no __sky']);
  if (st[0] || st[1]) break; if (k % 20 === 0) console.log(`  ${((Date.now() - t0)/1000).toFixed(0)} s: ${st[2]}`); await new Promise(r => setTimeout(r, 500)); }
const err = await p.evaluate(() => window.__sky.error); if (err){ console.log('FAILED:', err); await b.close(); srv.close(); process.exit(1); }
console.log(`ready in ${((Date.now() - t0)/1000).toFixed(1)} s`, JSON.stringify(await p.evaluate(() => window.__sky.adapter)));
for (const c of cases){ const i = c.indexOf('='); const nm = c.slice(0, i), o = JSON.parse(c.slice(i + 1)); const t1 = Date.now();
  await p.evaluate(P => window.__sky.set(P), o.P || {}); await new Promise(r => setTimeout(r, 3000));
  for (;;){ const s = await p.evaluate(() => window.__sky.status()); if (s && !s.busy && s.sample >= 1) break; await new Promise(r => setTimeout(r, 500)); }
  const r = await p.evaluate(o => window.__sky.exportTest(o), o);
  const e2 = await p.evaluate(() => window.__sky.error); if (e2){ console.log('FAILED:', e2); break; }
  for (const f of r.files) fs.writeFileSync(path.join(outDir, `${nm}_${f.name}`), Buffer.from(f.b64, 'base64'));
  console.log(`${nm}: ${r.files.map(f => f.name).join(', ')} peak ${r.peak} in ${((Date.now() - t1)/1000).toFixed(0)} s`); }
await b.close(); srv.close();
