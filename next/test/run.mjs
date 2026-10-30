// Automated renders of the new tool in headless Chromium (WebGPU on SwiftShader).
// usage: node next/test/run.mjs <outPrefix> <samples> 'name={json settings}' ...
// writes <outPrefix><name>_WxH.f32 (linear sRGB, row 0 = top) and <outPrefix><name>.png (the page)
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [pre, spp, ...cases] = process.argv.slice(2);
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
  await p.evaluate(o => { window.__sky.set(o); }, o);
  for (let k = 0; ; k++){ const st = await p.evaluate(n => { const s = window.__sky.status(); return [!!(window.__sky.error || (s && s.sample >= n && s.row === 0 && s.W === (window.__sky.P.previewRes|0))), s ? `${s.W}x${s.H} sample ${s.sample} row ${s.row}` : 'no status']; }, +spp);
    if (st[0]) break; if (k % 40 === 0) console.log(`  ${nm}: ${st[1]}`); await new Promise(r => setTimeout(r, 250)); }
  const e2 = await p.evaluate(() => window.__sky.error); if (e2){ console.log('FAILED:', e2); break; }
  const r = await p.evaluate(async () => { const m = await window.__sky.readback(); const xyz = m.xyz, o = new Float32Array(m.W*m.H*3);
    for (let i = 0; i < m.W*m.H; i++){ const X = xyz[3*i], Y = xyz[3*i + 1], Z = xyz[3*i + 2]; o[3*i] = Math.max(3.2404542*X - 1.5371385*Y - 0.4985314*Z, 0); o[3*i + 1] = Math.max(-0.9692660*X + 1.8760108*Y + 0.0415560*Z, 0); o[3*i + 2] = Math.max(0.0556434*X - 0.2040259*Y + 1.0572252*Z, 0); }
    const u8 = new Uint8Array(o.buffer); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return {W:m.W, H:m.H, d:btoa(s), st:window.__sky.status()}; });
  fs.writeFileSync(`${pre}${nm}_${r.W}x${r.H}.f32`, Buffer.from(r.d, 'base64'));
  const sh = await p.evaluate(async () => { const m = await window.__sky.shot(); if (!m || !m.rgba) return null; const u8 = m.rgba; let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return {w:m.w, h:m.h, d:btoa(s)}; });
  if (sh) fs.writeFileSync(`${pre}${nm}_view_${sh.w}x${sh.h}.rgba`, Buffer.from(sh.d, 'base64'));
  console.log(nm, r.W, r.H, `${((Date.now() - t1)/1000).toFixed(1)} s`, `sample ${r.st.sample}`, `E ${r.st.meter && r.st.meter.E.toFixed(1)} lx`); }
await b.close(); srv.close();
