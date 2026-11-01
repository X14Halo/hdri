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
  {title:'Scene file', items:[
    {type:'buttons', btns:[['Save scene', () => saveScene()], ['Load scene', () => loadScene()]]},
    {type:'buttons', btns:[['Mark issues', () => toggleMarking()], ['Clear marks', () => { MARKS.length = 0; drawMarks(); }], ['Save report', () => saveReport()]]},
    {type:'note', html:'<span id="markInfo">To report a problem: <b>Mark issues</b>, paint over it in the view, add a note, then <b>Save report</b>. The report holds the scene, the marks, the view and a picture, so it can be reproduced exactly.</span><textarea id="noteBox" class="notebox" placeholder="What looks wrong? (optional)"></textarea>'},
  ]},
  {title:'Randomize', items:[
    {k:'rndStyle', label:'Character', min:0, max:1, step:0.01, fmt:v => v < 0.15 ? 'realistic' : v < 0.5 ? 'realistic, some drama' : v < 0.85 ? 'stylized' : 'very stylized'},
    {type:'buttons', btns:[['Everything', () => randomize('all')], ['Clouds', () => randomize('clouds')], ['Time of day', () => randomize('sun')]]},
  ]},
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
function sendView(extra){ if (!worker) return; worker.postMessage({type:'view', view:{...view, ...extra}}); if (MARKS.length) drawMarks(); }

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
function resize(){ const [w, h] = canvasSize(); sendView({cw:w, ch:h}); drawOverlay(); drawMarks(); }
new ResizeObserver(resize).observe($('#view'));
let drag = null;
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); if (marking){ markStroke = {r: 0.006, pts: []}; MARKS.push(markStroke); addMark(e); return; } drag = {x:e.clientX, y:e.clientY, yaw:view.yaw, pitch:view.pitch, moved:false}; });
cv.addEventListener('pointermove', e => { if (marking){ if (markStroke) addMark(e); return; } if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (view.mode === 1 && drag.moved){ const k = view.fov/cv.getBoundingClientRect().height; view.yaw = drag.yaw - dx*k; view.pitch = clamp(drag.pitch + dy*k, -1.5, 1.5); sendView(); }
  else if (view.mode !== 1 && P.mode === 'manual') placeSun(e); });
cv.addEventListener('pointerup', e => { if (marking){ markStroke = null; return; } if (drag && !drag.moved && view.mode !== 1 && P.mode === 'manual') placeSun(e); drag = null; });
cv.addEventListener('wheel', e => { if (view.mode !== 1) return; e.preventDefault(); view.fov = clamp(view.fov*Math.exp(e.deltaY*0.001), 10*D2R, 140*D2R); sendView(); }, {passive:false});
function placeSun(e){ const pr = panoRect(), r = $('#view').getBoundingClientRect(); const u = (e.clientX - r.left - pr.x)/pr.w, v = (e.clientY - r.top - pr.y)/pr.h; if (u < 0 || u > 1 || v < 0 || v > 1) return;
  P.sunAz = ((((u - 0.5)*360 + P.azOff) % 360) + 360) % 360; P.sunEl = clamp((0.5 - v)*180, -20, 90); changed(); }
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('on', x === b)); view.mode = +b.dataset.v; $('#legend').hidden = view.mode !== 2; sendView(); drawOverlay(); });
document.querySelectorAll('#resSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#resSeg button').forEach(x => x.classList.toggle('on', x === b)); P.previewRes = +b.dataset.r; changed(); });
$('#autoEx').onchange = e => { view.auto = e.target.checked; sendView(); };
$('#exSlider').oninput = e => { view.expoComp = +e.target.value; $('#exVal').textContent = `${view.expoComp >= 0 ? '+' : '−'}${Math.abs(view.expoComp).toFixed(1)} EV`; sendView(); };

/* ---------- scene files and issue reports ---------- */
const MARKS = []; let marking = false, markStroke = null;
function toggleMarking(){ marking = !marking; $('#view').classList.toggle('marking', marking);
  const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Mark issues' || x.textContent === 'Done marking'); if (b) b.textContent = marking ? 'Done marking' : 'Mark issues';
  setStatus(marking ? 'Marking: paint over the problem areas' : 'Marking off'); }
// screen ↔ panorama (u across from the left, v down from the top), as the display shader maps them
function lookBasis(){ const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const fwd = [sy*cp, sp, cy*cp], right = [cy, 0, -sy], up = [right[1]*fwd[2] - right[2]*fwd[1], right[2]*fwd[0] - right[0]*fwd[2], right[0]*fwd[1] - right[1]*fwd[0]]; return {fwd, right, up}; }
function screenToUV(x, y){ const r = $('#view').getBoundingClientRect();
  if (view.mode !== 1){ const pr = panoRect(); const u = (x - pr.x)/pr.w, v = (y - pr.y)/pr.h; return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null; }
  const nx = x/r.width*2 - 1, ny = 1 - y/r.height*2, tf = Math.tan(view.fov/2), B = lookBasis();
  let d = [0, 1, 2].map(i => B.fwd[i] + B.right[i]*nx*tf*r.width/r.height + B.up[i]*ny*tf); const l = Math.hypot(...d); d = d.map(c => c/l);
  const az = Math.atan2(d[0], d[2]) - P.azOff*D2R, el = Math.asin(clamp(d[1], -1, 1)); return [((az/(2*Math.PI) + 0.5) % 1 + 1) % 1, 0.5 - el/Math.PI]; }
function uvToScreen(u, v){ const r = $('#view').getBoundingClientRect();
  if (view.mode !== 1){ const pr = panoRect(); return [pr.x + u*pr.w, pr.y + v*pr.h, pr.w]; }
  const az = (u - 0.5)*2*Math.PI + P.azOff*D2R, el = (0.5 - v)*Math.PI, d = [Math.cos(el)*Math.sin(az), Math.sin(el), Math.cos(el)*Math.cos(az)], B = lookBasis();
  const dz = d[0]*B.fwd[0] + d[1]*B.fwd[1] + d[2]*B.fwd[2]; if (dz <= 0.05) return null; const tf = Math.tan(view.fov/2);
  const dx = (d[0]*B.right[0] + d[1]*B.right[1] + d[2]*B.right[2])/dz, dy = (d[0]*B.up[0] + d[1]*B.up[1] + d[2]*B.up[2])/dz;
  return [(dx/(tf*r.width/r.height)*0.5 + 0.5)*r.width, (0.5 - dy/tf*0.5)*r.height, r.height/(tf*2)*2*Math.PI]; }
function addMark(e){ const r = $('#view').getBoundingClientRect(), uv = screenToUV(e.clientX - r.left, e.clientY - r.top); if (!uv || !markStroke) return; markStroke.pts.push([+uv[0].toFixed(5), +uv[1].toFixed(5)]); drawMarks(); }
function drawMarks(){ const c = $('#markCv'), r = $('#view').getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== Math.round(r.width*dpr) || c.height !== Math.round(r.height*dpr)){ c.width = Math.round(r.width*dpr); c.height = Math.round(r.height*dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height); g.fillStyle = 'rgba(255,40,80,0.45)';
  for (const s of MARKS) for (const [u, v] of s.pts){ const p = uvToScreen(u, v); if (!p) continue; g.beginPath(); g.arc(p[0], p[1], Math.max(3, s.r*p[2]), 0, 2*Math.PI); g.fill(); } }
async function saveFile(name, text){
  const dl = await claudeDownloads();
  if (dl){ try { await dl.save({filename: name, data: text}); setStatus('Saved ' + name); } catch (e){ setStatus(e && e.code === 'declined' ? 'Save declined' : `Could not save (${e && e.code || e})`); } return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); setStatus('Saved ' + name); }
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
function saveScene(){ saveFile(`sky_scene_${stamp()}.json`, JSON.stringify({kind: 'spectral-sky-scene', build: BUILD, saved: new Date().toISOString(), P, view}, null, 1)); }
function loadScene(){ const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.P) throw new Error('no settings in this file');
    Object.assign(P, j.P); if (j.view) Object.assign(view, j.view); MARKS.length = 0; if (j.marks) MARKS.push(...j.marks); sendView(); syncUI(); changed(); drawOverlay(); drawMarks(); setStatus('Loaded ' + f.name); }
    catch (e){ setStatus('Could not read that file: ' + e.message); } };
  inp.click(); }
async function saveReport(){
  if (!worker || !ready) return; setStatus('Preparing report…');
  const m = await new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type: 'snap', id, w: 2048}); });
  const c = document.createElement('canvas'); c.width = m.w; c.height = m.h; const g = c.getContext('2d'); const id = g.createImageData(m.w, m.h); id.data.set(m.rgba); g.putImageData(id, 0, 0);
  g.strokeStyle = 'rgba(255,40,80,0.9)'; g.lineWidth = 3;
  for (const s of MARKS) for (const [u, v] of s.pts){ g.beginPath(); g.arc(u*m.w, v*m.h, Math.max(4, s.r*m.w), 0, 2*Math.PI); g.stroke(); }
  const img = c.toDataURL('image/jpeg', 0.88);
  const rep = {kind: 'spectral-sky-report', build: BUILD, saved: new Date().toISOString(), note: $('#noteBox').value || '', P, view, marks: MARKS, status: {...(lastStatus || {}), ...(m.status || {})}, ua: navigator.userAgent, image: img};
  await saveFile(`sky_report_${stamp()}.json`, JSON.stringify(rep));
}

/* ---------- randomize ---------- */
// Realistic: what skies actually do. Times of day weighted by how long the sun spends there; a weather regime drawn by how
// common it is, with its layers at heights and covers that go together (cumulus bases at the condensation level from the
// humidity, ~125 m per °C of dewpoint depression; no towering cumulus at dawn; overcast decks hiding the layers above);
// haze from typical aerosol loads. Stylized: golden hour and twilight, layered and towering skies, unusual air, more often.
function randomize(what){
  const st = clamp(P.rndStyle ?? 0.25, 0, 1), R = Math.random, U = (a, b) => a + (b - a)*R(), G = () => Math.sqrt(-2*Math.log(Math.max(R(), 1e-9)))*Math.cos(2*Math.PI*R());
  const pick = arr => { let t = R()*arr.reduce((s, a) => s + Math.max(a[0], 0), 0); for (const a of arr){ t -= Math.max(a[0], 0); if (t <= 0) return a[1]; } return arr[arr.length - 1][1]; };
  const seed = () => 1 + Math.floor(R()*99991);
  if (what === 'all' || what === 'sun'){
    P.mode = 'manual';
    const tod = pick([[1 - 0.65*st, 'day'], [0.22 + 0.5*st, 'golden'], [0.07 + 0.3*st, 'twilight'], [0.04 + 0.08*st, 'night']]);
    P.sunEl = tod === 'day' ? 15 + 55*Math.pow(R(), 1.3) : tod === 'golden' ? U(0.5, 15) : tod === 'twilight' ? U(-6, 0.5) : U(-25, -10);
    P.sunAz = U(0, 360); P.moonEl = U(-30, 70); P.moonAz = U(0, 360);
  }
  if (what === 'all'){
    P.aerosol = pick([[5, 'continental'], [3, 'maritime'], [1 + st, 'urban'], [0.3 + 1.2*st, 'desert'], [0.2 + 1.2*st, 'smoke'], [1, 'clean']]);
    const aodMed = {continental: 0.1, maritime: 0.08, urban: 0.25, desert: 0.35, smoke: 0.5, clean: 0.04}[P.aerosol];   // (typical loads of each)
    P.aod = clamp(aodMed*Math.exp(G()*(0.5 + 0.4*st)), 0.02, 1.5);
    P.humidity = Math.round(clamp(U(30, 85) + G()*8*st, 10, 95));
    P.aerH = U(0.8, 2.2);
    P.fogVis = R() < 0.03 + 0.12*st && P.sunEl < 20 ? Math.exp(U(Math.log(0.4), Math.log(8))) : 50; P.fogH = U(0.05, 0.4);
    P.ozone = Math.round(U(270, 360));
  }
  if (what === 'all' || what === 'clouds'){
    const hi = P.sunEl > 25;   // (deep convection builds in the afternoon heat)
    const reg = pick([[1.2 - 0.8*st, 'clear'], [4 - 1.5*st, 'fair'], [2, 'cuci'], [(hi ? 1.2 : 0.2) + 2*st, 'congestus'], [1.5, 'ac'], [1.5, 'scbroken'], [0.9, 'overcast'], [1.3, 'ci'], [0.4 + 3*st, 'layered']]);
    const ang = U(0, 2*Math.PI), spd = U(5, 30 + 25*st); P.windX = Math.round(spd*Math.cos(ang)); P.windZ = Math.round(spd*Math.sin(ang));
    P.cuOn = P.scOn = P.acOn = P.ciOn = false;
    P.cuSeed = seed(); P.scSeed = seed(); P.acSeed = seed(); P.ciSeed = seed();
    const lcl = clamp(0.025*(100 - P.humidity) + G()*0.1, 0.4, 3.2);   // km
    const cu = (cov, dev) => { P.cuOn = true; P.cuCover = clamp(cov, 0.03, 0.85); P.cuDev = clamp(dev, 0, 1); P.cuBase = +lcl.toFixed(2);
      P.cuSize = clamp(U(0.8, 1.25) + G()*0.15*st, 0.5, 2); P.cuOrg = U(0.2, 0.85); P.cuStreets = R() < 0.15 + 0.15*st ? U(0.3, 0.9) : 0; P.cuShear = U(0.2, 1.1 + 0.6*st); };
    const ci = (cov) => { P.ciOn = true; P.ciCover = clamp(cov, 0.05, 0.9); P.ciBase = U(7.5, 11); P.ciForm = U(0.2, 0.75); P.ciThick = U(0.4, 1.2); P.ciFall = U(0.5, 2.5); P.ciShear = U(0.5, 2); P.ciCell = U(0.8, 2.5); P.ciDens = U(0.7, 1.6 + st); };
    const ac = (cov) => { P.acOn = true; P.acCover = clamp(cov, 0.1, 0.95); P.acBase = U(2.8, 6); P.acForm = U(0.4, 1); P.acThick = U(0.2, 0.6); P.acCell = U(0.3, 1.2); };
    const sc = (cov, form) => { P.scOn = true; P.scCover = clamp(cov, 0.2, 1); P.scForm = form; P.scBase = +clamp(lcl*0.8, 0.3, 2).toFixed(2); P.scThick = U(0.25, 0.7); P.scCell = U(0.9, 2.5); };
    if (reg === 'fair') { cu(U(0.08, 0.4), U(0, 0.3)); if (R() < 0.25) ci(U(0.05, 0.3)); }
    else if (reg === 'cuci') { cu(U(0.1, 0.35), U(0.05, 0.4)); ci(U(0.15, 0.6)); }
    else if (reg === 'congestus') { cu(U(0.15, 0.45), U(0.4, 0.75 + 0.25*st)); if (R() < 0.4) ci(U(0.1, 0.4)); }
    else if (reg === 'ac') { ac(U(0.25, 0.75)); if (R() < 0.5) cu(U(0.05, 0.25), U(0, 0.25)); if (R() < 0.3) ci(U(0.1, 0.4)); }
    else if (reg === 'scbroken') { sc(U(0.45, 0.8), U(0.35, 0.95)); if (R() < 0.3) ac(U(0.2, 0.5)); }
    else if (reg === 'overcast') { sc(U(0.88, 1), U(0.05, 0.45)); }
    else if (reg === 'ci') { ci(U(0.15, 0.8)); }
    else if (reg === 'layered') { cu(U(0.1, 0.4), U(0.1, 0.6 + 0.3*st)); ac(U(0.2, 0.6)); ci(U(0.2, 0.7)); }
  }
  syncUI(); changed();
}

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
    else if (m.type === 'shot' || m.type === 'snap'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
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
