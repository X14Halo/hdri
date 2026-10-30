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
  {title:'Clouds', items:[
    {type:'note', html:'The new cloud engine is being built: every cloud type as its own layer you can switch off or adjust, all of them in one 3D volume lit the same way. They arrive in the next phase.'},
  ]},
];

/* ---------- panel ---------- */
const CTRL = [];
function sliderPos(it, v){ return it.log ? Math.log(v/it.min)/Math.log(it.max/it.min) : v; }
function sliderVal(it, x){ return it.log ? it.min*Math.pow(it.max/it.min, x) : x; }
function buildPanel(){
  const panel = $('#panel'); panel.innerHTML = '';
  for (const sec of SECTIONS){
    const el = document.createElement('section'); el.className = 'sec'; el.innerHTML = `<h2>${sec.title}</h2>`; const rows = document.createElement('div'); rows.className = 'rows'; el.appendChild(rows);
    for (const it of sec.items){
      const row = document.createElement('div'); row.className = 'row'; rows.appendChild(row);
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
      setStatus(m.done ? `${m.W}×${m.H} · ${m.sample} samples · ${(m.total/1000).toFixed(1)} s` : `${m.W}×${m.H} · sample ${m.sample + 1}/${m.target} · ${Math.round(m.row/m.H*100)}%`); }
    else if (m.type === 'error'){ console.error(m.message); setStatus('Error'); $('#loader').classList.remove('gone'); $('#ldTitle').textContent = 'Something went wrong'; $('#ldStep').textContent = m.message.slice(0, 400); window.__sky.error = m.message; }
    else if (m.type === 'shot'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'pixels'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); } };
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
  shot: () => new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type:'shot', id}); }),
};
start();
