// Checks of the look-dev model, the cloud volume export and the plate fit, in headless Chromium (WebGPU on SwiftShader).
// usage: node next/test/g5.mjs <outDir> [mesh] [glb=<file>] [volume] [plate]
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
const waitIdle = async () => { await new Promise(r => setTimeout(r, 3000)); for (;;){ const s = await p.evaluate(() => window.__sky.status()); if (s && !s.busy && s.sample >= 1 && s.row === 0) break; await new Promise(r => setTimeout(r, 500)); } };
const saveShot = async nm => { const sh = await p.evaluate(async () => { const m = await window.__sky.shot(); const u8 = m.rgba; let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return {w: m.w, h: m.h, d: btoa(s)}; });
  fs.writeFileSync(path.join(outDir, nm + `_${sh.w}x${sh.h}.rgba`), Buffer.from(sh.d, 'base64')); console.log('shot', nm, sh.w, sh.h); };
for (const c of cases){ const t1 = Date.now();
  if (c === 'mesh' || c.startsWith('glb=')){
    const b64 = c === 'mesh' ? null : fs.readFileSync(c.slice(4)).toString('base64');
    const info = await p.evaluate(async b64 => {
      let f;
      if (b64){ const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); f = new File([u8], 'model.glb'); }
      else { // a torus knot-ish ring of quads, no normals (smooth normals made on load)
        let t = ''; const U = 96, V = 24; for (let i = 0; i < U; i++) for (let j = 0; j < V; j++){ const u = i/U*2*Math.PI, v = j/V*2*Math.PI, R = 1 + 0.35*Math.cos(v);
          t += `v ${R*Math.cos(u)} ${0.35*Math.sin(v) + 0.25*Math.sin(3*u)} ${R*Math.sin(u)}\n`; }
        for (let i = 0; i < U; i++) for (let j = 0; j < V; j++){ const a = i*V + j + 1, b = ((i + 1) % U)*V + j + 1, c2 = ((i + 1) % U)*V + (j + 1) % V + 1, d = i*V + (j + 1) % V + 1; t += `f ${a} ${b} ${c2} ${d}\n`; }
        f = new File([t], 'ring.obj'); }
      window.__sky.set({cuOn: false, sunEl: 25, sunAz: 200, ldMat: 'grey'});
      view.yaw = 200*Math.PI/180 - 0.6; view.pitch = 0.05; await loadModelFile(f); return document.querySelector('#ldInfo').textContent; }, b64);
    console.log(c.slice(0, 20), info); await waitIdle(); await saveShot(c === 'mesh' ? 'mesh_grey' : 'glb');
    if (c === 'mesh'){ await p.evaluate(() => { window.__sky.P.ldMat = 'chrome'; sendView(); }); await new Promise(r => setTimeout(r, 1500)); await saveShot('mesh_chrome'); }
  } else if (c === 'volume'){
    await p.evaluate(() => window.__sky.set({cuOn: true, cuCover: 0.35, sunEl: 30})); await waitIdle();
    const files = await p.evaluate(() => window.__sky.volume(128, 8));
    if (!files) console.log('volume: none', await p.evaluate(() => document.querySelector('#vxInfo').textContent));
    else for (const f of files){ const fp = path.join(outDir, f.name); fs.mkdirSync(path.dirname(fp), {recursive: true}); fs.writeFileSync(fp, Buffer.from(f.b64, 'base64')); console.log('volume file', f.name); }
  } else if (c === 'plate'){
    // a synthetic plate: the clear sky for a known sun and haze, seen through a 70° camera, sRGB at some exposure; then the
    // fit from a wrong start
    const truth = {sunAz: 150, sunEl: 22, aod: 0.3, aerosol: 'urban'};
    const r = await p.evaluate(async truth => {
      window.__sky.set({cuOn: false, scOn: false, acOn: false, ciOn: false, mode: 'manual', ...truth});
      await new Promise(r => setTimeout(r, 2000));
      const arr = await probeSky();
      const vb = document.querySelector('#viewSeg button[data-v="1"]'); vb.click(); view.yaw = 110*Math.PI/180; view.pitch = 0.2;
      const W = 480, H = 270; Object.assign(PLATE, {w: W, h: H, img: {}}); P.plateHfov = 70; plateLayout();
      const cv2 = document.createElement('canvas'); cv2.width = W; cv2.height = H; const ctx = cv2.getContext('2d'), id = ctx.createImageData(W, H), k = 0.5/Math.max(...Array.from(arr).filter((v, i) => i % 3 === 1 && v < 1e6).slice(0, 1e5));
      const enc = c => { c = Math.max(0, Math.min(1, c)); return Math.round(255*(c <= 0.0031308 ? 12.92*c : 1.055*Math.pow(c, 1/2.4) - 0.055)); };
      let kk = 0; for (let y = 0; y < H; y += 9) for (let x = 0; x < W; x += 9){ const d = plateDir(x, y); if (d && d[1] > 2) kk = Math.max(kk, panoAt(arr, d[0], d[1])[1]); }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){ const d = plateDir(x + 0.5, y + 0.5); const c = d ? panoAt(arr, d[0], d[1]) : [0, 0, 0];
        for (let j = 0; j < 3; j++) id.data[4*(y*W + x) + j] = enc(c[j]/kk*0.85); id.data[4*(y*W + x) + 3] = 255; }
      ctx.putImageData(id, 0, 0);
      const blob = await new Promise(r => cv2.toBlob(r, 'image/png'));
      await new Promise(r => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const cx = c.getContext('2d', {willReadFrequently: true}); cx.drawImage(im, 0, 0); Object.assign(PLATE, {img: im, cv: c, ctx: cx, samples: [], sun: null}); $('#plateImg').src = im.src; plateLayout(); r(); }; im.src = URL.createObjectURL(blob); });
      const rv = $('#view').getBoundingClientRect(), pr = plateRect();
      for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.08], [0.9, 0.12], [0.2, 0.45], [0.75, 0.4], [0.5, 0.6], [0.05, 0.7], [0.95, 0.65]])
        plateClick({clientX: rv.left + pr.x + fx*pr.w, clientY: rv.top + pr.y + fy*pr.h, shiftKey: false});
      const n = PLATE.samples.length;
      Object.assign(P, {sunAz: 60, sunEl: 50, aod: 0.08, aerosol: 'continental'});
      await solvePlate();
      return {n, got: {sunAz: P.sunAz, sunEl: P.sunEl, aod: P.aod, aerosol: P.aerosol}, info: $('#plateInfo').textContent, png: await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); })};
    }, truth);
    fs.writeFileSync(path.join(outDir, 'plate.png'), Buffer.from(r.png.split(',')[1], 'base64'));
    console.log('plate: truth', JSON.stringify(truth), 'patches', r.n, 'got', JSON.stringify(r.got), r.info);
  }
  const e2 = await p.evaluate(() => window.__sky.error); if (e2){ console.log('FAILED:', e2); break; }
  console.log(`${c.slice(0, 20)} done in ${((Date.now() - t1)/1000).toFixed(0)} s`); }
await b.close(); srv.close();
