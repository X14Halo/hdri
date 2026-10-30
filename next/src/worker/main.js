// Spectral Sky Next — render worker: owns the GPU (WebGPU) and the canvas; the UI thread only sends settings and view.
// The panorama is rendered progressively in bands of rows, a few milliseconds of GPU work per frame, so the page never stalls.
'use strict';
let device = null, gctx = null, canvasFmt = 'bgra8unorm', canvas = null;
const R = {};             // GPU resources
const S = {                // render state
  P: null, view: {mode:0, yaw:0, pitch:0, fov:75*D2R, expoComp:0, auto:true, cw:1, ch:1},
  frame: null, atmKey: '', paramsDirty: false, W: 0, H: 0, sample: 0, row: 0, rows: 16, target: 64,
  inFlight: 0, meter: {E:1, Ed:0, Esky:0}, derived: null, t0: 0, sampleT: 0, lastStatus: 0, error: null,
};
const post = (m, tr) => self.postMessage(m, tr || []);
function fail(msg){ S.error = msg; post({type:'error', message:String(msg)}); }

const glArr = (a, digits=2) => `array<vec4f, ${a.length}>(${a.map(m => `vec4f(${m.map(v => (+v).toFixed(digits)).join(', ')})`).join(', ')})`;
function wgsl(...parts){
  let s = parts.map(p => WGSL[p]).join('\n');
  s = s.replace('/*@MARIA*/', glArr(MARIA)).replace('/*@CRATERS*/', glArr(CRATERS)).replace('/*@RAYS*/', glArr(RAYS))
       .replace(/arrayLength_MARIA/g, String(MARIA.length)).replace(/arrayLength_CRATERS/g, String(CRATERS.length)).replace(/arrayLength_RAYS/g, String(RAYS.length));
  return s;
}
async function module(label, code){
  const m = device.createShaderModule({label, code});
  const info = await m.getCompilationInfo();
  const errs = info.messages.filter(x => x.type === 'error');
  if (errs.length){ const lines = code.split('\n'); throw new Error(`${label}: ` + errs.map(e => `line ${e.lineNum}: ${e.message}\n  ${lines[e.lineNum - 1] || ''}`).join('\n')); }
  return m;
}
// explicit bind group layouts, from the shader's own declarations of the bindings a pipeline uses (unused ones are fine)
function layoutFor(code, use){
  const re = /@group\(0\)\s*@binding\((\d+)\)\s*var(<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g; const ents = []; let m;
  const V = GPUShaderStage.COMPUTE;
  while ((m = re.exec(code))){ const b = +m[1], q = m[2] || '', t = m[3].trim(); if (!use.includes(b)) continue;
    if (q.includes('uniform')) ents.push({binding:b, visibility:V, buffer:{type:'uniform'}});
    else if (q.includes('read_write')) ents.push({binding:b, visibility:V, buffer:{type:'storage'}});
    else if (q.includes('storage')) ents.push({binding:b, visibility:V, buffer:{type:'read-only-storage'}});
    else if (t === 'sampler') ents.push({binding:b, visibility:V, sampler:{type:'filtering'}});
    else if (t.startsWith('texture_storage')){ const mm = t.match(/texture_storage_(\w+)<(\w+),/); ents.push({binding:b, visibility:V, storageTexture:{access:'write-only', format:mm[2], viewDimension:mm[1].replace('_array', '-array')}}); }
    else if (t.startsWith('texture_')){ const dim = t.match(/texture_(\w+)</)[1].replace('_array', '-array'); ents.push({binding:b, visibility:V, texture:{sampleType:'float', viewDimension:dim}}); } }
  return device.createBindGroupLayout({entries: ents});
}
const computePipe = async (label, code, entry, use) => { const lay = layoutFor(code, use);
  const p = await device.createComputePipelineAsync({label, layout: device.createPipelineLayout({bindGroupLayouts:[lay]}), compute:{module: await module(label, code), entryPoint: entry || 'main'}}); p._lay = lay; return p; };
const bg = (pipe, entries) => device.createBindGroup({layout: pipe._lay || pipe.getBindGroupLayout(0), entries: entries.map(([binding, r]) => ({binding, resource: r.size !== undefined && r.mapState !== undefined ? {buffer: r} : r}))});

async function init(m){
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'}); R.adapter = adapter; R.gpu = navigator.gpu;   // (kept alive: losing them can drop the device)
  if (!adapter) throw new Error('No WebGPU adapter');
  const lim = adapter.limits;
  device = await adapter.requestDevice({requiredLimits:{maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize}});
  device.lost.then(i => fail('GPU device lost: ' + i.message));
  device.addEventListener('uncapturederror', e => fail('GPU error: ' + e.error.message));
  canvas = m.canvas; canvasFmt = navigator.gpu.getPreferredCanvasFormat();
  // headless test runs (SwiftShader) lose the device when a canvas is configured: they draw the display into a texture instead
  S.noPresent = !!m.noPresent;
  if (!S.noPresent){ gctx = canvas.getContext('webgpu'); gctx.configure({device, format: canvasFmt, alphaMode:'opaque'}); } else canvasFmt = 'rgba8unorm';
  post({type:'stage', text:'compiling shaders'});
  const info = adapter.info || {};
  // atmosphere tables
  R.frame = device.createBuffer({size: FRAME_OFF._size*4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.trans = device.createTexture({size:[256, 64, 6], format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.ms = device.createTexture({size:[32, 32, 6], format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.amb = device.createBuffer({size: 32*6*16, usage: GPUBufferUsage.STORAGE});
  R.meter = device.createBuffer({size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  R.samp = device.createSampler({magFilter:'linear', minFilter:'linear', addressModeU:'clamp-to-edge', addressModeV:'clamp-to-edge'});
  const transV = R.trans.createView({dimension:'2d-array'}), msV = R.ms.createView({dimension:'2d-array'});
  R.wrapSamp = device.createSampler({magFilter:'linear', minFilter:'linear', addressModeU:'repeat', addressModeV:'repeat', addressModeW:'repeat'});
  R.cu = device.createBuffer({size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.noise = device.createTexture({size:[128, 128, 128], dimension:'3d', format:'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  // (separate per-level uniforms for each pass kind: writeBuffer lands before the whole command buffer runs)
  R.gp = Array.from({length: VOL.NLEV}, () => device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  R.lp = Array.from({length: VOL.NLEV}, () => device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  R.ly = device.createBuffer({size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.fieldBuf = device.createBuffer({size: 256*256*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  R.fgp = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const [pT, pM, pA, pMeter, pSky, pNoise, pGen, pField, pLight] = await Promise.all([
    computePipe('transLUT', wgsl('common', 'atmo', 'luts'), 'transLUT', [0, 1]),
    computePipe('msLUT', wgsl('common', 'atmo', 'luts'), 'msLUTpass', [0, 2, 4, 5]),
    computePipe('ambLUT', wgsl('common', 'atmo', 'luts'), 'ambPass', [0, 2, 3, 4, 6]),
    computePipe('meter', wgsl('common', 'atmo', 'cloudu', 'cloudlit', 'meter'), 'main', [0, 1, 3, 4, 5, 6, 7]),
    computePipe('sky', wgsl('common', 'atmo', 'cloudu', 'cloudvol', 'cloudlit', 'sky'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    computePipe('noise', wgsl('common', 'noise'), 'main', [0]),
    computePipe('cloudgen', wgsl('common', 'cloudu', 'cloudgen'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    computePipe('cloudfield', wgsl('common', 'cloudu', 'cloudgen'), 'fieldMain', [5, 6, 7, 8, 10]),
    computePipe('cloudlight', wgsl('common', 'cloudu', 'cloudvol', 'cloudlight'), 'main', [0, 1, 2, 3, 4, 5, 6, 7]),
  ]);
  R.pNoise = pNoise; R.pGen = pGen; R.pLight = pLight; R.pField = pField;
  { const enc = device.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(pNoise); c.setBindGroup(0, bg(pNoise, [[0, R.noise.createView()]])); c.dispatchWorkgroups(32, 32, 32); c.end(); device.queue.submit([enc.finish()]); }
  R.pT = pT; R.pM = pM; R.pA = pA; R.pMeter = pMeter; R.pSky = pSky;
  R.bgT = bg(pT, [[0, R.frame], [1, transV]]);
  R.bgM = bg(pM, [[0, R.frame], [2, transV], [4, R.samp], [5, msV]]);
  R.bgA = bg(pA, [[0, R.frame], [2, transV], [3, msV], [4, R.samp], [6, R.amb]]);
  R.transV = transV; R.msV = msV;
  // display
  const dm = await module('display', WGSL.display);
  R.pDisp = device.createRenderPipeline({label:'display', layout:'auto', vertex:{module: dm, entryPoint:'vs'}, fragment:{module: dm, entryPoint:'fs', targets:[{format: canvasFmt}]}, primitive:{topology:'triangle-list'}});
  R.disp = device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  // per-band pass uniforms: a small pool, one per band submitted in a frame
  R.passBufs = Array.from({length: 64}, () => device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  post({type:'ready', adapter: {vendor: info.vendor || '', arch: info.architecture || '', desc: info.description || ''}});
  requestAnimationFrame(tick);
}

// two accumulation buffers: a change renders into one while the display keeps the other (the last finished image) wherever the
// new one has not reached yet, so the view never flashes black
function allocPanorama(W, H){
  if (S.W === W && S.H === H && R.accum) return;
  if (R.acc) R.acc.forEach(b => b.destroy());
  S.W = W; S.H = H; S.cur = 0; S.sample = 0;
  R.acc = [0, 1].map(() => device.createBuffer({size: W*H*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST}));
  R.accum = R.acc[0];
  R.bgDispAll = [0, 1].map(i => bg(R.pDisp, [[0, R.disp], [1, R.acc[i]], [2, R.acc[1 - i]]]));
  S.clearBoth = true;
  makeSkyGroups();
  resetAccum();
}
function useBuffer(i){ S.cur = i; R.accum = R.acc[i]; R.bgSky = R.bgSkyAll && R.bgSkyAll[i]; R.bgDisp = R.bgDispAll[i]; }
function makeSkyGroups(){ if (!R.dens) return;
  R.bgMeter = bg(R.pMeter, [[0, R.frame], [1, R.transV], [3, R.samp], [4, R.amb], [5, R.meter], [6, R.cu], [7, R.lightV]]);
  if (!R.acc) return;
  R.bgSkyAll = R.acc.map(acc => R.passBufs.map(pb => bg(R.pSky, [[0, R.frame], [1, R.transV], [2, R.msV], [3, R.samp], [4, R.amb], [5, pb], [6, acc],
    [7, R.cu], [8, R.densV], [9, R.lightV], [10, R.noise.createView()], [11, R.wrapSamp]])));
  useBuffer(S.cur || 0); }
// the cloud volume and its light volume, sized by the quality setting
function allocVolume(q){
  const nx = q >= 1 ? 256 : 128, nz = q >= 1 ? 160 : 80, lx = nx/2, lz = nz/2;
  if (R.volQ === q) return; R.volQ = q;
  if (R.dens){ R.dens.destroy(); R.light.destroy(); }
  R.dens = device.createTexture({size:[nx, nx, nz*VOL.NLEV], dimension:'3d', format:'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC});
  R.light = device.createTexture({size:[lx, lx, lz*VOL.NLEV], dimension:'3d', format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC});
  R.densV = R.dens.createView(); R.lightV = R.light.createView(); R.volRes = [nx, nz, lx, lz]; S.cuKey = null; S.rowsWritten = null;
  makeSkyGroups(); }
// cumulus records → GPU, then the volume is rebuilt level by level, over the altitudes where any cloud can be
// cover calibration: how much footprint gives the cover asked for depends on the cloud shapes, so it is measured (the share of
// sky columns over the central 64 km that are cloudy, seen from below) and the field rebuilt once per shape setting
const shapeKey = P => JSON.stringify(Object.keys(P).filter(k => /^cu|^wind/.test(k) && !/^cu(Cover|Seed|Dens|Erode|Amb|Drop)$/.test(k)).map(k => P[k])) + R.volQ;
function buildClouds(P, enc){
  S.cuCal = S.cuCal || {}; const sk = shapeKey(P); if (P.cuCalHint && !S.cuCal[sk]) S.cuCal[sk] = {k: P.cuCalHint, n: 9, done: true};   // (tests: skip the calibration rebuilds)
  const cal = S.cuCal[sk];
  const cu = genCumulus(P, cal ? cal.k : 2.2), pk = packCumulus(cu);
  // (measured from the sky columns, so only while cumulus is the only layer; otherwise the last calibration stands)
  const alone = !layerBand(P) && P.cuOn && P.cuCover > 0.001;
  S.measure = (cal && cal.done) || !alone ? null : {sk, k: cal ? cal.k : 2.2, target: P.cuCover, n: cal ? cal.n : 0};
  const mk = (arr) => { const b = device.createBuffer({size: Math.max(arr.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(b, 0, arr); return b; };
  for (const k of ['cuRec', 'cuStart', 'cuIdx']) if (R[k]) R[k].destroy();
  R.cuRec = mk(pk.recs); R.cuStart = mk(pk.start); R.cuIdx = mk(pk.idx);
  const [nx, nz] = R.volRes;
  // the layered types: their thresholds from the measured distributions of their fields
  const thr = {}; for (const k of ['sc', 'ac', 'ci']){ const d = S.fieldDist && S.fieldDist[k + layerKey(P, k)]; if (d) thr[k] = d[Math.min(d.length - 1, Math.max(0, Math.floor((1 - P[k + 'Cover'])*d.length)))]; }
  device.queue.writeBuffer(R.ly, 0, layerUniforms(P, thr));
  const lb = layerBand(P);
  const onC = cu.clouds.length > 0, on = onC || !!lb;
  let lo = onC ? cu.base : 1e9, hi = onC ? cu.top : 0; if (lb){ lo = Math.min(lo, lb[0]); hi = Math.max(hi, lb[1]); }
  S.band = on ? [lo, hi] : [0, 0]; S.cloudOn = on;
  const k0 = on ? Math.max(0, Math.floor(altToSlice(Math.max(lo - 0.45, 0), nz))) : 0, k1 = on ? Math.min(nz, Math.ceil(altToSlice(hi + 0.15, nz))) : 0;
  // rows written last time but not now are cleared by including them (nothing evaluates there now)
  const prev = S.rowsWritten || [0, nz]; const r0 = Math.min(k0, prev[0]), r1 = Math.max(k1, prev[1]); S.rowsWritten = on ? [k0, k1] : [0, 0];
  writeCU(P);
  if (r1 > r0) for (let l = 0; l < VOL.NLEV; l++){
    device.queue.writeBuffer(R.gp[l], 0, new Uint32Array([l, r0, r1 - r0, on ? pk.n : 0]));
    const c = enc.beginComputePass(); c.setPipeline(R.pGen);
    c.setBindGroup(0, bg(R.pGen, [[0, R.cu], [1, R.densV], [2, R.cuRec], [3, R.cuStart], [4, R.cuIdx], [5, R.gp[l]], [6, R.ly], [7, R.noise.createView()], [8, R.wrapSamp]]));
    c.dispatchWorkgroups(nx/4, nx/4, Math.ceil((r1 - r0)/4)); c.end(); }
  S.cloudInfo = {n: pk.n, maxPer: pk.maxPer, base: cu.base, top: cu.top};
}
async function measureCover(m){
  S.measure = null; const [, , lx, lz] = R.volRes, l = 2, bpr = Math.ceil(lx*8/256)*256;
  const rb = device.createBuffer({size: bpr*lx, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({texture: R.light, origin:[0, 0, l*lz]}, {buffer: rb, bytesPerRow: bpr, rowsPerImage: lx}, [lx, lx, 1]); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const h = new Uint16Array(rb.getMappedRange()); let c = 0;
  const f16 = u => { const e = (u >> 10) & 31, f = u & 1023; return e === 0 ? f/1024*Math.pow(2, -14) : e === 31 ? 1e9 : (1 + f/1024)*Math.pow(2, e - 15); };
  for (let y = 0; y < lx; y++) for (let x = 0; x < lx; x++) if (f16(h[y*bpr/2 + x*4 + 2]) > 0.5) c++;
  rb.unmap(); rb.destroy();
  const meas = c/(lx*lx), tgt = m.target;
  if (S.P.dbgLog) post({type:'log', text:`cover: asked ${tgt.toFixed(3)}, measured ${meas.toFixed(3)} with k ${m.k.toFixed(3)}`});
  // cover from footprint saturates as clouds overlap (1 − e^−a): invert that to find the footprint for the cover asked
  const a = -Math.log(Math.max(1 - Math.min(meas, 0.97), 1e-3)), aT = -Math.log(Math.max(1 - Math.min(tgt, 0.97), 1e-3));
  const done = Math.abs(meas - tgt) < 0.02 || m.n >= 2;
  S.cuCal[m.sk] = {k: done ? m.k : clamp(m.k*aT/Math.max(a, 1e-3), 0.3, 30), n: m.n + 1, done};
  if (!done){ S.cuKey = null; S.paramsDirty = true; }
}
const layerKey = (P, k) => JSON.stringify(Object.keys(P).filter(x => LAYER_KEYS[k].test(x)).map(x => P[x]));
// the coverage distribution of each enabled layer's field (once per shape setting): then any cover is a quantile of it
function needFields(P){ S.fieldDist = S.fieldDist || {}; return ['sc', 'ac', 'ci'].filter(k => P[k + 'On'] && !S.fieldDist[k + layerKey(P, k)]); }
async function measureFields(P, ks){
  S.fieldBusy = true;
  try { for (const k of ks){ const idx = {sc: 0, ac: 1, ci: 2}[k];
      device.queue.writeBuffer(R.ly, 0, layerUniforms(P, {})); device.queue.writeBuffer(R.fgp, 0, new Uint32Array([idx, 0, 0, 0]));
      const rb = device.createBuffer({size: 256*256*4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      const enc = device.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(R.pField);
      c.setBindGroup(0, bg(R.pField, [[5, R.fgp], [6, R.ly], [7, R.noise.createView()], [8, R.wrapSamp], [10, R.fieldBuf]])); c.dispatchWorkgroups(32, 32); c.end();
      enc.copyBufferToBuffer(R.fieldBuf, 0, rb, 0, 256*256*4); device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ); const d = new Float32Array(rb.getMappedRange().slice(0)).sort(); rb.unmap(); rb.destroy();
      S.fieldDist[k + layerKey(P, k)] = d; } }
  finally { S.fieldBusy = false; S.cuKey = null; S.paramsDirty = true; }
}
function writeCU(P){ const [nx, nz, lx, lz] = R.volRes; const dp = dropletPhase(P.cuDrop || 14);
  device.queue.writeBuffer(R.cu, 0, new Float32Array([VOL.E0, VOL.ZTOP, VOL.NLEV, VOL.SDF_LEVELS, nx, nz, lx, lz,
    S.band ? S.band[0] : 0, S.band ? S.band[1] : 0, S.cloudOn ? 1 : 0, P.cuErode ?? 1, dp.gHG, dp.gD, dp.a, dp.wD, 0.5, 0.45, 0.8, 0.6*(P.cuAmb ?? 1), ...(() => { const wl = Math.hypot(P.windX, P.windZ) || 1; return [P.windX/wl, P.windZ/wl, 1.2*(P.ciCell || 1.5), 0]; })()])); }
function lightClouds(enc){ const [, , lx, lz] = R.volRes;
  for (let l = 0; l < VOL.NLEV; l++){ device.queue.writeBuffer(R.lp[l], 0, new Uint32Array([l, 0, 0, 0]));
    const c = enc.beginComputePass(); c.setPipeline(R.pLight);
    c.setBindGroup(0, bg(R.pLight, [[0, R.frame], [1, R.cu], [2, R.densV], [3, R.noise.createView()], [4, R.samp], [5, R.wrapSamp], [6, R.lightV], [7, R.lp[l]]]));
    c.dispatchWorkgroups(lx/4, lx/4, lz/4); c.end(); } }
// crop window (fractions of the panorama) → pixel rectangle; the whole panorama when none
function cropRect(){ const c = S.P && S.P.crop; if (!c) return [0, 0, S.W, S.H];
  return [Math.floor(c[0]*S.W), Math.floor(c[1]*S.H), Math.ceil(c[2]*S.W), Math.ceil(c[3]*S.H)]; }
function resetAccum(){ if (S.sample > 0 && R.acc) useBuffer(1 - S.cur); S.cr = cropRect(); S.sample = 0; S.row = S.cr[1]; S.needClear = true; S.t0 = performance.now(); S.sampleT = S.t0; }

// new settings: recompute the physical state; rebuild the tables only when the air or the ground changed
function applyParams(){
  S.paramsDirty = false;
  const P = S.P; const res = Math.max(256, Math.min(8192, P.previewRes|0));
  allocPanorama(res, res/2);
  allocVolume(P.volQ ?? 1);
  const fr = computeFrame(P); S.derived = fr.derived;
  device.queue.writeBuffer(R.frame, 0, fr.frame);
  const enc = device.createCommandEncoder();
  // clouds: rebuild the volume when a cloud setting changed; relight it when the clouds or the sun or moon moved
  const cuKey = JSON.stringify(Object.keys(P).filter(k => /^(cu|wind|sc|ac|ci)/.test(k)).map(k => P[k])) + R.volQ;
  const nf = needFields(P); if (nf.length && !S.fieldBusy) measureFields(P, nf);
  const t0 = performance.now(); let rebuilt = false;
  if (cuKey !== S.cuKey && !S.fieldBusy){ S.cuKey = cuKey; buildClouds(P, enc); rebuilt = true; } else writeCU(P);
  const litKey = cuKey + [fr.derived.sunAz, fr.derived.sunEl, fr.derived.moonAz, fr.derived.moonEl, P.mode, P.date, P.time].join('|');
  if (litKey !== S.litKey || rebuilt){ S.litKey = litKey; lightClouds(enc); }
  S.cloudMs = performance.now() - t0;
  if (fr.atmKey !== S.atmKey && P.dbg !== 'nolut'){ S.atmKey = fr.atmKey;
    let c = enc.beginComputePass(); c.setPipeline(R.pT); c.setBindGroup(0, R.bgT); c.dispatchWorkgroups(32, 8, 6); c.end();
    c = enc.beginComputePass(); c.setPipeline(R.pM); c.setBindGroup(0, R.bgM); c.dispatchWorkgroups(4, 4, 6); c.end(); }
  if (P.dbg !== 'noamb'){ let c = enc.beginComputePass(); c.setPipeline(R.pA); c.setBindGroup(0, R.bgA); c.dispatchWorkgroups(1, 6, 1); c.end();
  c = enc.beginComputePass(); c.setPipeline(R.pMeter); c.setBindGroup(0, R.bgMeter); c.dispatchWorkgroups(1); c.end();
  var mr = device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}); enc.copyBufferToBuffer(R.meter, 0, mr, 0, 16); }
  device.queue.submit([enc.finish()]);
  if (S.measure && S.cloudOn) measureCover(S.measure);
  if (mr){ const seq = S.meterSeq = (S.meterSeq || 0) + 1; mr.mapAsync(GPUMapMode.READ).then(() => { const a = new Float32Array(mr.getMappedRange().slice(0)); mr.unmap(); mr.destroy(); if (seq === S.meterSeq) S.meter = {E:a[0], Ed:a[1], Esky:a[2]}; }).catch(() => {}); }
  resetAccum();
}

function exposure(){ const v = S.view; if (v.auto){ const E = Math.max(S.meter.E || 1e-3, 0.44); return Math.PI/E*Math.pow(2, v.expoComp); } return 1/(1.2*Math.pow(2, v.expoComp)); }

function tick(){
  requestAnimationFrame(tick);
  if (S.error || !S.P) return;
  if (S.paramsDirty) applyParams();
  if (!R.accum) return;
  const enc = device.createCommandEncoder(); let used = false;
  if (S.clearBoth){ R.acc.forEach(b => enc.clearBuffer(b)); S.clearBoth = false; S.needClear = false; used = true; }
  if (S.needClear){ enc.clearBuffer(R.accum); S.needClear = false; used = true; }
  // render bands of rows within this frame's budget, but never queue up more than two frames of GPU work
  let submitted = 0;
  if (S.sample < S.target && S.inFlight < 2 && S.P.dbg !== 'nosky'){
    let budgetRows = Math.max(8, S.rows); let k = 0;
    while (budgetRows > 0 && k < R.passBufs.length && S.sample < S.target){
      const [cx0, cy0, cx1, cy1] = S.cr; const rows = Math.min(budgetRows, cy1 - S.row);
      device.queue.writeBuffer(R.passBufs[k], 0, new Uint32Array([S.row, S.sample, S.W, S.H, cx0, cx1, cy1, 0]));
      const c = enc.beginComputePass(); c.setPipeline(R.pSky); c.setBindGroup(0, R.bgSky[k]); c.dispatchWorkgroups(Math.ceil((cx1 - cx0)/8), Math.ceil(rows/8)); c.end();
      const fr = (cx1 - cx0)/S.W; S.row += Math.ceil(rows/8)*8; budgetRows -= Math.max(rows*fr, 1); submitted += rows*fr; k++;
      if (S.row >= cy1){ S.row = cy0; S.sample++; const now = performance.now(); S.lastSampleMs = now - S.sampleT; S.sampleT = now; }
    }
    used = true;
  }
  // display: only when the image or the view changed, and not while two displays are still queued
  if ((submitted || S.dispDirty) && !S.noPresent && (S.dispInFlight || 0) < 2){ S.dispDirty = false; display(enc); used = true; S.dispInFlight = (S.dispInFlight || 0) + 1;
    device.queue.onSubmittedWorkDone().then(() => { S.dispInFlight--; }); }
  else if (submitted) S.dispDirty = true;
  if (used){ const t0 = performance.now(); device.queue.submit([enc.finish()]);
    if (submitted){ S.inFlight++; const sub = submitted, row0 = S.row; if (S.P.dbgLog) post({type:'log', text:`submit ${sub} rows (row ${row0}, sample ${S.sample})`});
      device.queue.onSubmittedWorkDone().then(() => { S.inFlight--; const dt = performance.now() - t0; if (S.P.dbgLog) post({type:'log', text:`done ${sub} rows in ${dt.toFixed(0)} ms`});
        // aim for ~10 ms of GPU work per frame
        S.rows = Math.round(clamp(sub*10/Math.max(dt, 0.5), 8, S.H)); }); } }
  const now = performance.now();
  if (now - S.lastStatus > 200 || (submitted && S.sample === S.target && S.row === S.cr[1])){ S.lastStatus = now;
    post({type:'status', sample: S.sample, target: S.target, row: S.row - S.cr[1], rows: S.cr[3] - S.cr[1], W: S.W, H: S.H, ms: S.lastSampleMs || 0, total: now - S.t0, derived: S.derived, meter: S.meter, expo: exposure(), done: S.sample >= S.target}); }
}
function display(enc){
  const v = S.view, cw = canvas.width, ch = canvas.height; let rw = cw, rh = cw/2; if (rh > ch){ rh = ch; rw = ch*2; }
  device.queue.writeBuffer(R.disp, 0, new Float32Array([cw, ch, S.W, S.H, (cw - rw)/2, (ch - rh)/2, rw, rh, v.mode, v.yaw, v.pitch, v.fov, exposure(), S.P.azOff*D2R, 0, 0]));
  const tex = S.noPresent ? dispTarget(cw, ch) : gctx.getCurrentTexture();
  const rp = enc.beginRenderPass({colorAttachments:[{view: tex.createView(), loadOp:'clear', storeOp:'store', clearValue:{r:0.027, g:0.035, b:0.047, a:1}}]});
  rp.setPipeline(R.pDisp); rp.setBindGroup(0, R.bgDisp); rp.draw(3); rp.end();
}
function dispTarget(w, h){ if (!R.dispTex || R.dispTex.width !== w || R.dispTex.height !== h){ if (R.dispTex) R.dispTex.destroy();
  R.dispTex = device.createTexture({size:[w, h], format:'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC}); } return R.dispTex; }
// the displayed image (test runs): RGBA8, rows top to bottom
async function shot(){ { const e = device.createCommandEncoder(); display(e); device.queue.submit([e.finish()]); } const t = R.dispTex; if (!t) return null; const w = t.width, h = t.height, bpr = Math.ceil(w*4/256)*256;
  const rb = device.createBuffer({size: bpr*h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({texture: t}, {buffer: rb, bytesPerRow: bpr}, [w, h]); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const src = new Uint8Array(rb.getMappedRange()), o = new Uint8Array(w*h*4);
  for (let y = 0; y < h; y++) o.set(src.subarray(y*bpr, y*bpr + w*4), y*w*4); rb.unmap(); rb.destroy(); return {w, h, rgba: o}; }
// one horizontal slice of the cloud volume (tests): level l, altitude km → RGBA8 (nx × nx), and of the light volume (4 × f16)
async function probeVol(l, alt){ const [nx, nz, lx, lz] = R.volRes;
  const k = Math.min(nz - 1, Math.floor(altToSlice(alt, nz))), kl = Math.min(lz - 1, Math.floor(altToSlice(alt, lz)));
  const bpr = Math.ceil(nx*4/256)*256, bprL = Math.ceil(lx*8/256)*256;
  const rb = device.createBuffer({size: bpr*nx, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const rl = device.createBuffer({size: bprL*lx, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({texture: R.dens, origin:[0, 0, l*nz + k]}, {buffer: rb, bytesPerRow: bpr, rowsPerImage: nx}, [nx, nx, 1]);
  enc.copyTextureToBuffer({texture: R.light, origin:[0, 0, l*lz + kl]}, {buffer: rl, bytesPerRow: bprL, rowsPerImage: lx}, [lx, lx, 1]);
  device.queue.submit([enc.finish()]); await rb.mapAsync(GPUMapMode.READ); await rl.mapAsync(GPUMapMode.READ);
  const a = new Uint8Array(rb.getMappedRange()), o = new Uint8Array(nx*nx*4); for (let y = 0; y < nx; y++) o.set(a.subarray(y*bpr, y*bpr + nx*4), y*nx*4);
  const b = new Uint16Array(rl.getMappedRange()), ol = new Uint16Array(lx*lx*4); for (let y = 0; y < lx; y++) ol.set(b.subarray(y*bprL/2, y*bprL/2 + lx*4), y*lx*4);
  rb.unmap(); rl.unmap(); rb.destroy(); rl.destroy(); return {nx, lx, dens: o, light: ol, info: S.cloudInfo}; }
// accumulated panorama as XYZ (divided by the sample count): for tests and exports
async function readback(){
  const [x0, y0, x1, y1] = S.cr, w = x1 - x0, h = y1 - y0;
  const n = S.W*h*16; const rb = device.createBuffer({size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(R.accum, y0*S.W*16, rb, 0, n); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
  const o = new Float32Array(w*h*3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ const i = y*S.W + x0 + x, j = y*w + x; const wt = Math.max(a[4*i + 3], 1e-6); o[3*j] = a[4*i]/wt; o[3*j + 1] = a[4*i + 1]/wt; o[3*j + 2] = a[4*i + 2]/wt; }
  return {xyz: o, W: w, H: h};
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'params'){ S.P = m.P; S.target = m.target || S.target; S.paramsDirty = true; }
    else if (m.type === 'view'){ Object.assign(S.view, m.view); S.dispDirty = true; if (m.view.cw && canvas){ canvas.width = m.view.cw; canvas.height = m.view.ch; } }
    else if (m.type === 'probe'){ const r = await probeVol(m.l, m.alt); post({type:'probe', id: m.id, ...r}, [r.dens.buffer, r.light.buffer]); }
    else if (m.type === 'shot'){ const r = await shot(); post({type:'shot', id: m.id, ...(r || {})}, r ? [r.rgba.buffer] : []); }
    else if (m.type === 'readback'){ const r = await readback(); post({type:'pixels', id: m.id, W: r.W, H: r.H, xyz: r.xyz}, [r.xyz.buffer]); }
  } catch (err){ fail(err && err.message || err); }
};
