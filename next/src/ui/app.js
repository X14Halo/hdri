// Spectral Sky Next — UI thread: the settings panel, the view, and messages to the render worker.
'use strict';
const $ = s => document.querySelector(s);
const P = JSON.parse(JSON.stringify(DEFAULTS));
try { const q = new URLSearchParams(location.search).get('p'); if (q) Object.assign(P, JSON.parse(q)); } catch (e){}
const view = {mode:0, yaw:0, pitch:0.1, fov:75*D2R, expoComp:0, auto:true};
let worker = null, lastStatus = null, ready = false;

/* ---------- panel schema ---------- */
const fmtDeg = v => `${(+v).toFixed(1)}°`;
const SECTIONS = [
  {title:'Sun & moon', items:[
    {k:'mode', label:'Position from', type:'select', opts:[['manual', 'Set by hand'], ['location', 'Place, date and time']]},
    {k:'sunEl', label:'Sun elevation', min:-20, max:90, step:0.1, fmt:fmtDeg, show:() => P.mode === 'manual'},
    {k:'sunAz', label:'Sun azimuth', min:0, max:360, step:0.5, fmt:fmtDeg, show:() => P.mode === 'manual'},
    {k:'moonEl', label:'Moon elevation', min:-20, max:90, step:0.1, fmt:fmtDeg, show:() => P.mode === 'manual'},
    {k:'moonAz', label:'Moon azimuth', min:0, max:360, step:0.5, fmt:fmtDeg, show:() => P.mode === 'manual'},
    {k:'date', label:'Date', type:'date', show:() => P.mode === 'location'},
    {k:'time', label:'Local time', type:'time', show:() => P.mode === 'location'},
    {k:'utc', label:'UTC offset (h)', type:'number', min:-12, max:14, step:0.5, show:() => P.mode === 'location'},
    {k:'lat', label:'Latitude', min:-90, max:90, step:0.1, fmt:fmtDeg, show:() => P.mode === 'location'},
    {k:'lon', label:'Longitude', min:-180, max:180, step:0.1, fmt:fmtDeg, show:() => P.mode === 'location'},
    {k:'moonOverride', label:'Set the moon phase by hand', type:'check'},
    {k:'moonIllum', label:'Moon illuminated', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.moonOverride},
  ]},
  {title:'Air', items:[
    {k:'aerosol', label:'Aerosol type', type:'select', opts:Object.entries(AEROSOLS).map(([k, a]) => [k, a.name])},
    {k:'aod', label:'Haze (aerosol optical depth, 550 nm)', min:0.01, max:2, log:true, fmt:v => v.toFixed(3)},
    {k:'humidity', label:'Relative humidity', min:5, max:97, step:1, fmt:v => `${Math.round(v)}%`},
    {k:'aerH', label:'Haze layer height', min:0.3, max:4, step:0.05, fmt:v => `${v.toFixed(2)} km`},
    {k:'ozone', label:'Ozone', min:200, max:500, step:5, fmt:v => `${Math.round(v)} DU`},
    {k:'fogVis', label:'Fog or mist (visibility)', min:0.05, max:50, log:true, fmt:v => v >= 49.5 ? 'none' : v < 1 ? `${Math.round(v*1000)} m` : `${v.toFixed(1)} km`},
    {k:'fogH', label:'Fog depth', min:0.02, max:1, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.fogVis < 49.5},
    {k:'diurnal', label:'Morning mist and evening haze follow the sun', type:'check'},
    {k:'siteAlt', label:'Ground altitude', min:0, max:5, step:0.05, fmt:v => `${Math.round(v*1000)} m`},
  ]},
  {title:'Ground', items:[
    {k:'surface', label:'Surface', type:'select', opts:Object.entries(SURFACES).map(([k, s]) => [k, s.name])},
    {k:'albedo', label:'Albedo', min:0, max:1, step:0.01, fmt:v => v.toFixed(2), show:() => P.surface === 'grey'},
    {k:'groundMode', label:'Below the horizon', type:'select', opts:[['lit', 'Lit ground'], ['black', 'Black (sky only)']]},
    {k:'camH', label:'Camera height', min:0.001, max:3, log:true, fmt:v => v < 1 ? `${Math.round(v*1000)} m` : `${v.toFixed(2)} km`},
  ]},
  {title:'Night sky', items:[
    {k:'stars', label:'Stars', type:'check'},
    {k:'starMag', label:'Faintest stars', min:2, max:7.5, step:0.1, fmt:v => `mag ${v.toFixed(1)}`, show:() => P.stars},
    {k:'mw', label:'Milky Way', min:0, max:2, step:0.05, fmt:v => v.toFixed(2)},
    {k:'airglow', label:'Airglow', min:0, max:3, step:0.05, fmt:v => v.toFixed(2)},
  ]},
  {title:'Cumulus', layer:'cuOn', items:[
    {k:'cuOn', label:'Cumulus layer', type:'check'},
    {k:'cuCover', label:'Cloud cover', min:0, max:0.9, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.cuOn},
    {k:'cuDev', label:'Development', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'fair weather' : v < 0.45 ? 'moderate (mediocris)' : v < 0.75 ? 'towering (congestus)' : 'deep convection', show:() => P.cuOn},
    {k:'cuBase', label:'Cloud base', min:0.3, max:3.5, step:0.05, fmt:v => `${Math.round(v*1000)} m`, show:() => P.cuOn},
    {k:'cuSize', label:'Cloud size', min:0.4, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.cuOn},
    {k:'cuOrg', label:'Grouping', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'evenly scattered' : v < 0.6 ? 'loosely grouped' : 'clustered, with clear gaps', show:() => P.cuOn},
    {k:'cuStreets', label:'Cloud streets (lined up with the wind)', min:0, max:1, step:0.01, fmt:v => v < 0.05 ? 'none' : `${Math.round(v*100)}%`, show:() => P.cuOn},
    {k:'cuShear', label:'Wind shear (tops lean downwind)', min:0, max:2, step:0.01, fmt:v => v.toFixed(2), show:() => P.cuOn},
    {k:'cuErode', label:'Edge detail', min:0, max:2, step:0.01, fmt:v => v.toFixed(2), show:() => P.cuOn},
    {k:'cuDens', label:'Water content (density)', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.cuOn},
    {type:'buttons', btns:[['New clouds', () => { P.cuSeed = (P.cuSeed*7919 + 31) % 100003; changed(); }]], show:() => P.cuOn},
  ]},
  {title:'Wind', items:[
    {k:'windX', label:'From west (+) / east (−)', min:-60, max:60, step:1, fmt:v => `${Math.round(v)} km/h`},
    {k:'windZ', label:'From south (+) / north (−)', min:-60, max:60, step:1, fmt:v => `${Math.round(v)} km/h`},
  ]},
  {title:'Stratocumulus · stratus', items:[
    {k:'scOn', label:'Low cloud deck', type:'check'},
    {k:'scCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.scOn},
    {k:'scForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.15 ? 'stratus (featureless)' : v < 0.55 ? 'stratocumulus (closed cells)' : 'stratocumulus (open cells, broken)', show:() => P.scOn},
    {k:'scBase', label:'Base', min:0.1, max:2.5, step:0.05, fmt:v => `${Math.round(v*1000)} m`, show:() => P.scOn},
    {k:'scThick', label:'Thickness', min:0.1, max:1.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.scOn},
    {k:'scCell', label:'Cell size', min:0.4, max:5, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.scOn},
    {k:'scDens', label:'Water content (density)', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.scOn},
    {type:'buttons', btns:[['New pattern', () => { P.scSeed = (P.scSeed*7919 + 31) % 100003; changed(); }]], show:() => P.scOn},
  ]},
  {title:'Altocumulus · altostratus', items:[
    {k:'acOn', label:'Mid-level layer', type:'check'},
    {k:'acCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.acOn},
    {k:'acForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'altostratus (grey veil)' : v < 0.6 ? 'altostratus breaking into cloudlets' : 'altocumulus (cloudlets in rows)', show:() => P.acOn},
    {k:'acBase', label:'Base', min:2, max:7, step:0.05, fmt:v => `${v.toFixed(2)} km`, show:() => P.acOn},
    {k:'acThick', label:'Thickness', min:0.1, max:2.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.acOn},
    {k:'acCell', label:'Cloudlet size', min:0.2, max:2, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.acOn},
    {k:'acDens', label:'Density', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.acOn},
    {type:'buttons', btns:[['New pattern', () => { P.acSeed = (P.acSeed*7919 + 31) % 100003; changed(); }]], show:() => P.acOn},
  ]},
  {title:'Cirrus · cirrostratus · cirrocumulus', items:[
    {k:'ciOn', label:'High ice-cloud layer', type:'check'},
    {k:'ciCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.ciOn},
    {k:'ciForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'cirrostratus (veil)' : v < 0.65 ? 'cirrus (fibres and fall streaks)' : 'cirrocumulus (ripples)', show:() => P.ciOn},
    {k:'ciBase', label:'Height', min:6, max:13, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {k:'ciThick', label:'Thickness', min:0.2, max:2.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.ciOn},
    {k:'ciFall', label:'Fall streak length', min:0, max:3, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {k:'ciShear', label:'Wind shear (streak curve)', min:0, max:3, step:0.01, fmt:v => v.toFixed(2), show:() => P.ciOn},
    {k:'ciCell', label:'Pattern scale', min:0.4, max:5, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {k:'ciDens', label:'Optical thickness', min:0.2, max:4, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.ciOn},
    {type:'buttons', btns:[['New pattern', () => { P.ciSeed = (P.ciSeed*7919 + 31) % 100003; changed(); }]], show:() => P.ciOn},
  ]},
  {title:'Export', items:[
    {k:'outRes', label:'Size', type:'select', opts:[[2048, '2K · 2048 × 1024'], [4096, '4K · 4096 × 2048'], [8192, '8K · 8192 × 4096'], [16384, '16K · 16384 × 8192']]},
    {k:'outSpp', label:'Samples per pixel', type:'select', opts:[[16, '16 (draft)'], [32, '32'], [64, '64'], [128, '128'], [256, '256 (final)']]},
    {k:'format', label:'File', type:'select', opts:[['exr32', 'OpenEXR, 32-bit float'], ['exr16', 'OpenEXR, 16-bit half'], ['hdr', 'Radiance HDR']]},
    {k:'units', label:'Units', type:'select', opts:[['nits', 'Luminance (cd/m², physical)'], ['watts', 'Radiance (W·m⁻²·sr⁻¹ equivalent)']]},
    {type:'buttons', btns:[['Render and download', () => startExport()], ['Cancel', () => cancelExport()]]},
    {type:'note', html:'<span id="expInfo">Linear Rec.709 (sRGB primaries), equirectangular, north in the middle. The preview pauses while the export renders. Half floats clip above 65 504, which in physical units the sun disc far exceeds.</span>'},
  ]},
];

/* ---------- panel ---------- */
const CTRL = [];
function sliderPos(it, v){ return it.log ? Math.log(v/it.min)/Math.log(it.max/it.min) : v; }
function sliderVal(it, x){ return it.log ? it.min*Math.pow(it.max/it.min, x) : x; }
function buildPanel(){
  const panel = $('#panel'); panel.innerHTML = '';
  for (const sec of SECTIONS){
    const el = document.createElement('section'); el.className = 'sec'; if (sec.hidden && sec.hidden()) el.hidden = true; el.innerHTML = `<h2>${sec.title}</h2>`; const rows = document.createElement('div'); rows.className = 'rows'; el.appendChild(rows);
    for (const it of sec.items){
      const row = document.createElement('div'); row.className = 'row'; rows.appendChild(row);
      if (it.type === 'buttons'){ row.classList.add('full'); row.innerHTML = `<div class="btns">${it.btns.map((b, i) => `<button class="btn" data-i="${i}">${b[0]}</button>`).join('')}</div>`;
        row.querySelectorAll('button').forEach(bt => bt.onclick = () => it.btns[+bt.dataset.i][1]()); CTRL.push({it, row}); continue; }
      if (it.type === 'note'){ row.classList.add('full'); row.innerHTML = `<div class="note">${it.html}</div>`; CTRL.push({it, row}); continue; }
      const id = 'c_' + it.k;
      if (it.type === 'select'){ row.innerHTML = `<label for="${id}">${it.label}</label><select id="${id}">${it.opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
        const s = row.querySelector('select'); s.onchange = () => { P[it.k] = s.value; changed(); }; CTRL.push({it, row, set:() => { s.value = P[it.k]; }}); }
      else if (it.type === 'check'){ row.innerHTML = `<label for="${id}">${it.label}</label><input type="checkbox" id="${id}">`;
        const c = row.querySelector('input'); c.onchange = () => { P[it.k] = c.checked; changed(); }; CTRL.push({it, row, set:() => { c.checked = !!P[it.k]; }}); }
      else if (it.type === 'date' || it.type === 'time' || it.type === 'number'){ row.innerHTML = `<label for="${id}">${it.label}</label><input type="${it.type}" id="${id}" ${it.step ? `step="${it.step}"` : ''}>`;
        const c = row.querySelector('input'); c.onchange = () => { P[it.k] = it.type === 'number' ? +c.value : c.value; changed(); }; CTRL.push({it, row, set:() => { c.value = P[it.k]; }}); }
      else { // range
        row.innerHTML = `<label for="${id}">${it.label}</label><span class="val"></span><input type="range" id="${id}">`;
        const r = row.querySelector('input'), val = row.querySelector('.val');
        if (it.log){ r.min = 0; r.max = 1; r.step = 0.001; } else { r.min = it.min; r.max = it.max; r.step = it.step || 0.01; }
        r.oninput = () => { P[it.k] = sliderVal(it, +r.value); val.textContent = it.fmt ? it.fmt(P[it.k]) : P[it.k]; changed(true); };
        CTRL.push({it, row, set:() => { r.value = sliderPos(it, P[it.k]); val.textContent = it.fmt ? it.fmt(P[it.k]) : P[it.k]; }});
      }
    }
    panel.appendChild(el);
  }
  syncUI();
}
function syncUI(){ for (const c of CTRL){ if (c.set) c.set(); c.row.hidden = c.it.show ? !c.it.show() : false; } }

/* ---------- talking to the worker ---------- */
let sendPending = false;
function changed(fromSlider){ if (!fromSlider) syncUI(); else for (const c of CTRL) c.row.hidden = c.it.show ? !c.it.show() : false;
  if (sendPending) return; sendPending = true; requestAnimationFrame(() => { sendPending = false; sendParams(); }); }
function sendParams(){ if (worker) worker.postMessage({type:'params', P}); drawOverlay(); }
function sendView(extra){ if (!worker) return; worker.postMessage({type:'view', view:{...view, ...extra}}); }

function setStatus(t){ $('#status').textContent = t; }
function readouts(st){
  const d = st.derived || {}, m = st.meter || {}; const lux = v => v >= 1000 ? `${(v/1000).toFixed(1)} klx` : v >= 1 ? `${v.toFixed(1)} lx` : `${v.toPrecision(2)} lx`;
  const items = [['Sun', `${(d.sunEl ?? 0).toFixed(1)}° <small>az ${(d.sunAz ?? 0).toFixed(0)}°</small>`], ['Moon', `${(d.moonEl ?? 0).toFixed(1)}° <small>${Math.round((d.illum ?? 0)*100)}% lit</small>`],
    ['Visibility', d.vis ? `${d.vis >= 10 ? d.vis.toFixed(0) : d.vis.toFixed(1)} km` : '–'], ['Ground light', m.E ? `${lux(m.E)} <small>${lux(m.Ed || 0)} direct</small>` : '–'], ['Humidity', d.RHp ? `${Math.round(d.RHp)}%` : '–']];
  $('#readouts').innerHTML = items.map(([k, v]) => `<div class="ro"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

/* ---------- view: overlay (compass, horizon), dragging, sizing ---------- */
const cv = $('#gl');
function canvasSize(){ const r = $('#view').getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2); return [Math.max(1, Math.round(r.width*dpr)), Math.max(1, Math.round(r.height*dpr)), r]; }
function panoRect(){ const [, , r] = canvasSize(); let w = r.width, h = w/2; if (h > r.height){ h = r.height; w = h*2; } return {x:(r.width - w)/2, y:(r.height - h)/2, w, h}; }
function drawOverlay(){
  const ov = $('#overlay'); if (view.mode === 1){ ov.innerHTML = ''; return; }
  const pr = panoRect(); let html = `<div class="hline" style="left:${pr.x}px;width:${pr.w}px;top:${pr.y + pr.h/2}px"></div>`;
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((n, i) => { const az = i*45; const u = (((az - P.azOff)/360 + 0.5) % 1 + 1) % 1; html += `<div class="compass" style="left:${pr.x + u*pr.w}px;top:${pr.y + pr.h/2 + 4}px">${n}</div>`; });
  ov.innerHTML = html; }
function resize(){ const [w, h] = canvasSize(); sendView({cw:w, ch:h}); drawOverlay(); }
new ResizeObserver(resize).observe($('#view'));
let drag = null;
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = {x:e.clientX, y:e.clientY, yaw:view.yaw, pitch:view.pitch, moved:false}; });
cv.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (view.mode === 1 && drag.moved){ const k = view.fov/cv.getBoundingClientRect().height; view.yaw = drag.yaw - dx*k; view.pitch = clamp(drag.pitch + dy*k, -1.5, 1.5); sendView(); }
  else if (view.mode !== 1 && P.mode === 'manual') placeSun(e); });
cv.addEventListener('pointerup', e => { if (drag && !drag.moved && view.mode !== 1 && P.mode === 'manual') placeSun(e); drag = null; });
cv.addEventListener('wheel', e => { if (view.mode !== 1) return; e.preventDefault(); view.fov = clamp(view.fov*Math.exp(e.deltaY*0.001), 10*D2R, 140*D2R); sendView(); }, {passive:false});
function placeSun(e){ const pr = panoRect(), r = $('#view').getBoundingClientRect(); const u = (e.clientX - r.left - pr.x)/pr.w, v = (e.clientY - r.top - pr.y)/pr.h; if (u < 0 || u > 1 || v < 0 || v > 1) return;
  P.sunAz = ((((u - 0.5)*360 + P.azOff) % 360) + 360) % 360; P.sunEl = clamp((0.5 - v)*180, -20, 90); changed(); }
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('on', x === b)); view.mode = +b.dataset.v; $('#legend').hidden = view.mode !== 2; sendView(); drawOverlay(); });
document.querySelectorAll('#resSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#resSeg button').forEach(x => x.classList.toggle('on', x === b)); P.previewRes = +b.dataset.r; changed(); });
$('#autoEx').onchange = e => { view.auto = e.target.checked; sendView(); };
$('#exSlider').oninput = e => { view.expoComp = +e.target.value; $('#exVal').textContent = `${view.expoComp >= 0 ? '+' : '−'}${Math.abs(view.expoComp).toFixed(1)} EV`; sendView(); };

/* ---------- export ---------- */
let EXP = null;
function startExport(){
  if (EXP || !worker || !ready) return;
  const W = +P.outRes, H = W/2, spp = +P.outSpp; let rgb;
  try { rgb = new Float32Array(W*H*3); } catch (e){ $('#expInfo').textContent = 'Not enough memory for this size: choose a smaller one.'; return; }
  EXP = {W, H, rgb, format: P.format, name: `sky_el${Math.round(P.sunEl)}_az${Math.round(P.sunAz)}_${W}`, t0: performance.now()};
  $('#expInfo').textContent = `Rendering ${W} × ${H} at ${spp} samples…`;
  worker.postMessage({type:'export', W, spp, units: P.units});
}
function cancelExport(){ if (!EXP) return; worker.postMessage({type:'exportCancel'}); EXP = null; $('#expInfo').textContent = 'Export cancelled.'; }
const fmtSecs = s => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s/60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
async function finishExport(secs){
  const X = EXP; if (!X) return; EXP = null;
  $('#expInfo').textContent = 'Encoding…';
  const parts = X.format === 'hdr' ? encodeHDR(X.rgb, X.W, X.H) : await encodeEXR(X.rgb, X.W, X.H, X.format === 'exr16', f => { $('#expInfo').textContent = `Encoding… ${Math.round(f*100)}%`; });
  const fname = X.name + (X.format === 'hdr' ? '.hdr' : '.exr');
  let blob = new Blob(parts, {type: 'application/octet-stream'});
  // inside Claude the page hands files over through its downloads capability, which takes .zip but not .exr/.hdr: the
  // image goes inside a zip there; on its own (e.g. GitHub Pages) it is a plain download
  const dl = await claudeDownloads();
  if (dl){
    $('#expInfo').textContent = 'Packing into a zip…';
    blob = await zipStore(fname, new Uint8Array(await blob.arrayBuffer()));
    try { await dl.save({filename: X.name + '.zip', data: blob}); }
    catch (e){ $('#expInfo').textContent = e && e.code === 'declined' ? 'Download declined.' : `Could not save the file (${e && e.code || e}).`; return; }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  let mx = 0; for (let i = 0; i < X.rgb.length; i += 3){ const y = 0.2126*X.rgb[i] + 0.7152*X.rgb[i + 1] + 0.0722*X.rgb[i + 2]; if (y > mx) mx = y; }
  $('#expInfo').textContent = `Rendered ${X.W} × ${X.H} in ${fmtSecs(secs)} and downloaded (${(blob.size/1048576).toFixed(0)} MB). Peak ${mx.toPrecision(3)} ${P.units === 'watts' ? 'W·m⁻²·sr⁻¹' : 'cd/m²'}.`;
}
let dlNs;
async function claudeDownloads(){ if (dlNs !== undefined) return dlNs; try { dlNs = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e){ dlNs = null; } return dlNs; }
// a zip holding one file, stored (the EXR is compressed already)
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8){ let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function zipStore(name, data){
  const nm = new TextEncoder().encode(name), crc = crc32(data), n = data.length;
  const loc = new DataView(new ArrayBuffer(30)); loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint32(14, crc, true); loc.setUint32(18, n, true); loc.setUint32(22, n, true); loc.setUint16(26, nm.length, true);
  const cen = new DataView(new ArrayBuffer(46)); cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint32(16, crc, true); cen.setUint32(20, n, true); cen.setUint32(24, n, true); cen.setUint16(28, nm.length, true);
  const cdOff = 30 + nm.length + n;
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + nm.length, true); end.setUint32(16, cdOff, true);
  return new Blob([loc, nm, data, cen, nm, end], {type: 'application/zip'});
}
// OpenEXR (scanline; ZIP compression in blocks of 16 lines; channels B, G, R) and Radiance HDR writers
function toHalf(v){ const f = toHalf.f, u = toHalf.u; f[0] = v; const x = u[0]; const s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0){ if (e < -10) return s; m = (m | 0x800000) >>> (1 - e); return s | ((m + 0x1000) >>> 13); } if (e >= 31) return s | 0x7bff; return s | (e << 10) | ((m + 0x1000) >>> 13); }
toHalf.f = new Float32Array(1); toHalf.u = new Uint32Array(toHalf.f.buffer);
async function deflate(u8){ const cs = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate')); return new Uint8Array(await new Response(cs).arrayBuffer()); }
async function encodeEXR(rgb, W, H, half, onProg){
  const zip = typeof CompressionStream !== 'undefined'; const lines = zip ? 16 : 1; const bpp = half ? 2 : 4;
  const enc = new TextEncoder(); const hdr = []; const pushStr = s => hdr.push(...enc.encode(s), 0);
  const i32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); hdr.push(...b); };
  const f32v = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); hdr.push(...b); };
  hdr.push(0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0);
  pushStr('channels'); pushStr('chlist'); i32(3*(2 + 16) + 1); for (const c of ['B', 'G', 'R']){ pushStr(c); i32(half ? 1 : 2); hdr.push(0, 0, 0, 0); i32(1); i32(1); } hdr.push(0);
  pushStr('compression'); pushStr('compression'); i32(1); hdr.push(zip ? 3 : 0);
  pushStr('dataWindow'); pushStr('box2i'); i32(16); i32(0); i32(0); i32(W - 1); i32(H - 1);
  pushStr('displayWindow'); pushStr('box2i'); i32(16); i32(0); i32(0); i32(W - 1); i32(H - 1);
  pushStr('lineOrder'); pushStr('lineOrder'); i32(1); hdr.push(0);
  pushStr('pixelAspectRatio'); pushStr('float'); i32(4); f32v(1);
  pushStr('screenWindowCenter'); pushStr('v2f'); i32(8); f32v(0); f32v(0);
  pushStr('screenWindowWidth'); pushStr('float'); i32(4); f32v(1);
  hdr.push(0);
  const nChunks = Math.ceil(H/lines); const chunks = [];
  for (let c = 0; c < nChunks; c++){
    const y0 = c*lines, n = Math.min(lines, H - y0); const raw = new Uint8Array(n*W*3*bpp); const dv = new DataView(raw.buffer); let o = 0;
    for (let j = 0; j < n; j++){ const row = (y0 + j)*W*3; for (const ch of [2, 1, 0]){ for (let x = 0; x < W; x++){ const v = rgb[row + x*3 + ch];
      if (half){ dv.setUint16(o, toHalf(Math.min(v, 65504)), true); o += 2; } else { dv.setFloat32(o, v, true); o += 4; } } } }
    let data = raw;
    if (zip){ const t = new Uint8Array(raw.length); const h2 = (raw.length + 1) >> 1; for (let i = 0, a = 0, b = h2; i < raw.length; i += 2){ t[a++] = raw[i]; if (i + 1 < raw.length) t[b++] = raw[i + 1]; }
      let p = t[0]; for (let i = 1; i < t.length; i++){ const d = (t[i] - p + 384) & 255; p = t[i]; t[i] = d; }
      const z = await deflate(t); if (z.length < raw.length) data = z; }
    const head = new Uint8Array(8); const hv = new DataView(head.buffer); hv.setInt32(0, y0, true); hv.setInt32(4, data.length, true);
    chunks.push(head, data); if (c % 8 === 0){ onProg && onProg(c/nChunks); await new Promise(r => setTimeout(r, 0)); } }
  const header = new Uint8Array(hdr); const table = new Uint8Array(nChunks*8); const tv = new DataView(table.buffer);
  let off = header.length + table.length; for (let c = 0; c < nChunks; c++){ tv.setBigUint64(c*8, BigInt(off), true); off += chunks[c*2].length + chunks[c*2 + 1].length; }
  return [header, table, ...chunks]; }
function encodeHDR(rgb, W, H){
  const parts = [new TextEncoder().encode(`#?RADIANCE\n# Spectral Sky HDRI: linear Rec.709/sRGB primaries\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y ${H} +X ${W}\n`)];
  const ch = [new Uint8Array(W), new Uint8Array(W), new Uint8Array(W), new Uint8Array(W)];
  for (let y = 0; y < H; y++){
    for (let x = 0; x < W; x++){ const i = (y*W + x)*3; const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]; const v = Math.max(r, g, b);
      if (v < 1e-32){ ch[0][x] = ch[1][x] = ch[2][x] = ch[3][x] = 0; } else { let e = Math.floor(Math.log2(v)) + 1; let sc = Math.pow(2, -e)*256; if (v*sc >= 256){ e++; sc /= 2; }
        ch[0][x] = Math.floor(r*sc); ch[1][x] = Math.floor(g*sc); ch[2][x] = Math.floor(b*sc); ch[3][x] = e + 128; } }
    const out = [2, 2, W >> 8, W & 255];
    for (let c = 0; c < 4; c++) rle(ch[c], W, out);
    parts.push(new Uint8Array(out)); }
  return parts; }
function rle(d, n, out){ let cur = 0;
  while (cur < n){ let beg = cur, run = 0, old = 0;
    while (run < 4 && beg < n){ beg += run; old = run; run = 1; while (beg + run < n && run < 127 && d[beg] === d[beg + run]) run++; }
    if (old > 1 && old === beg - cur){ out.push(128 + old, d[cur]); cur = beg; }
    while (cur < beg){ let nr = beg - cur; if (nr > 128) nr = 128; out.push(nr); for (let i = 0; i < nr; i++) out.push(d[cur + i]); cur += nr; }
    if (run >= 4){ out.push(128 + run, d[beg]); cur += run; } } }

/* ---------- start ---------- */
const pending = new Map(); let rbId = 0;
function start(){
  buildPanel(); readouts({});
  if (!navigator.gpu){ $('#ldStep').textContent = 'This browser has no WebGPU.'; setStatus('No WebGPU'); return; }
  const blob = new Blob([WORKER_SRC], {type:'text/javascript'}); worker = new Worker(URL.createObjectURL(blob));
  const off = cv.transferControlToOffscreen();
  worker.onmessage = e => { const m = e.data;
    if (m.type === 'log') console.log('[worker] ' + m.text);
    else if (m.type === 'stage') $('#ldStep').textContent = m.text[0].toUpperCase() + m.text.slice(1) + '…';
    else if (m.type === 'ready'){ ready = true; $('#loader').classList.add('gone'); resize(); sendParams(); window.__sky.adapter = m.adapter; }
    else if (m.type === 'status'){ lastStatus = m; readouts(m);
      setStatus(m.done ? `${m.W}×${m.H} · ${m.sample} samples · ${(m.total/1000).toFixed(1)} s` : `${m.W}×${m.H} · sample ${m.sample + 1}/${m.target} · ${Math.round(m.row/(m.rows || m.H)*100)}%`); }
    else if (m.type === 'error'){ console.error(m.message); setStatus('Error'); $('#loader').classList.remove('gone'); $('#ldTitle').textContent = 'Something went wrong'; $('#ldStep').textContent = m.message.slice(0, 400); window.__sky.error = m.message; }
    else if (m.type === 'probe'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'shot'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'pixels'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'exportChunk'){ if (EXP && EXP.W === m.W) EXP.rgb.set(m.rgb, m.y0*m.W*3); }
    else if (m.type === 'exportProgress'){ if (EXP){ const el = m.secs, eta = m.f > 0.02 ? el/m.f - el : NaN; $('#expInfo').textContent = `Rendering ${EXP.W} × ${EXP.H}: ${Math.round(m.f*100)}%` + (isFinite(eta) ? `, about ${fmtSecs(eta)} left` : ''); setStatus(`Exporting · ${Math.round(m.f*100)}%`); } }
    else if (m.type === 'exportDone') finishExport(m.secs); };
  worker.onerror = e => { console.error('worker', e.message); $('#ldStep').textContent = 'Worker error: ' + e.message; window.__sky.error = e.message; };
  const [w, h] = canvasSize(); off.width = w; off.height = h;
  worker.postMessage({type:'init', canvas: off, noPresent: !!P.noPresent}, [off]);
}
// test hooks (used by the automated checks)
window.__sky = {
  P, view,
  set(o){ Object.assign(P, o); syncUI(); sendParams(); },
  status: () => lastStatus, ready: () => ready,
  readback: () => new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type:'readback', id}); }),
  setView(o){ Object.assign(view, o); sendView(); },
  probe: (l, alt) => new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type:'probe', id, l, alt}); }),
  shot: () => new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type:'shot', id}); }),
};
start();
