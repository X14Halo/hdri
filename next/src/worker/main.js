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
const computePipe = async (label, code, entry) => device.createComputePipeline({label, layout:'auto', compute:{module: await module(label, code), entryPoint: entry || 'main'}});
const bg = (pipe, entries) => device.createBindGroup({layout: pipe.getBindGroupLayout(0), entries: entries.map(([binding, r]) => ({binding, resource: r.size !== undefined && r.mapState !== undefined ? {buffer: r} : r}))});

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
  const [pT, pM, pA, pMeter, pSky] = await Promise.all([
    computePipe('transLUT', wgsl('common', 'atmo', 'luts'), 'transLUT'),
    computePipe('msLUT', wgsl('common', 'atmo', 'luts'), 'msLUTpass'),
    computePipe('ambLUT', wgsl('common', 'atmo', 'luts'), 'ambPass'),
    computePipe('meter', wgsl('common', 'atmo', 'meter')),
    computePipe('sky', wgsl('common', 'atmo', 'sky')),
  ]);
  R.pT = pT; R.pM = pM; R.pA = pA; R.pMeter = pMeter; R.pSky = pSky;
  R.bgT = bg(pT, [[0, R.frame], [1, transV]]);
  R.bgM = bg(pM, [[0, R.frame], [2, transV], [4, R.samp], [5, msV]]);
  R.bgA = bg(pA, [[0, R.frame], [2, transV], [3, msV], [4, R.samp], [6, R.amb]]);
  R.bgMeter = bg(pMeter, [[0, R.frame], [1, transV], [3, R.samp], [4, R.amb], [5, R.meter]]);
  R.transV = transV; R.msV = msV;
  // display
  const dm = await module('display', WGSL.display);
  R.pDisp = device.createRenderPipeline({label:'display', layout:'auto', vertex:{module: dm, entryPoint:'vs'}, fragment:{module: dm, entryPoint:'fs', targets:[{format: canvasFmt}]}, primitive:{topology:'triangle-list'}});
  R.disp = device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  // per-band pass uniforms: a small pool, one per band submitted in a frame
  R.passBufs = Array.from({length: 64}, () => device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  post({type:'ready', adapter: {vendor: info.vendor || '', arch: info.architecture || '', desc: info.description || ''}});
  requestAnimationFrame(tick);
}

function allocPanorama(W, H){
  if (S.W === W && S.H === H && R.accum) return;
  if (R.accum) R.accum.destroy();
  S.W = W; S.H = H;
  R.accum = device.createBuffer({size: W*H*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
  R.bgSky = R.passBufs.map(pb => bg(R.pSky, [[0, R.frame], [1, R.transV], [2, R.msV], [3, R.samp], [4, R.amb], [5, pb], [6, R.accum]]));
  R.bgDisp = bg(R.pDisp, [[0, R.disp], [1, R.accum]]);
  resetAccum();
}
function resetAccum(){ S.sample = 0; S.row = 0; S.needClear = true; S.t0 = performance.now(); S.sampleT = S.t0; }

// new settings: recompute the physical state; rebuild the tables only when the air or the ground changed
function applyParams(){
  S.paramsDirty = false;
  const P = S.P; const res = Math.max(256, Math.min(8192, P.previewRes|0));
  allocPanorama(res, res/2);
  const fr = computeFrame(P); S.derived = fr.derived;
  device.queue.writeBuffer(R.frame, 0, fr.frame);
  const enc = device.createCommandEncoder();
  if (fr.atmKey !== S.atmKey && P.dbg !== 'nolut'){ S.atmKey = fr.atmKey;
    let c = enc.beginComputePass(); c.setPipeline(R.pT); c.setBindGroup(0, R.bgT); c.dispatchWorkgroups(32, 8, 6); c.end();
    c = enc.beginComputePass(); c.setPipeline(R.pM); c.setBindGroup(0, R.bgM); c.dispatchWorkgroups(4, 4, 6); c.end(); }
  if (P.dbg !== 'noamb'){ let c = enc.beginComputePass(); c.setPipeline(R.pA); c.setBindGroup(0, R.bgA); c.dispatchWorkgroups(1, 6, 1); c.end();
  c = enc.beginComputePass(); c.setPipeline(R.pMeter); c.setBindGroup(0, R.bgMeter); c.dispatchWorkgroups(1); c.end();
  var mr = device.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}); enc.copyBufferToBuffer(R.meter, 0, mr, 0, 16); }
  device.queue.submit([enc.finish()]);
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
  if (S.needClear){ enc.clearBuffer(R.accum); S.needClear = false; used = true; }
  // render bands of rows within this frame's budget, but never queue up more than two frames of GPU work
  let submitted = 0;
  if (S.sample < S.target && S.inFlight < 2 && S.P.dbg !== 'nosky'){
    let budgetRows = Math.max(8, S.rows); let k = 0;
    while (budgetRows > 0 && k < R.passBufs.length && S.sample < S.target){
      const rows = Math.min(budgetRows, S.H - S.row);
      device.queue.writeBuffer(R.passBufs[k], 0, new Uint32Array([S.row, S.sample, S.W, S.H]));
      const c = enc.beginComputePass(); c.setPipeline(R.pSky); c.setBindGroup(0, R.bgSky[k]); c.dispatchWorkgroups(Math.ceil(S.W/8), Math.ceil(rows/8)); c.end();
      S.row += Math.ceil(rows/8)*8; budgetRows -= rows; submitted += rows; k++;
      if (S.row >= S.H){ S.row = 0; S.sample++; const now = performance.now(); S.lastSampleMs = now - S.sampleT; S.sampleT = now; }
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
  if (now - S.lastStatus > 200 || (submitted && S.sample === S.target && S.row === 0)){ S.lastStatus = now;
    post({type:'status', sample: S.sample, target: S.target, row: S.row, W: S.W, H: S.H, ms: S.lastSampleMs || 0, total: now - S.t0, derived: S.derived, meter: S.meter, expo: exposure(), done: S.sample >= S.target}); }
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
// accumulated panorama as XYZ (divided by the sample count): for tests and exports
async function readback(){
  const n = S.W*S.H*16; const rb = device.createBuffer({size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(R.accum, 0, rb, 0, n); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
  const o = new Float32Array(S.W*S.H*3);
  for (let i = 0; i < S.W*S.H; i++){ const w = Math.max(a[4*i + 3], 1e-6); o[3*i] = a[4*i]/w; o[3*i + 1] = a[4*i + 1]/w; o[3*i + 2] = a[4*i + 2]/w; }
  return o;
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'params'){ S.P = m.P; S.target = m.target || S.target; S.paramsDirty = true; }
    else if (m.type === 'view'){ Object.assign(S.view, m.view); S.dispDirty = true; if (m.view.cw && canvas){ canvas.width = m.view.cw; canvas.height = m.view.ch; } }
    else if (m.type === 'shot'){ const r = await shot(); post({type:'shot', id: m.id, ...(r || {})}, r ? [r.rgba.buffer] : []); }
    else if (m.type === 'readback'){ const xyz = await readback(); post({type:'pixels', id: m.id, W: S.W, H: S.H, xyz}, [xyz.buffer]); }
  } catch (err){ fail(err && err.message || err); }
};
