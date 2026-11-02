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
  const info = adapter.info || {}; R.adapterInfo = {vendor: info.vendor || '', arch: info.architecture || '', desc: info.description || ''};
  // atmosphere tables
  R.frame = device.createBuffer({size: FRAME_OFF._size*4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.trans = device.createTexture({size:[256, 64, 6], format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.ms = device.createTexture({size:[32, 32, 6], format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.amb = device.createBuffer({size: 32*6*16, usage: GPUBufferUsage.STORAGE});
  R.meter = device.createBuffer({size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  R.samp = device.createSampler({magFilter:'linear', minFilter:'linear', addressModeU:'clamp-to-edge', addressModeV:'clamp-to-edge'});
  const transV = R.trans.createView({dimension:'2d-array'}), msV = R.ms.createView({dimension:'2d-array'});
  R.wrapSamp = device.createSampler({magFilter:'linear', minFilter:'linear', addressModeU:'repeat', addressModeV:'repeat', addressModeW:'repeat'});
  R.cu = device.createBuffer({size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.noise = device.createTexture({size:[128, 128, 128], dimension:'3d', format:'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.noise2 = device.createTexture({size:[128, 128, 128], dimension:'3d', format:'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  // (separate per-level uniforms for each pass kind: writeBuffer lands before the whole command buffer runs)
  R.gp = Array.from({length: VOL.NLEV}, () => device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  R.lp = Array.from({length: VOL.NLEV}, () => device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
  R.ly = device.createBuffer({size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.fieldBuf = device.createBuffer({size: 256*256*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  R.fgp = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  // the cumulus field, mapped once per level (640² texels over the level and a margin)
  R.cuMap = device.createTexture({size:[640, 640, VOL.NLEV], format:'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
  R.cuMapW = R.cuMap.createView({dimension:'2d-array'});
  R.paintTex = device.createTexture({size:[128, 32], format:'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture: R.paintTex}, new Uint8Array(128*32*4).fill(128), {bytesPerRow: 512}, [128, 32]);
  const [pT, pM, pA, pMeter, pSky, pNoise, pNoise2, pGen, pField, pLight, pCuMap, pShadow, pVol] = await Promise.all([
    computePipe('transLUT', wgsl('common', 'atmo', 'cloudu', 'luts'), 'transLUT', [0, 1]),
    computePipe('msLUT', wgsl('common', 'atmo', 'cloudu', 'luts'), 'msLUTpass', [0, 2, 4, 5]),
    computePipe('ambLUT', wgsl('common', 'atmo', 'cloudu', 'luts'), 'ambPass', [0, 2, 3, 4, 6, 8, 9]),
    computePipe('meter', wgsl('common', 'atmo', 'cloudu', 'cloudlit', 'meter'), 'main', [0, 1, 3, 4, 5, 6, 7]),
    computePipe('sky', wgsl('common', 'atmo', 'cloudu', 'cloudvol', 'cloudlit', 'sky'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
    computePipe('noise', wgsl('common', 'noise'), 'main', [0]),
    computePipe('noise2', wgsl('common', 'noise'), 'mainDetail', [0]),
    computePipe('cloudgen', wgsl('common', 'cloudu', 'cloudgen'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14]),
    computePipe('cloudfield', wgsl('common', 'cloudu', 'cloudgen'), 'fieldMain', [5, 6, 7, 8, 10]),
    computePipe('cloudlight', wgsl('common', 'cloudu', 'cloudvol', 'cloudlight'), 'main', [0, 1, 2, 3, 4, 5, 6, 7]),
    computePipe('cumap', wgsl('common', 'cloudu', 'cloudgen'), 'cuMapMain', [0, 5, 6, 7, 8, 11]),
    computePipe('shadowmap', wgsl('common', 'cloudu', 'cloudvol', 'cloudlit', 'shadowmap'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    computePipe('volexport', wgsl('common', 'cloudu', 'cloudvol', 'volexport'), 'main', [0, 1, 2, 3, 4, 5, 6, 7, 8]),
  ]);
  R.pNoise = pNoise; R.pGen = pGen; R.pLight = pLight; R.pField = pField; R.pCuMap = pCuMap; R.pShadow = pShadow; R.pVol = pVol;
  { const enc = device.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(pNoise); c.setBindGroup(0, bg(pNoise, [[0, R.noise.createView()]])); c.dispatchWorkgroups(32, 32, 32); c.end();
    const c2 = enc.beginComputePass(); c2.setPipeline(pNoise2); c2.setBindGroup(0, bg(pNoise2, [[0, R.noise2.createView()]])); c2.dispatchWorkgroups(32, 32, 32); c2.end(); device.queue.submit([enc.finish()]); }
  R.pT = pT; R.pM = pM; R.pA = pA; R.pMeter = pMeter; R.pSky = pSky;
  R.bgT = bg(pT, [[0, R.frame], [1, transV]]);
  R.bgM = bg(pM, [[0, R.frame], [2, transV], [4, R.samp], [5, msV]]);
  R.transV = transV; R.msV = msV;
  // display
  const dm = await module('display', WGSL.display);
  const dsOff = {format:'depth24plus', depthWriteEnabled: false, depthCompare:'always'};
  R.pDisp = device.createRenderPipeline({label:'display', layout:'auto', vertex:{module: dm, entryPoint:'vs'}, fragment:{module: dm, entryPoint:'fs', targets:[{format: canvasFmt}]}, primitive:{topology:'triangle-list'}, depthStencil: dsOff});
  // (the look-dev model: a dropped mesh, drawn over the view with a depth buffer)
  R.pMesh = device.createRenderPipeline({label:'mesh', layout:'auto', vertex:{module: dm, entryPoint:'vsMesh', buffers:[{arrayStride: 24, attributes:[{shaderLocation: 0, offset: 0, format:'float32x3'}, {shaderLocation: 1, offset: 12, format:'float32x3'}]}]},
    fragment:{module: dm, entryPoint:'fsMesh', targets:[{format: canvasFmt}]}, primitive:{topology:'triangle-list', cullMode:'none'}, depthStencil:{format:'depth24plus', depthWriteEnabled: true, depthCompare:'less'}});
  R.meshU = device.createBuffer({size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  R.shBuf = device.createBuffer({size: 9*16, usage: GPUBufferUsage.STORAGE});
  R.pLd = await computePipe('lookdev', wgsl('lookdev'), 'main', [0, 1, 2, 3]);
  R.disp = device.createBuffer({size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  // per-band pass uniforms: a small pool, one per band submitted in a frame
  R.alphaDummy = device.createBuffer({size: 16, usage: GPUBufferUsage.STORAGE});   // (the preview writes no cloud alpha)
  R.passBufs = Array.from({length: 64}, () => device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
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
  R.bgDispAll = [0, 1].map(i => bg(R.pDisp, [[0, R.disp], [1, R.acc[i]], [2, R.acc[1 - i]], [3, R.shBuf]]));
  R.bgLdAll = [0, 1].map(i => bg(R.pLd, [[0, R.disp], [1, R.acc[i]], [2, R.acc[1 - i]], [3, R.shBuf]]));
  R.bgMeshAll = [0, 1].map(i => bg(R.pMesh, [[0, R.disp], [1, R.acc[i]], [2, R.acc[1 - i]], [3, R.shBuf], [4, R.meshU]]));
  S.clearBoth = true;
  makeSkyGroups();
  resetAccum();
}
function useBuffer(i){ S.cur = i; R.accum = R.acc[i]; R.bgSky = R.bgSkyAll && R.bgSkyAll[i]; R.bgDisp = R.bgDispAll[i]; }
function makeSkyGroups(){ if (!R.dens) return;
  R.bgMeter = bg(R.pMeter, [[0, R.frame], [1, R.transV], [3, R.samp], [4, R.amb], [5, R.meter], [6, R.cu], [7, R.lightV]]);
  if (!R.acc) return;
  R.bgSkyAll = R.acc.map(acc => R.passBufs.map(pb => bg(R.pSky, [[0, R.frame], [1, R.transV], [2, R.msV], [3, R.samp], [4, R.amb], [5, pb], [6, acc],
    [7, R.cu], [8, R.densV], [9, R.lightV], [10, R.noise.createView()], [11, R.wrapSamp], [12, R.noise2.createView()], [13, R.alphaDummy]])));
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
  const fieldCu = cuIsField(P);
  S.cuCal = S.cuCal || {}; const sk = shapeKey(P); if (P.cuCalHint && !S.cuCal[sk]) S.cuCal[sk] = {k: P.cuCalHint, n: 9, done: true};   // (tests: skip the calibration rebuilds)
  const cal = S.cuCal[sk];
  const cu = genCumulus(P, cal ? cal.k : 2.2), pk = packCumulus(cu);
  // (measured from the sky columns, so only while cumulus is the only layer; otherwise the last calibration stands)
  const alone = !layerBand(P) && P.cuOn && P.cuCover > 0.001 && !fieldCu;
  S.measure = (cal && cal.done) || !alone ? null : {sk, k: cal ? cal.k : 2.2, target: P.cuCover, n: cal ? cal.n : 0};
  const mk = (arr) => { const b = device.createBuffer({size: Math.max(arr.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(b, 0, arr); return b; };
  for (const k of ['cuRec', 'cuStart', 'cuIdx']) if (R[k]) R[k].destroy();
  R.cuRec = mk(pk.recs); R.cuStart = mk(pk.start); R.cuIdx = mk(pk.idx);
  const [nx, nz] = R.volRes;
  // the layered types: their thresholds from the measured distributions of their fields
  const q = (d, f) => d[Math.min(d.length - 1, Math.max(0, Math.floor(f*d.length)))];
  const thr = {}; for (const k of ['sc', 'ac', 'ci', 'cu']){ const d = S.fieldDist && S.fieldDist[k + layerKey(P, k)]; if (d) thr[k] = q(d, 1 - P[k + 'Cover']);
    // (cumulus: the field's strong cores, where the convection reaches its full depth)
    if (d && k === 'cu') thr.cuHi = Math.max(q(d, 0.998), thr.cu + 0.02); }
  device.queue.writeBuffer(R.ly, 0, layerUniforms(P, thr));
  // painted cloud: the paint map (128 × 32 over the upper half of the panorama, 128 = unpainted)
  // (four channels: cumulus, stratocumulus, altocumulus, cirrus; an older one-channel painting applies to all four)
  if (P.paint !== S.paintKey){ S.paintKey = P.paint; let a = new Uint8Array(128*32*4).fill(128);
    if (P.paint){ try { const b = atob(P.paint); if (b.length === a.length) a = Uint8Array.from(b, c => c.charCodeAt(0)); else if (b.length === 128*32) for (let i = 0; i < 4096; i++) a.fill(b.charCodeAt(i), 4*i, 4*i + 4); } catch (e){} }
    device.queue.writeTexture({texture: R.paintTex}, a, {bytesPerRow: 512}, [128, 32]); }
  const lb = layerBand(P);
  const fOn = fieldCu && thr.cuHi !== undefined, fp = cuFieldParams(P);
  if (fOn){ cu.base = fp.rain > 0 ? 0 : fp.base - 0.05; cu.top = fp.base + fp.Hm + 0.3; }
  const onC = cu.clouds.length > 0 || fOn, on = onC || !!lb;
  let lo = onC ? cu.base : 1e9, hi = onC ? cu.top : 0; if (lb){ lo = Math.min(lo, lb[0]); hi = Math.max(hi, lb[1]); }
  S.band = on ? [lo, hi] : [0, 0]; S.cloudOn = on;
  const k0 = on ? Math.max(0, Math.floor(altToSlice(Math.max(lo - 0.45, 0), nz))) : 0, k1 = on ? Math.min(nz, Math.ceil(altToSlice(hi + 0.15, nz))) : 0;
  // rows written last time but not now are cleared by including them (nothing evaluates there now)
  const prev = S.rowsWritten || [0, nz]; const r0 = Math.min(k0, prev[0]), r1 = Math.max(k1, prev[1]); S.rowsWritten = on ? [k0, k1] : [0, 0];
  writeCU(P);
  for (let l = 0; l < VOL.NLEV; l++) device.queue.writeBuffer(R.gp[l], 0, new Uint32Array([l, r0, r1 - r0, on ? pk.n : 0]));
  if (fOn) for (let l = 0; l < VOL.NLEV; l++){
    const c = enc.beginComputePass(); c.setPipeline(R.pCuMap);
    c.setBindGroup(0, bg(R.pCuMap, [[0, R.cu], [5, R.gp[l]], [6, R.ly], [7, R.noise.createView()], [8, R.wrapSamp], [11, R.cuMapW]]));
    c.dispatchWorkgroups(80, 80); c.end(); }
  if (r1 > r0) for (let l = 0; l < VOL.NLEV; l++){
    const c = enc.beginComputePass(); c.setPipeline(R.pGen);
    c.setBindGroup(0, bg(R.pGen, [[0, R.cu], [1, R.densV], [2, R.cuRec], [3, R.cuStart], [4, R.cuIdx], [5, R.gp[l]], [6, R.ly], [7, R.noise.createView()], [8, R.wrapSamp], [12, R.cuMapW], [13, R.samp], [14, R.paintTex.createView()]]));
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
function needFields(P){ S.fieldDist = S.fieldDist || {}; return ['sc', 'ac', 'ci', 'cu'].filter(k => (k === 'cu' ? cuIsField(P) : P[k + 'On']) && !S.fieldDist[k + layerKey(P, k)]); }
async function measureFields(P, ks){
  S.fieldBusy = true;
  try { for (const k of ks){ const idx = {sc: 0, ac: 1, ci: 2, cu: 3}[k];
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
    S.band ? S.band[0] : 0, S.band ? S.band[1] : 0, S.cloudOn ? 1 : 0, P.cuErode ?? 1, dp.gHG, dp.gD, dp.a, dp.wD, ...cloudDrift(P).slice(0, 2), 0, (P.cuAmb ?? 1), ...unit(windAt(P, P.ciBase)), 1.2*(P.ciCell || 1.5), clamp(P.cuDev, 0, 1),
    ...cloudDrift(P).slice(2), P.tlHours || 0, 5*(0.3 + clamp(P.cuDev, 0, 1))])); }
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
  const cuKey = JSON.stringify(Object.keys(P).filter(k => /^(cu|wind|sc|ac|ci|paint|humidity$|azOff$|tlHours$)/.test(k)).map(k => P[k])) + R.volQ;
  const nf = needFields(P); if (nf.length && !S.fieldBusy) measureFields(P, nf);
  const t0 = performance.now(); let rebuilt = false;
  if (cuKey !== S.cuKey && !S.fieldBusy){ S.cuKey = cuKey; buildClouds(P, enc); rebuilt = true; } else writeCU(P);
  const litKey = cuKey + [fr.derived.sunAz, fr.derived.sunEl, fr.derived.moonAz, fr.derived.moonEl, P.mode, P.date, P.time].join('|');
  if (litKey !== S.litKey || rebuilt){ S.litKey = litKey; lightClouds(enc); }
  S.cloudMs = performance.now() - t0;
  if (fr.atmKey !== S.atmKey && P.dbg !== 'nolut'){ S.atmKey = fr.atmKey;
    let c = enc.beginComputePass(); c.setPipeline(R.pT); c.setBindGroup(0, R.bgT); c.dispatchWorkgroups(32, 8, 6); c.end();
    c = enc.beginComputePass(); c.setPipeline(R.pM); c.setBindGroup(0, R.bgM); c.dispatchWorkgroups(4, 4, 6); c.end(); }
  if (P.dbg !== 'noamb'){ let c = enc.beginComputePass(); c.setPipeline(R.pA); c.setBindGroup(0, bg(R.pA, [[0, R.frame], [2, R.transV], [3, R.msV], [4, R.samp], [6, R.amb], [8, R.cu], [9, R.lightV]])); c.dispatchWorkgroups(1, 6, 1); c.end();
  c = enc.beginComputePass(); c.setPipeline(R.pMeter); c.setBindGroup(0, R.bgMeter); c.dispatchWorkgroups(1); c.end();
  var mr = device.createBuffer({size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}); enc.copyBufferToBuffer(R.meter, 0, mr, 0, 32); }
  device.queue.submit([enc.finish()]);
  if (S.measure && S.cloudOn) measureCover(S.measure);
  if (mr){ const seq = S.meterSeq = (S.meterSeq || 0) + 1; mr.mapAsync(GPUMapMode.READ).then(() => { const a = new Float32Array(mr.getMappedRange().slice(0)); mr.unmap(); mr.destroy(); if (seq === S.meterSeq) S.meter = {E:a[0], Ed:a[1], Esky:a[2], sunT:a[3], dni:[a[4], a[5], a[6]]}; }).catch(() => {}); }
  resetAccum();
}

function exposure(){ const v = S.view; if (v.auto){ const E = Math.max(S.meter.E || 1e-3, 0.44); return Math.PI/E*Math.pow(2, v.expoComp); } return 1/(1.2*Math.pow(2, v.expoComp)); }

function tick(){
  requestAnimationFrame(tick);
  if (S.error || !S.P) return;
  if (S.exp){ exportTick(); return; }   // (an export holds the scene still until it is done)
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
      device.queue.writeBuffer(R.passBufs[k], 0, passData([S.row, S.sample, S.W, S.H, cx0, cx1, cy1, 0], [1, 1, 1, 1], S.P.ptPreview));
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
    post({type:'status', sample: S.sample, target: S.target, row: S.row - S.cr[1], rows: S.cr[3] - S.cr[1], W: S.W, H: S.H, ms: S.lastSampleMs || 0, total: now - S.t0, derived: S.derived, meter: S.meter, expo: exposure(), done: S.sample >= S.target, busy: !!(S.fieldBusy || S.paramsDirty)}); }
}
function display(enc, to){
  const v = to ? {...S.view, mode: 0} : S.view, cw = to ? to.width : canvas.width, ch = to ? to.height : canvas.height; let rw = cw, rh = cw/2; if (rh > ch){ rh = ch; rw = ch*2; }
  device.queue.writeBuffer(R.disp, 0, new Float32Array([cw, ch, S.W, S.H, (cw - rw)/2, (ch - rh)/2, rw, rh, v.mode, v.yaw, v.pitch, v.fov, exposure(), S.P.azOff*D2R, 0, 0, v.lookdev && !to ? 1 : 0, Math.round(Math.min(ch*0.09, 70)), 0, 0]));
  // (look-dev: the panorama's lighting into spherical harmonics first, for the grey ball and the chart)
  if (v.lookdev && !to){ const c = enc.beginComputePass(); c.setPipeline(R.pLd); c.setBindGroup(0, R.bgLdAll[S.cur]); c.dispatchWorkgroups(1); c.end(); }
  const tex = to || (S.noPresent ? dispTarget(cw, ch) : gctx.getCurrentTexture());
  const dep = dispDepth(tex.width, tex.height);
  const rp = enc.beginRenderPass({colorAttachments:[{view: tex.createView(), loadOp:'clear', storeOp:'store', clearValue:{r:0.027, g:0.035, b:0.047, a:1}}],
    depthStencilAttachment:{view: dep.createView(), depthClearValue: 1, depthLoadOp:'clear', depthStoreOp:'discard'}});
  rp.setPipeline(R.pDisp); rp.setBindGroup(0, R.bgDisp); rp.draw(3);
  if (R.mesh && v.lookdev && !to && v.mode === 1){
    // (the model fills about a third of the view's height at size 1, ten units in front of the camera)
    const M = MESH_MAT[v.ldMat] || MESH_MAT.grey, dist = 10, sc = 0.36*Math.tan(v.fov/2)*dist*(v.ldSize || 1), sp = (v.ldSpin || 0)*D2R;
    device.queue.writeBuffer(R.meshU, 0, new Float32Array([Math.cos(sp), Math.sin(sp), dist, sc, ...M.alb, M.rough, ...M.f0, 24]));
    rp.setPipeline(R.pMesh); rp.setBindGroup(0, R.bgMeshAll[S.cur]); rp.setVertexBuffer(0, R.mesh.vb); rp.setIndexBuffer(R.mesh.ib, 'uint32'); rp.drawIndexed(R.mesh.n); }
  rp.end();
}
// look-dev materials (linear Rec.709): albedo, roughness, F0
const MESH_MAT = {grey: {alb: [0.18, 0.18, 0.18], rough: 0.45, f0: [0.04, 0.04, 0.04]}, white: {alb: [0.8, 0.8, 0.8], rough: 0.7, f0: [0.04, 0.04, 0.04]},
  clay: {alb: [0.42, 0.3, 0.24], rough: 0.85, f0: [0.035, 0.035, 0.035]}, chrome: {alb: [0, 0, 0], rough: 0.04, f0: [0.6, 0.6, 0.6]}, gold: {alb: [0, 0, 0], rough: 0.25, f0: [1.0, 0.71, 0.29]}};
function dispDepth(w, h){ if (!R.dispDep || R.dispDep.width !== w || R.dispDep.height !== h){ if (R.dispDep) R.dispDep.destroy();
  R.dispDep = device.createTexture({size:[w, h], format:'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT}); } return R.dispDep; }
function setMesh(m){ if (R.mesh){ R.mesh.vb.destroy(); R.mesh.ib.destroy(); R.mesh = null; } if (m && m.idx && m.idx.length){
  const vb = device.createBuffer({size: m.vtx.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(vb, 0, m.vtx);
  const ib = device.createBuffer({size: Math.ceil(m.idx.byteLength/4)*4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST}); device.queue.writeBuffer(ib, 0, m.idx);
  R.mesh = {vb, ib, n: m.idx.length}; } S.dispDirty = true; }
function dispTarget(w, h){ if (!R.dispTex || R.dispTex.width !== w || R.dispTex.height !== h){ if (R.dispTex) R.dispTex.destroy();
  R.dispTex = device.createTexture({size:[w, h], format:'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC}); } return R.dispTex; }
// the displayed image (test runs): RGBA8, rows top to bottom
async function shot(){ { const e = device.createCommandEncoder(); display(e); device.queue.submit([e.finish()]); } const t = R.dispTex; if (!t) return null; const w = t.width, h = t.height, bpr = Math.ceil(w*4/256)*256;
  const rb = device.createBuffer({size: bpr*h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({texture: t}, {buffer: rb, bytesPerRow: bpr}, [w, h]); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const src = new Uint8Array(rb.getMappedRange()), o = new Uint8Array(w*h*4);
  for (let y = 0; y < h; y++) o.set(src.subarray(y*bpr, y*bpr + w*4), y*w*4); rb.unmap(); rb.destroy(); return {w, h, rgba: o}; }
// the whole panorama as displayed (exposure, tone mapping), at w × w/2: for scene reports
async function snap(w){ const h = w/2; const t = device.createTexture({size:[w, h], format: canvasFmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
  { const e = device.createCommandEncoder(); display(e, t); device.queue.submit([e.finish()]); } S.dispDirty = true;
  const bpr = Math.ceil(w*4/256)*256, rb = device.createBuffer({size: bpr*h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({texture: t}, {buffer: rb, bytesPerRow: bpr}, [w, h]); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const src = new Uint8Array(rb.getMappedRange()), o = new Uint8Array(w*h*4);
  for (let y = 0; y < h; y++) o.set(src.subarray(y*bpr, y*bpr + w*4), y*w*4); rb.unmap(); rb.destroy(); t.destroy();
  if (canvasFmt === 'bgra8unorm') for (let i = 0; i < o.length; i += 4){ const r = o[i]; o[i] = o[i + 2]; o[i + 2] = r; }
  return {w, h, rgba: o}; }
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
// one pixel of the panorama (the hover readout): XYZ, from the image in progress, or the last finished one where it has not reached
async function pick(u, v){ if (!R.accum || S.exp) return null;
  const x = clamp(Math.floor(u*S.W), 0, S.W - 1), y = clamp(Math.floor(v*S.H), 0, S.H - 1), off = (y*S.W + x)*16;
  const rb = device.createBuffer({size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(R.accum, off, rb, 0, 16); enc.copyBufferToBuffer(R.acc[1 - S.cur], off, rb, 16, 16); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
  const k = a[3] > 0 ? 0 : 4, w = Math.max(a[k + 3], 1e-6); return [a[k]/w, a[k + 1]/w, a[k + 2]/w]; }
async function readback(){
  const [x0, y0, x1, y1] = S.cr, w = x1 - x0, h = y1 - y0;
  const n = S.W*h*16; const rb = device.createBuffer({size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(R.accum, y0*S.W*16, rb, 0, n); device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
  const o = new Float32Array(w*h*3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ const i = y*S.W + x0 + x, j = y*w + x; const wt = Math.max(a[4*i + 3], 1e-6); o[3*j] = a[4*i]/wt; o[3*j + 1] = a[4*i + 1]/wt; o[3*j + 2] = a[4*i + 2]/wt; }
  return {xyz: o, W: w, H: h};
}

// ---------- export: the full panorama at the output size, in bands of rows rendered into a band-sized buffer ----------
// (an 8K panorama's accumulation would need over 500 MB at once; a band of ~32 MB is rendered to all its samples, read back,
// converted to the export's colour space and handed to the page, which compresses it into the file, then the next band)
// a pass's uniforms: eight integers (rows, sample, size, crop, buffer offset) and the light-layer weights
// (flags: 1 write the clouds' opacity, 2 keep the clouds' shadows in a haze pass)
function passData(u, mask, pt, haze, flags){ const b = new ArrayBuffer(64); new Uint32Array(b, 0, 8).set(u); new Float32Array(b, 32, 8).set([...mask, pt ? 1 : 0, haze ? haze[0] : 0, haze ? haze[1] : 0, flags || 0]); return b; }
function startExport(m){
  if (S.exp || !R.accum) return;
  if (S.paramsDirty) applyParams();   // (settings sent just before, e.g. a timelapse frame's, take effect first)
  // (bands a multiple of 16 rows: the page compresses each band into EXR line blocks of 16 as it arrives)
  const W = m.W, H = W/2, band = Math.max(16, Math.min(H, Math.floor(32*1024*1024/(W*16)/16)*16));
  const buf = device.createBuffer({size: W*band*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
  const abuf = device.createBuffer({size: W*band*8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
  const bgs = R.passBufs.map(pb => bg(R.pSky, [[0, R.frame], [1, R.transV], [2, R.msV], [3, R.samp], [4, R.amb], [5, pb], [6, buf],
    [7, R.cu], [8, R.densV], [9, R.lightV], [10, R.noise.createView()], [11, R.wrapSamp], [12, R.noise2.createView()], [13, abuf]]));
  // light layers: the image rendered once per light — sun, sky, moon, night sky — each with only that light on; they sum to the
  // full image exactly (the light is linear), so the page writes them as layers and their sum as the main image
  // (or, for haze for comp, the air's light and its transmission out to each of a list of distances)
  const masks = m.haze ? m.haze.flatMap(() => [[1, 1, 1, 1], [1, 1, 1, 1]]) : m.layers ? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] : [[1, 1, 1, 1]];
  const hz = m.haze ? m.haze.flatMap(d => [[d, 1], [d, 2]]) : null;
  S.exp = {W, H, band, spp: m.spp, k: m.units === 'watts' ? 1/683 : 1, buf, bgs, y0: 0, row: 0, s: 0, li: 0, masks, rows: 8, inFlight: 0, busy: false, t0: performance.now(), clear: true, lastPost: 0, pt: !!m.pt, hz, abuf, alpha: !!m.alpha && !m.haze, hazeSh: !!m.hazeShafts, noSun: !!m.noSun, cm: CSPACE[m.space] || CSPACE.rec709};
  S.exp.lumW = inv3(S.exp.cm)[1];
}
// ---------- the shot's shadow matte: cloud shadow on the ground around the camera, top-down, in bands of rows ----------
async function shadowMatte(m){
  if (S.sm || !R.dens) return;
  const N = m.N, km = m.km, band = Math.max(8, Math.min(N, Math.floor(16*1024*1024/(N*16)/8)*8)), SMs = S.sm = {cancelled: false};
  const buf = device.createBuffer({size: N*band*16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const ub = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const g = bg(R.pShadow, [[0, R.frame], [1, R.cu], [2, R.densV], [3, R.noise.createView()], [4, R.samp], [5, R.wrapSamp], [6, buf], [7, ub], [8, R.noise2.createView()], [9, R.lightV]]);
  const t0 = performance.now();
  try {
    for (let y0 = 0; y0 < N; y0 += band){
      if (SMs.cancelled) break;
      const rows = Math.min(band, N - y0);
      // (eight rows per dispatch, each waited for: a long dispatch can trip the GPU watchdog)
      for (let r = 0; r < rows; r += 8){
        device.queue.writeBuffer(ub, 0, new Float32Array([km, N, y0 + r, y0]));
        const enc = device.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(R.pShadow); c.setBindGroup(0, g);
        c.dispatchWorkgroups(Math.ceil(N/8), 1); c.end(); device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone(); if (SMs.cancelled) break; }
      const rb = device.createBuffer({size: N*rows*16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, rb, 0, N*rows*16); device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ); const a = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
      post({type:'smChunk', y0, rows, N, data: a}, [a.buffer]);
      post({type:'smProgress', f: (y0 + rows)/N, secs: (performance.now() - t0)/1000});
    }
    if (!SMs.cancelled) post({type:'smDone', secs: (performance.now() - t0)/1000});
  } finally { buf.destroy(); ub.destroy(); S.sm = null; }
}
// the cloud volume on a grid, slice by slice (z), sent as half floats (volexport.wgsl)
async function volExport(m){
  if (S.vx || !R.dens) return;
  if (!S.cloudOn){ post({type:'vxError', text:'There are no clouds to export.'}); return; }
  // (cubic voxels; the grid's height spans the cloud layers that are on)
  const nx = m.nx, nz = nx, km = m.km, vox = km/nx, y0 = Math.max(S.band[0] - 0.3, 0), ny = Math.max(2, Math.ceil((S.band[1] + 0.1 - y0)/vox)), az = m.az;
  if (nx*ny*nz > 192e6){ post({type:'vxError', text:`That grid would be ${nx} × ${ny} × ${nz} voxels (the clouds span ${(S.band[1] + 0.1 - y0).toFixed(1)} km of height): choose a larger area or fewer voxels.`}); return; }
  post({type:'vxStart', nx, ny, nz, vox, y0, band: S.band});
  const VXs = S.vx = {cancelled: false}, words = nx/2*ny;
  const buf = device.createBuffer({size: words*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const ub = device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const g = bg(R.pVol, [[0, R.frame], [1, R.cu], [2, R.densV], [3, R.noise.createView()], [4, R.samp], [5, R.wrapSamp], [6, buf], [7, ub], [8, R.noise2.createView()]]);
  const t0 = performance.now(), per = Math.max(1, Math.floor(24*1024*1024/(words*4)));
  try {
    for (let z0 = 0; z0 < nz && !VXs.cancelled; z0 += per){
      const n = Math.min(per, nz - z0), rb = device.createBuffer({size: words*4*n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      for (let k = 0; k < n; k++){
        device.queue.writeBuffer(ub, 0, new Float32Array([km/2, vox, y0, z0 + k, nx, ny, Math.cos(az), Math.sin(az)]));
        const enc = device.createCommandEncoder(); const c = enc.beginComputePass(); c.setPipeline(R.pVol); c.setBindGroup(0, g);
        c.dispatchWorkgroups(Math.ceil(nx/16), Math.ceil(ny/8)); c.end(); enc.copyBufferToBuffer(buf, 0, rb, words*4*k, words*4); device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone(); if (VXs.cancelled) break; }
      await rb.mapAsync(GPUMapMode.READ); const a = new Uint16Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
      if (VXs.cancelled) break;
      post({type:'vxChunk', z0, n, data: a}, [a.buffer]);
      post({type:'vxProgress', f: (z0 + n)/nz, secs: (performance.now() - t0)/1000});
    }
    if (!VXs.cancelled) post({type:'vxDone', secs: (performance.now() - t0)/1000});
  } finally { buf.destroy(); ub.destroy(); S.vx = null; }
}
function cancelExport(){ const E = S.exp; if (!E) return; S.exp = null; E.cancelled = true; device.queue.onSubmittedWorkDone().then(() => { E.buf.destroy(); E.abuf.destroy(); }); S.paramsDirty = true; }
function exportTick(){
  const E = S.exp; if (E.busy || E.inFlight >= 2) return;
  const enc = device.createCommandEncoder();
  if (E.clear){ enc.clearBuffer(E.buf); enc.clearBuffer(E.abuf); E.clear = false; }
  const rowsB = Math.min(E.band, E.H - E.y0); let budget = Math.max(8, E.rows), k = 0, sub = 0;
  while (budget > 0 && k < R.passBufs.length && E.s < E.spp){
    const rows = Math.min(budget, rowsB - E.row);
    device.queue.writeBuffer(R.passBufs[k], 0, passData([E.y0 + E.row, E.s, E.W, E.H, 0, E.W, E.y0 + rowsB, E.y0], E.masks[E.li], E.pt, E.hz && E.hz[E.li], (E.alpha && E.li === 0 ? 1 : 0) | (E.hazeSh ? 2 : 0) | (E.noSun ? 4 : 0)));
    const c = enc.beginComputePass(); c.setPipeline(R.pSky); c.setBindGroup(0, E.bgs[k]); c.dispatchWorkgroups(Math.ceil(E.W/8), Math.ceil(rows/8)); c.end();
    E.row += Math.ceil(rows/8)*8; budget -= rows; sub += rows; k++;
    if (E.row >= rowsB){ E.row = 0; E.s++; }
  }
  let rb = null, ra = null; const wantA = E.alpha && E.li === 0;
  if (E.s >= E.spp){ rb = device.createBuffer({size: E.W*rowsB*16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}); enc.copyBufferToBuffer(E.buf, 0, rb, 0, E.W*rowsB*16);
    if (wantA){ ra = device.createBuffer({size: E.W*rowsB*8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST}); enc.copyBufferToBuffer(E.abuf, 0, ra, 0, E.W*rowsB*8); }
    E.busy = true; }
  const t0 = performance.now(); device.queue.submit([enc.finish()]); E.inFlight++;
  device.queue.onSubmittedWorkDone().then(() => { E.inFlight--; const dt = performance.now() - t0; if (sub) E.rows = Math.round(clamp(sub*12/Math.max(dt, 0.5), 8, rowsB)); });
  const now = performance.now(); if (now - E.lastPost > 250){ E.lastPost = now; post({type:'exportProgress', f: (E.y0 + (E.li + (E.s + E.row/rowsB)/E.spp)/E.masks.length*rowsB)/E.H, secs: (now - E.t0)/1000}); }
  if (rb) Promise.all([rb.mapAsync(GPUMapMode.READ), ra ? ra.mapAsync(GPUMapMode.READ) : null]).then(() => {
    if (E.cancelled){ rb.unmap(); rb.destroy(); if (ra){ ra.unmap(); ra.destroy(); } return; }
    const a = new Float32Array(rb.getMappedRange()), n = E.W*rowsB, o = new Float32Array(n*3), kk = E.k, M = E.cm;
    // (no clipping: colours outside the gamut keep their negative components; only non-finite values are zeroed)
    const fin = v => Number.isFinite(v) ? v : 0;
    if (E.hz && E.hz[E.li][1] === 2){ for (let i = 0; i < n; i++){ const w = Math.max(a[4*i + 3], 1e-6); o[3*i] = a[4*i]/w; o[3*i + 1] = a[4*i + 1]/w; o[3*i + 2] = a[4*i + 2]/w; } }
    else for (let i = 0; i < n; i++){ const w = Math.max(a[4*i + 3], 1e-6), X = a[4*i]/w, Y = a[4*i + 1]/w, Z = a[4*i + 2]/w;
      o[3*i] = fin((M[0][0]*X + M[0][1]*Y + M[0][2]*Z)*kk); o[3*i + 1] = fin((M[1][0]*X + M[1][1]*Y + M[1][2]*Z)*kk); o[3*i + 2] = fin((M[2][0]*X + M[2][1]*Y + M[2][2]*Z)*kk); }
    let al = null; if (ra){ const aa = new Float32Array(ra.getMappedRange()); al = new Float32Array(2*n); for (let i = 0; i < 2*n; i++) al[i] = clamp(aa[i]/Math.max(a[4*(i >> 1) + 3], 1e-6), 0, 1); ra.unmap(); ra.destroy(); }
    rb.unmap(); rb.destroy();
    post({type:'exportChunk', y0: E.y0, rows: rowsB, W: E.W, H: E.H, layer: E.li, rgb: o, alpha: al, lumW: E.lumW}, al ? [o.buffer, al.buffer] : [o.buffer]);
    E.s = 0; E.row = 0; E.clear = true; E.busy = false;
    if (++E.li >= E.masks.length){ E.li = 0; E.y0 += rowsB; }
    if (E.y0 >= E.H){ E.buf.destroy(); E.abuf.destroy(); S.exp = null; S.paramsDirty = true; post({type:'exportDone', secs: (performance.now() - E.t0)/1000}); }
  });
}

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'params'){ S.P = m.P; S.target = m.target || S.target; S.paramsDirty = true; }
    else if (m.type === 'mesh') setMesh(m);
    else if (m.type === 'view'){ Object.assign(S.view, m.view); S.dispDirty = true; if (m.view.cw && canvas){ canvas.width = m.view.cw; canvas.height = m.view.ch; } }
    else if (m.type === 'pick'){ const r = await pick(m.u, m.v); post({type:'pick', id: m.id, xyz: r}); }
    else if (m.type === 'probe'){ const r = await probeVol(m.l, m.alt); post({type:'probe', id: m.id, ...r}, [r.dens.buffer, r.light.buffer]); }
    else if (m.type === 'shot'){ const r = await shot(); post({type:'shot', id: m.id, ...(r || {})}, r ? [r.rgba.buffer] : []); }
    else if (m.type === 'snap'){ const r = await snap(m.w); post({type:'snap', id: m.id, ...r, status: {sample: S.sample, W: S.W, H: S.H, cloud: S.cloudInfo, band: S.band, cloudMs: S.cloudMs, adapter: R.adapterInfo || null}}, [r.rgba.buffer]); }
    else if (m.type === 'export') startExport(m);
    else if (m.type === 'exportCancel') cancelExport();
    else if (m.type === 'shadowMatte') shadowMatte(m);
    else if (m.type === 'volExport') volExport(m);
    else if (m.type === 'volCancel'){ if (S.vx) S.vx.cancelled = true; }
    else if (m.type === 'smCancel'){ if (S.sm) S.sm.cancelled = true; }
    else if (m.type === 'readback'){ const r = await readback(); post({type:'pixels', id: m.id, W: r.W, H: r.H, xyz: r.xyz}, [r.xyz.buffer]); }
  } catch (err){ fail(err && err.message || err); }
};
