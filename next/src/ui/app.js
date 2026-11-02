// Spectral Sky Next — UI thread: the settings panel, the view, and messages to the render worker.
'use strict';
const $ = s => document.querySelector(s);
const P = JSON.parse(JSON.stringify(DEFAULTS));
try { const q = new URLSearchParams(location.search).get('p'); if (q) Object.assign(P, JSON.parse(q)); } catch (e){}
const view = {mode:0, yaw:0, pitch:0.1, fov:75*D2R, expoComp:0, auto:true, lookdev:false};
let worker = null, lastStatus = null, ready = false;

/* ---------- panel schema ---------- */
const fmtDeg = v => `${(+v).toFixed(1)}°`;
// ---------- presets: typical skies, each a few settings over the defaults ----------
const PRESETS = [
  ['Clear noon', {sunEl:62, sunAz:180, aod:0.06, humidity:40}],
  ['Fair-weather cumulus', {sunEl:46, sunAz:150, cuOn:true, cuCover:0.3, cuBase:1.2, cuDev:0.15, cuOrg:0.45, ciOn:true, ciCover:0.12, ciDens:0.6}],
  ['Cloud streets', {sunEl:40, sunAz:160, windX:25, windZ:8, cuOn:true, cuCover:0.35, cuBase:1.0, cuDev:0.1, cuStreets:0.8, cuOrg:0.2}],
  ['Dawn', {sunEl:2.5, sunAz:72, aod:0.1, humidity:72, cuOn:true, cuCover:0.06, cuBase:1.8, cuDev:0.1, ciOn:true, ciCover:0.3}],
  ['Golden hour', {sunEl:5.5, sunAz:285, aod:0.15, humidity:60, cuOn:true, cuCover:0.18, cuBase:1.6, cuDev:0.2, ciOn:true, ciCover:0.3}],
  ['Sunset', {sunEl:0.6, sunAz:292, aod:0.11, humidity:55, cuOn:true, cuCover:0.1, cuBase:2.4, cuDev:0.15, ciOn:true, ciCover:0.45}],
  ['Civil twilight', {sunEl:-4.5, sunAz:298, moonEl:18, moonAz:110, aod:0.09, ciOn:true, ciCover:0.25}],
  ['Overcast', {sunEl:38, sunAz:165, aod:0.2, humidity:85, scOn:true, scCover:0.98, scBase:0.7, scThick:0.8, scForm:0.08, scDens:1.4}],
  ['Broken stratocumulus', {sunEl:30, sunAz:200, humidity:65, scOn:true, scCover:0.66, scBase:1.0, scThick:0.5, scForm:0.4, scCell:1.6}],
  ['Open-cell stratocumulus', {sunEl:35, sunAz:140, humidity:70, aerosol:'maritime', aod:0.08, scOn:true, scCover:0.55, scBase:0.9, scThick:0.45, scForm:0.8, scCell:2.2}],
  ['Altocumulus', {sunEl:28, sunAz:220, humidity:60, acOn:true, acCover:0.7, acBase:4.4, acForm:0.9, acCell:0.8, ciOn:true, ciCover:0.2}],
  ['Mackerel sky', {sunEl:22, sunAz:250, ciOn:true, ciCover:0.6, ciForm:0.9, ciCell:1.2, acOn:true, acCover:0.35, acBase:5.5, acForm:1, acCell:0.5}],
  ['Cumulus congestus', {sunEl:45, sunAz:200, humidity:65, cuOn:true, cuCover:0.3, cuBase:1.1, cuDev:0.6, cuOrg:0.6, cuShear:0.8}],
  ['Storm building', {sunEl:24, sunAz:240, aod:0.08, humidity:60, cuOn:true, cuCover:0.4, cuBase:1.2, cuDev:0.82, cuOrg:0.8, cuShear:0.9}],
  ['Thunderhead', {sunEl:32, sunAz:215, aod:0.12, humidity:70, windX:30, windZ:5, cuOn:true, cuCover:0.3, cuBase:1.3, cuDev:0.97, cuOrg:0.9, cuClear:0.6}],
  ['Dark storm', {sunEl:28, sunAz:250, aod:0.18, humidity:85, scOn:true, scCover:0.95, scBase:0.9, scThick:1.1, scForm:0.35, scDens:2.2, cuOn:true, cuCover:0.25, cuBase:0.8, cuDev:0.6}],
  ['Hazy summer', {sunEl:55, sunAz:200, aod:0.55, humidity:75, cuOn:true, cuCover:0.08, cuDev:0.1}],
  ['Cirrus', {sunEl:30, sunAz:160, aod:0.07, ciOn:true, ciCover:0.6, ciForm:0.5, ciDens:1}],
  ['Cirrostratus veil', {sunEl:35, sunAz:170, aod:0.08, ciOn:true, ciCover:0.95, ciForm:0.05, ciDens:1.6}],
  ['Foggy morning', {sunEl:9, sunAz:100, aod:0.2, humidity:95, fogVis:0.6, fogH:0.12}],
  ['Desert dust', {sunEl:40, sunAz:210, aerosol:'desert', aod:0.9, humidity:20, aerH:2.5, surface:'sand'}],
  ['Wildfire smoke', {sunEl:20, sunAz:250, aerosol:'smoke', aod:1.6, aerH:2.2, humidity:35}],
  ['Moonlit night', {sunEl:-32, sunAz:340, moonEl:38, moonAz:165, aod:0.06, cuOn:true, cuCover:0.15, cuDev:0.1}],
  ['Starry night', {sunEl:-40, sunAz:0, moonEl:-20, aod:0.04, aerosol:'clean', humidity:35}],
];
const SECTIONS = [
  {title:'Scene file', items:[
    {type:'buttons', btns:[['Save scene', () => saveScene()], ['Load scene', () => loadScene()]]},
    {type:'buttons', btns:[['Mark issues', () => toggleMarking()], ['Clear marks', () => { MARKS.length = 0; drawMarks(); }], ['Save report', () => saveReport()]]},
    {type:'note', html:'<span id="markInfo">To report a problem: <b>Mark issues</b>, paint over it in the view, add a note, then <b>Save report</b>. The report holds the scene, the marks, the view and a picture, so it can be reproduced exactly.</span><textarea id="noteBox" class="notebox" placeholder="What looks wrong? (optional)"></textarea>'},
  ]},
  {title:'Presets', items:[
    {type:'buttons', btns:PRESETS.map(([name, o]) => [name, () => applyPreset(o)])},
  ]},
  {title:'Paint clouds', items:[
    {type:'buttons', paint:true, btns:[['More cloud', () => setPainting('more')], ['Clear sky', () => setPainting('less')], ['Erase painting', () => { P.paint = ''; PAINT = null; changed(); drawMarks(); }]]},
    {k:'brushSize', label:'Brush size', min:1, max:30, step:0.5, fmt:v => `${v.toFixed(1)}°`},
    {k:'brushSoft', label:'Brush softness', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'hard' : v < 0.6 ? 'soft' : 'very soft'},
    {k:'brushLayer', label:'Paint on', type:'select', opts:[['all', 'Every cloud layer'], ['cu', 'Cumulus'], ['sc', 'Stratocumulus'], ['ac', 'Altocumulus'], ['ci', 'Cirrus']]},
    {k:'paintStr', label:'Strength of the painting', min:0, max:2, step:0.01, fmt:v => `×${v.toFixed(2)}`},
    {type:'note', html:'Drag over the sky (panorama or look-around view) to add cloud there or clear it. Each stroke lands on the cloud layers at their own height in that direction (a patch of cloud, not a wedge toward the camera). Click the button again to stop painting.'},
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
    {k:'includeSun', label:'Sun disc in the image (off: for a separate sun light in the renderer)', type:'check'},
    {k:'moonOverride', label:'Set the moon phase by hand', type:'check'},
    {k:'moonIllum', label:'Moon illuminated', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.moonOverride},
  ]},
  {title:'Air', items:[
    {k:'aod', label:'Haze (aerosol optical depth, 550 nm)', min:0.01, max:2, log:true, fmt:v => v.toFixed(3)},
    {k:'aerosol', label:'Aerosol type', type:'select', opts:Object.entries(AEROSOLS).map(([k, a]) => [k, a.name])},
    {k:'humidity', label:'Relative humidity', min:5, max:97, step:1, fmt:v => `${Math.round(v)}%`},
    {k:'fogVis', label:'Fog or mist (visibility)', min:0.05, max:50, log:true, fmt:v => v >= 49.5 ? 'none' : v < 1 ? `${Math.round(v*1000)} m` : `${v.toFixed(1)} km`},
    {k:'fogH', label:'Fog depth', min:0.02, max:1, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.fogVis < 49.5},
    {k:'aerH', label:'Haze layer height', min:0.3, max:4, step:0.05, fmt:v => `${v.toFixed(2)} km`},
    {k:'ozone', label:'Ozone', min:200, max:500, step:5, fmt:v => `${Math.round(v)} DU`},
    {k:'diurnal', label:'Morning mist and evening haze follow the sun', type:'check'},
    {k:'siteAlt', label:'Ground altitude', min:0, max:5, step:0.05, fmt:v => `${Math.round(v*1000)} m`},
  ]},
  {title:'Ground', items:[
    {k:'surface', label:'Surface', type:'select', opts:Object.entries(SURFACES).map(([k, s]) => [k, s.name])},
    {k:'albedo', label:'Albedo', min:0, max:1, step:0.01, fmt:v => v.toFixed(2), show:() => P.surface === 'grey'},
    {k:'camH', label:'Camera height', min:0.001, max:3, log:true, fmt:v => v < 1 ? `${Math.round(v*1000)} m` : `${v.toFixed(2)} km`},
    {k:'azOff', label:'Rotate the panorama (north offset)', min:-180, max:180, step:0.5, fmt:fmtDeg},
    {k:'groundMode', label:'Below the horizon', type:'select', opts:[['lit', 'Lit ground'], ['black', 'Black (sky only)']]},
  ]},
  {title:'Horizon', items:[
    {k:'hillsOn', label:'Distant hills', type:'check'},
    {k:'hillH', label:'Height', min:0.05, max:3, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.hillsOn},
    {k:'hillDist', label:'Distance', min:3, max:80, step:0.5, fmt:v => `${v.toFixed(1)} km`, show:() => P.hillsOn},
    {k:'hillRough', label:'Ruggedness', min:0, max:1, step:0.01, fmt:v => v < 0.3 ? 'rolling' : v < 0.7 ? 'hilly' : 'mountainous', show:() => P.hillsOn},
    {k:'hillAlb', label:'Brightness (× ground albedo)', min:0.2, max:1.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.hillsOn},
    {type:'buttons', btns:[['New hills', () => { P.hillSeed = (P.hillSeed*7919 + 31) % 100003; changed(); }]], show:() => P.hillsOn},
    {k:'treesOn', label:'Tree line', type:'check'},
    {k:'treeH', label:'Tree height', min:5, max:40, step:0.5, fmt:v => `${v.toFixed(1)} m`, show:() => P.treesOn},
    {k:'treeDist', label:'Distance', min:0.1, max:5, step:0.05, fmt:v => `${Math.round(v*1000)} m`, show:() => P.treesOn},
    {k:'treeCover', label:'Around the horizon', min:0.05, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.treesOn},
    {k:'treeAlb', label:'Brightness (× ground albedo)', min:0.1, max:1, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.treesOn},
    {type:'buttons', btns:[['New trees', () => { P.treeSeed = (P.treeSeed*7919 + 31) % 100003; changed(); }]], show:() => P.treesOn},
  ]},
  {title:'Town lights', items:[
    {k:'townsOn', label:'Towns round the horizon (night)', type:'check'},
    {k:'townN', label:'Number of towns', min:1, max:8, step:1, fmt:v => `${Math.round(v)}`, show:() => P.townsOn},
    {k:'townDist', label:'Typical distance', min:2, max:60, step:0.5, fmt:v => `${v.toFixed(1)} km`, show:() => P.townsOn},
    {k:'townSize', label:'Size', min:0.2, max:4, step:0.05, fmt:v => `×${v.toFixed(2)}`, show:() => P.townsOn},
    {k:'townBright', label:'Brightness', min:0.05, max:5, step:0.01, log:true, fmt:v => `×${v.toFixed(2)}`, show:() => P.townsOn},
    {k:'townLED', label:'Lighting', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'sodium (orange)' : v < 0.8 ? 'mixed sodium and LED' : 'white LED', show:() => P.townsOn},
    {type:'buttons', btns:[['Move towns', () => { P.townSeed = (P.townSeed*7919 + 31) % 100003; changed(); }]], show:() => P.townsOn},
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
    {type:'buttons', btns:[['New clouds', () => { P.cuSeed = (P.cuSeed*7919 + 31) % 100003; changed(); }]], show:() => P.cuOn},
    {k:'cuStreets', label:'Cloud streets (lined up with the wind)', min:0, max:1, step:0.01, fmt:v => v < 0.05 ? 'none' : `${Math.round(v*100)}%`, show:() => P.cuOn},
    {k:'cuShear', label:'Wind shear (tops lean downwind)', min:0, max:2, step:0.01, fmt:v => v.toFixed(2), show:() => P.cuOn},
    {k:'cuClear', label:'Keep overhead clear', min:0, max:1, step:0.01, fmt:v => v < 0.02 ? 'off (as it falls)' : `${Math.round(v*100)}%`, show:() => P.cuOn},
    {k:'cuRain', label:'Showers (rain, virga) from congestus up', min:0, max:1, step:0.01, fmt:v => v < 0.02 ? 'off' : `${Math.round(v*100)}%`, show:() => P.cuOn && P.cuModel !== 'cells'},
    {k:'cuAnvil', label:'Anvils on deep convection', min:0, max:1, step:0.01, fmt:v => v < 0.02 ? 'off' : `${Math.round(v*100)}%`, show:() => P.cuOn && P.cuModel !== 'cells'},
    {k:'cuMamma', label:'Mammatus under anvils', min:0, max:1, step:0.01, fmt:v => v < 0.02 ? 'none' : `${Math.round(v*100)}%`, show:() => P.cuOn && P.cuModel !== 'cells' && P.cuAnvil > 0.02},
    {k:'rainBow', label:'Rainbows in the rain', min:0, max:2, step:0.01, fmt:v => v < 0.02 ? 'none' : `×${v.toFixed(2)}`, show:() => P.cuOn && P.cuModel !== 'cells' && P.cuRain > 0.02},
    {k:'cuDens', label:'Water content (density)', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.cuOn},
    {k:'cuErode', label:'Edge detail', min:0, max:2, step:0.01, fmt:v => v.toFixed(2), show:() => P.cuOn},
    {k:'cuAmb', label:'Sky light on the clouds', min:0, max:2, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.cuOn},
    {k:'cuDrop', label:'Droplet size (silver linings, coronae)', min:5, max:40, step:0.5, fmt:v => `${v.toFixed(1)} µm`, show:() => P.cuOn},
    {k:'cuModel', label:'Formation', type:'select', opts:[['field', 'One continuous field (natural groups)'], ['cells', 'Individual clouds']], show:() => P.cuOn},
  ]},
  {title:'Wind', items:[
    {k:'windX', label:'Low wind (cloud base), from west (+) / east (−)', min:-60, max:60, step:1, fmt:v => `${Math.round(v)} km/h`},
    {k:'windZ', label:'Low wind, from south (+) / north (−)', min:-60, max:60, step:1, fmt:v => `${Math.round(v)} km/h`},
    {k:'windUpX', label:'Upper wind (~10 km), from west (+) / east (−)', min:-150, max:150, step:1, fmt:v => `${Math.round(v)} km/h`},
    {k:'windUpZ', label:'Upper wind, from south (+) / north (−)', min:-150, max:150, step:1, fmt:v => `${Math.round(v)} km/h`},
    {type:'note', html:'Layers between take the wind at their height. Towers lean and anvils stream along the difference (the shear). Wind tool: drag sets the low wind, Shift-drag the upper.'},
  ]},
  {title:'Stratocumulus · stratus', items:[
    {k:'scOn', label:'Low cloud deck', type:'check'},
    {k:'scCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.scOn},
    {k:'scForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.15 ? 'stratus (featureless)' : v < 0.55 ? 'stratocumulus (closed cells)' : 'stratocumulus (open cells, broken)', show:() => P.scOn},
    {k:'scBase', label:'Base', min:0.1, max:2.5, step:0.05, fmt:v => `${Math.round(v*1000)} m`, show:() => P.scOn},
    {k:'scThick', label:'Thickness', min:0.1, max:1.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.scOn},
    {k:'scCell', label:'Cell size', min:0.4, max:5, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.scOn},
    {type:'buttons', btns:[['New pattern', () => { P.scSeed = (P.scSeed*7919 + 31) % 100003; changed(); }]], show:() => P.scOn},
    {k:'scDens', label:'Water content (density)', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.scOn},
  ]},
  {title:'Altocumulus · altostratus', items:[
    {k:'acOn', label:'Mid-level layer', type:'check'},
    {k:'acCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.acOn},
    {k:'acForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'altostratus (grey veil)' : v < 0.6 ? 'altostratus breaking into cloudlets' : 'altocumulus (cloudlets in rows)', show:() => P.acOn},
    {k:'acBase', label:'Base', min:2, max:7, step:0.05, fmt:v => `${v.toFixed(2)} km`, show:() => P.acOn},
    {k:'acThick', label:'Thickness', min:0.1, max:2.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.acOn},
    {k:'acCell', label:'Cloudlet size', min:0.2, max:2, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.acOn},
    {type:'buttons', btns:[['New pattern', () => { P.acSeed = (P.acSeed*7919 + 31) % 100003; changed(); }]], show:() => P.acOn},
    {k:'acDens', label:'Density', min:0.3, max:2.5, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.acOn},
  ]},
  {title:'Cirrus · cirrostratus · cirrocumulus', items:[
    {k:'ciOn', label:'High ice-cloud layer', type:'check'},
    {k:'ciCover', label:'Cloud cover', min:0, max:1, step:0.01, fmt:v => `${Math.round(v*100)}%`, show:() => P.ciOn},
    {k:'ciForm', label:'Form', min:0, max:1, step:0.01, fmt:v => v < 0.2 ? 'cirrostratus (veil)' : v < 0.65 ? 'cirrus (fibres and fall streaks)' : 'cirrocumulus (ripples)', show:() => P.ciOn},
    {k:'ciBase', label:'Height', min:6, max:13, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {k:'ciThick', label:'Thickness', min:0.2, max:2.5, step:0.01, fmt:v => `${Math.round(v*1000)} m`, show:() => P.ciOn},
    {k:'ciCell', label:'Pattern scale', min:0.4, max:5, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {type:'buttons', btns:[['New pattern', () => { P.ciSeed = (P.ciSeed*7919 + 31) % 100003; changed(); }]], show:() => P.ciOn},
    {k:'ciFall', label:'Fall streak length', min:0, max:3, step:0.05, fmt:v => `${v.toFixed(1)} km`, show:() => P.ciOn},
    {k:'ciShear', label:'Wind shear (streak curve)', min:0, max:3, step:0.01, fmt:v => v.toFixed(2), show:() => P.ciOn},
    {k:'ciDens', label:'Optical thickness', min:0.2, max:4, step:0.01, fmt:v => `×${v.toFixed(2)}`, show:() => P.ciOn},
    {k:'ciHalo', label:'Halos (22°, 46°)', min:0, max:2, step:0.01, fmt:v => v < 0.02 ? 'none' : `×${v.toFixed(2)}`, show:() => P.ciOn},
    {k:'ciDogs', label:'Sundogs (flat plate crystals)', min:0, max:2, step:0.01, fmt:v => v < 0.02 ? 'none' : `×${v.toFixed(2)}`, show:() => P.ciOn},
  ]},
  {title:'Timelapse', items:[
    {k:'tlFrames', label:'Frames', min:2, max:240, step:1, fmt:v => `${Math.round(v)}`},
    {k:'tlSpan', label:'Time span', min:1, max:720, step:1, log:true, fmt:v => v < 60 ? `${Math.round(v)} min` : `${(v/60).toFixed(1)} h`},
    {k:'tlRes', label:'Frame size', type:'select', opts:[[1024, '1K · 1024 × 512'], [2048, '2K · 2048 × 1024'], [4096, '4K · 4096 × 2048']]},
    {type:'buttons', btns:[['Render timelapse', () => startTimelapse()], ['Cancel', () => cancelTimelapse()]]},
    {type:'note', html:'<span id="tlInfo">The clouds drift with the wind over the span; with <i>Place, date and time</i> set, the sun and moon move too (set by hand, they stay put). Samples and file type as in Export. Frames come as EXRs in one zip.</span>'},
  ]},
  {title:'Match a plate', items:[
    {type:'buttons', btns:[['Load plate (JPEG, PNG)', () => pickPlate()], ['Remove', () => clearPlate()]]},
    {k:'plateHfov', label:'Plate: horizontal field of view', min:5, max:140, step:0.5, view: () => plateLayout(), fmt:fmtDeg},
    {k:'plateOp', label:'Plate: opacity', min:0, max:1, step:0.01, view: () => plateLayout(), fmt:v => `${Math.round(v*100)}%`},
    {type:'buttons', btns:[['Pick sky patches', () => togglePlateSampling()], ['Clear patches', () => { PLATE.samples = []; PLATE.sun = null; plateMarks(); }]]},
    {k:'plateKeepSun', label:'Keep the sun where it is (fit the haze only)', type:'check', view: () => {}},
    {type:'buttons', btns:[['Fit sun, haze and aerosol', () => solvePlate()], ['Stop', () => { if (PLATE.solving) PLATE.solving.stop = true; }]]},
    {type:'note', html:'<span id="plateInfo">No plate.</span> Load a photograph, set its field of view, and drag in <i>Look around</i> to line its horizon up. Then click 4–8 patches of clear sky spread across it (shift-click the sun if it is in frame) and fit: the sun\'s position, the haze and the aerosol type are fitted to the patches\' colours and relative brightness. Assumes an sRGB plate; a graded one biases the fit.'},
  ]},
  {title:'Look-dev model', items:[
    {type:'buttons', btns:[['Load model (.obj, .glb)', () => pickModel()], ['Remove', () => clearModel()]]},
    {k:'ldMat', label:'Material', type:'select', view:true, opts:[['grey', '18% grey, semi-gloss'], ['white', 'White, matte'], ['clay', 'Clay'], ['chrome', 'Chrome'], ['gold', 'Gold']]},
    {k:'ldSpin', label:'Turn', min:-180, max:180, step:1, view:true, fmt:fmtDeg},
    {k:'ldSize', label:'Size', min:0.3, max:2.5, step:0.01, view:true, fmt:v => `${(+v).toFixed(2)}×`},
    {type:'note', html:'<span id="ldInfo">No model.</span> Shown in <i>Look around</i> with <i>Look-dev</i> on, in the middle of the view, lit by this sky (diffuse from its harmonics, GGX reflections of the panorama; no self-shadowing). A file can be dropped on the page too.'},
  ]},
  {title:'Quality', items:[
    {k:'volQ', label:'Cloud volume', type:'select', opts:[[0, 'Fast (128 × 128 × 80 per level)'], [1, 'High (256 × 256 × 160 per level)']]},
    {k:'atmSteps', label:'Air steps per ray', min:8, max:96, step:1, fmt:v => `${Math.round(v)}`},
    {k:'ptPreview', label:'Path-traced cloud light in the view (slow; use with Crop)', type:'check'},
  ]},
  {title:'Export', items:[
    {k:'outRes', label:'Size', type:'select', opts:[[2048, '2K · 2048 × 1024'], [4096, '4K · 4096 × 2048'], [8192, '8K · 8192 × 4096'], [16384, '16K · 16384 × 8192']]},
    {k:'outSpp', label:'Samples per pixel', type:'select', opts:[[16, '16 (draft)'], [32, '32'], [64, '64'], [128, '128'], [256, '256 (final)']]},
    {k:'format', label:'File', type:'select', opts:[['exr32', 'OpenEXR, 32-bit float'], ['exr16', 'OpenEXR, 16-bit half'], ['hdr', 'Radiance HDR']]},
    {k:'expSpace', label:'Colour space', type:'select', opts:[['rec709', 'Linear Rec.709 (sRGB primaries)'], ['acescg', 'ACEScg (AP1)'], ['aces2065', 'ACES2065-1 (AP0)'], ['xyz', 'CIE XYZ']]},
    {k:'layers', label:'Light layers', type:'select', opts:[['beauty', 'Single image'], ['layers', 'Layers: sun, sky, moon, night (stars, airglow, towns), + their sum']]},
    {k:'sunLight', label:'Sun', type:'select', opts:[['dome', 'In the image'], ['split', 'As a separate light (disc left out; JSON, USD, Nuke files)']]},
    {type:'buttons', btns:[['Render and download', () => startExport()], ['Cancel', () => cancelExport()]]},
    {type:'note', html:'<span id="expInfo">Equirectangular, north in the middle, colours unclipped (out-of-gamut colours keep negative values) with the colour space written into the EXR. Written band by band, so 8K and 16K work with layers too. The preview pauses while the export renders. Half floats clip above 65 504, which in physical units the sun disc far exceeds: split the sun off or use 32-bit.</span>'},
    {k:'units', label:'Units', type:'select', opts:[['nits', 'Luminance (cd/m², physical)'], ['watts', 'Radiance (W·m⁻²·sr⁻¹ equivalent)']]},
    {k:'cloudLight', label:'Light in the clouds', type:'select', opts:[['fast', 'Fast model (as the preview)'], ['pt', 'Path-traced (slow reference; use 128+ samples)']]},
    {k:'expAlpha', label:'Mattes: cloud.A (cloud opacity) and ground.A (ground, horizon)', type:'check'},
    {k:'expRig', label:'Light rig files with every export (JSON, USD .usda, Nuke .nk)', type:'check'},
  ]},
  {title:'Passes for comp and 3D', items:[
    {k:'hazeRes', label:'Haze for comp: size', type:'select', opts:[[1024, '1K · 1024 × 512'], [2048, '2K'], [4096, '4K'], [8192, '8K']]},
    {k:'hazeShafts', label:'Haze for comp: with the clouds\' shadows in the air (shafts)', type:'check'},
    {type:'buttons', btns:[['Haze for comp', () => startHaze()]]},
    {type:'note', html:'<b>Haze for comp</b>: the air between the camera and points 250 m … 50 km away, as EXR layers <i>haze_…</i> (its light) and <i>trans_…</i> (its transmission): a CG element at that distance comps in as element × trans + haze.'},
    {k:'smKm', label:'Shadow matte: area', type:'select', opts:[[1, '1 km square'], [2, '2 km'], [5, '5 km'], [10, '10 km'], [25, '25 km']]},
    {k:'smRes', label:'Shadow matte: size', type:'select', opts:[[1024, '1024²'], [2048, '2048²'], [4096, '4096²']]},
    {type:'buttons', btns:[['Shadow matte (ground, top-down)', () => startMatte()]]},
    {type:'note', html:'<span id="smInfo">The clouds\' shadow on the ground around the camera, seen from straight above, for lighting a CG set under this sky: R the sun through the clouds (crisp shadow), G the sky\'s light through the clouds (soft dimming), B the optical depth toward the sun. Top is north, right is east, the camera at the centre.</span>'},
    {k:'vxKm', label:'Cloud volume: area', type:'select', opts:[[2, '2 km square'], [5, '5 km'], [10, '10 km'], [20, '20 km'], [40, '40 km']]},
    {k:'vxRes', label:'Cloud volume: voxels across', type:'select', opts:[[128, '128'], [256, '256'], [384, '384'], [512, '512']]},
    {type:'buttons', btns:[['Cloud volume (Houdini, Blender)', () => startVolume()], ['Cancel', () => cancelVolume()]]},
    {type:'note', html:'<span id="vxInfo">The clouds around the camera as a grid of extinction (half floats, cubic voxels, as tall as the cloud layers that are on), with a Houdini Python SOP and a Blender script that build a VDB from it. Lined up with the light rig files.</span>'},
  ]},
];
// the panel's order: what an artist reaches for first at the top (a new sky, the sun, the clouds, the air, the export), then
// the finer controls and the specialist tools, the scene files and issue reports last
{ const ORDER = ['Randomize', 'Presets', 'Sun & moon', 'Cumulus', 'Stratocumulus · stratus', 'Altocumulus · altostratus', 'Cirrus · cirrostratus · cirrocumulus',
    'Air', 'Wind', 'Export', 'Ground', 'Horizon', 'Paint clouds', 'Night sky', 'Town lights', 'Passes for comp and 3D', 'Timelapse', 'Look-dev model', 'Match a plate', 'Quality', 'Scene file'];
  SECTIONS.sort((a, b) => { const i = ORDER.indexOf(a.title), j = ORDER.indexOf(b.title); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); }); }

/* ---------- panel ---------- */
const CTRL = [];
let FOLD = {}; try { FOLD = JSON.parse(localStorage.getItem('ssFold') || '{}') || {}; } catch (e){ FOLD = {}; }
function sliderPos(it, v){ return it.log ? Math.log(v/it.min)/Math.log(it.max/it.min) : v; }
function sliderVal(it, x){ return it.log ? it.min*Math.pow(it.max/it.min, x) : x; }
function buildPanel(){
  const panel = $('#panel'); panel.innerHTML = '';
  for (const sec of SECTIONS){
    const el = document.createElement('section'); el.className = 'sec'; if (sec.hidden && sec.hidden()) el.hidden = true;
    // (click a heading to fold its section; cloud layers have their on/off switch in the heading)
    el.innerHTML = `<h2><span class="tw">▾</span><span class="ttl">${sec.title}</span>${sec.layer ? `<input type="checkbox" aria-label="${sec.title} on">` : ''}</h2>`;
    if (FOLD[sec.title]) el.classList.add('closed');
    el.querySelector('h2').onclick = e => { if (e.target.tagName === 'INPUT') return; el.classList.toggle('closed'); FOLD[sec.title] = el.classList.contains('closed'); try { localStorage.setItem('ssFold', JSON.stringify(FOLD)); } catch (er){} };
    if (sec.layer){ const cb = el.querySelector('h2 input'); cb.onchange = () => { P[sec.layer] = cb.checked; changed(); }; CTRL.push({it: {}, row: document.createElement('div'), set: () => { cb.checked = !!P[sec.layer]; }}); }
    const rows = document.createElement('div'); rows.className = 'rows'; el.appendChild(rows);
    for (const it of sec.items){
      const row = document.createElement('div'); row.className = 'row'; rows.appendChild(row);
      if (it.type === 'buttons'){ row.classList.add('full'); row.innerHTML = `<div class="btns">${it.btns.map((b, i) => `<button class="btn" data-i="${i}"${it.paint && i < 2 ? ` data-paint="${['more', 'less'][i]}"` : ''}>${b[0]}</button>`).join('')}</div>`;
        row.querySelectorAll('button').forEach(bt => bt.onclick = () => it.btns[+bt.dataset.i][1]()); CTRL.push({it, row}); continue; }
      if (it.type === 'note'){ row.classList.add('full'); row.innerHTML = `<div class="note">${it.html}</div>`; CTRL.push({it, row}); continue; }
      const id = 'c_' + it.k;
      if (it.type === 'select'){ row.innerHTML = `<label for="${id}">${it.label}</label><select id="${id}">${it.opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
        const s = row.querySelector('select'); s.onchange = () => { P[it.k] = s.value; it.view ? (typeof it.view === 'function' ? it.view() : sendView()) : changed(); }; CTRL.push({it, row, set:() => { s.value = P[it.k]; }}); }
      else if (it.type === 'check'){ row.innerHTML = `<label for="${id}">${it.label}</label><input type="checkbox" id="${id}">`;
        const c = row.querySelector('input'); c.onchange = () => { P[it.k] = c.checked; it.view ? (typeof it.view === 'function' ? it.view() : sendView()) : changed(); }; CTRL.push({it, row, set:() => { c.checked = !!P[it.k]; }}); }
      else if (it.type === 'date' || it.type === 'time' || it.type === 'number'){ row.innerHTML = `<label for="${id}">${it.label}</label><input type="${it.type}" id="${id}" ${it.step ? `step="${it.step}"` : ''}>`;
        const c = row.querySelector('input'); c.onchange = () => { P[it.k] = it.type === 'number' ? +c.value : c.value; changed(); }; CTRL.push({it, row, set:() => { c.value = P[it.k]; }}); }
      else { // range
        row.innerHTML = `<label for="${id}">${it.label}</label><span class="val"></span><input type="range" id="${id}">`;
        const r = row.querySelector('input'), val = row.querySelector('.val');
        if (it.log){ r.min = 0; r.max = 1; r.step = 0.001; } else { r.min = it.min; r.max = it.max; r.step = it.step || 0.01; }
        r.oninput = () => { P[it.k] = sliderVal(it, +r.value); val.textContent = it.fmt ? it.fmt(P[it.k]) : P[it.k]; it.view ? (typeof it.view === 'function' ? it.view() : sendView()) : changed(true); };
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
// undo / redo: the settings as they stood after each pause in editing
const HIST = []; let histI = -1, histT = null, histMute = false;
function pushHist(){ if (histMute) return; const s = JSON.stringify(P); if (HIST[histI] === s) return; HIST.length = histI + 1; HIST.push(s); if (HIST.length > 200) HIST.shift(); histI = HIST.length - 1; }
function undoRedo(k){ const j = histI + k; if (j < 0 || j >= HIST.length) return; histI = j; histMute = true; const o = JSON.parse(HIST[j]); for (const key of Object.keys(P)) if (!(key in o)) delete P[key]; Object.assign(P, o); syncUI(); sendParams(); drawMarks(); histMute = false; setStatus(k < 0 ? 'Undo' : 'Redo'); }
window.addEventListener('keydown', e => { if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
  if (e.key.toLowerCase() === 'z' && !e.shiftKey){ e.preventDefault(); undoRedo(-1); } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)){ e.preventDefault(); undoRedo(1); } });
function changed(fromSlider){ clearTimeout(histT); histT = setTimeout(pushHist, 400); if (!fromSlider) syncUI(); else for (const c of CTRL) c.row.hidden = c.it.show ? !c.it.show() : false;
  if (sendPending) return; sendPending = true; requestAnimationFrame(() => { sendPending = false; sendParams(); }); }
function sendParams(){ if (worker) worker.postMessage({type:'params', P}); drawOverlay(); }
function sendView(extra){ if (!worker) return; worker.postMessage({type:'view', view:{...view, ldMat: P.ldMat, ldSpin: +P.ldSpin || 0, ldSize: +P.ldSize || 1, ...extra}}); if (MARKS.length) drawMarks(); }

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
  ov.innerHTML = html; drawCrop(); }
function resize(){ const [w, h] = canvasSize(); sendView({cw:w, ch:h}); drawOverlay(); drawMarks(); if (PLATE.img) plateLayout(); }
new ResizeObserver(resize).observe($('#view'));
let drag = null, tool = 'view';
// the tools: Inspect (drag looks around; nothing is moved by accident), Sun, Moon (place them), Wind (the clouds move toward where
// you drag), Crop (a box to render alone, for quick checks)
document.querySelectorAll('#toolSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#toolSeg button').forEach(x => x.classList.toggle('on', x === b)); tool = b.dataset.t;
  if ((tool === 'sun' || tool === 'moon') && P.mode !== 'manual') setStatus('The sun and moon follow the place and time: switch “Position from” to Set by hand to place them');
  else setStatus({view: 'Inspect: hover to read the light; drag to look around', sun: 'Click or drag to place the sun', moon: 'Click or drag to place the moon', wind: 'Drag toward where the clouds should move', crop: 'Drag a box to render only that part; click to clear it'}[tool]); drawOverlay(); });
const evUV = e => { const r = $('#view').getBoundingClientRect(); return screenToUV(e.clientX - r.left, e.clientY - r.top); };
const uvAzEl = uv => [((((uv[0] - 0.5)*360 + P.azOff) % 360) + 360) % 360, (0.5 - uv[1])*180];
function toolAt(e, start){ const uv = evUV(e); if (!uv) return; const [az, el] = uvAzEl(uv);
  if (tool === 'sun' && P.mode === 'manual'){ P.sunAz = az; P.sunEl = clamp(el, -20, 90); changed(); }
  else if (tool === 'moon' && P.mode === 'manual'){ P.moonAz = az; P.moonEl = clamp(el, -20, 90); changed(); }
  else if (tool === 'wind'){ const kx = e.shiftKey ? 'windUpX' : 'windX', kz = e.shiftKey ? 'windUpZ' : 'windZ', sp = Math.max(Math.hypot(P[kx], P[kz]), 5);
    P[kx] = Math.round(sp*Math.sin(az*D2R)); P[kz] = Math.round(sp*Math.cos(az*D2R)); changed(); }
  else if (tool === 'crop' && view.mode !== 1){ if (start) drag.c0 = uv; drag.c1 = uv; drawCrop(); } }
function drawCrop(){ const b = $('#cropBox'); const c = drag && drag.c0 ? [Math.min(drag.c0[0], drag.c1[0]), Math.min(drag.c0[1], drag.c1[1]), Math.max(drag.c0[0], drag.c1[0]), Math.max(drag.c0[1], drag.c1[1])] : P.crop;
  if (!c || view.mode === 1){ b.hidden = true; return; } const pr = panoRect(); b.hidden = false; Object.assign(b.style, {left: pr.x + c[0]*pr.w + 'px', top: pr.y + c[1]*pr.h + 'px', width: (c[2] - c[0])*pr.w + 'px', height: (c[3] - c[1])*pr.h + 'px'}); }
cv.addEventListener('pointerdown', e => { if (PLATE.sampling && PLATE.img && view.mode === 1){ plateClick(e); return; } cv.setPointerCapture(e.pointerId); if (painting){ paintStroke = true; paintAt(e); return; } if (marking){ markStroke = {r: 0.006, pts: []}; MARKS.push(markStroke); addMark(e); return; }
  drag = {x:e.clientX, y:e.clientY, yaw:view.yaw, pitch:view.pitch, moved:false}; if (tool !== 'view') toolAt(e, true); });
cv.addEventListener('pointermove', e => { moveBrush(e); if (painting){ if (paintStroke) paintAt(e); return; } if (marking){ if (markStroke) addMark(e); return; }
  if (!drag){ if (tool === 'view') pickAt(e); return; } const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true;
  if (tool !== 'view' && !(tool === 'crop' && view.mode === 1)){ toolAt(e, false); return; }
  if (view.mode === 1 && drag.moved){ const k = view.fov/cv.getBoundingClientRect().height; view.yaw = drag.yaw - dx*k; view.pitch = clamp(drag.pitch + dy*k, -1.5, 1.5); sendView(); } });
cv.addEventListener('pointerup', e => { if (painting){ paintStroke = false; commitPaint(); return; } if (marking){ markStroke = null; return; }
  if (drag && tool === 'crop' && view.mode !== 1){ const c = drag.c0 && drag.c1 ? [Math.min(drag.c0[0], drag.c1[0]), Math.min(drag.c0[1], drag.c1[1]), Math.max(drag.c0[0], drag.c1[0]), Math.max(drag.c0[1], drag.c1[1])] : null;
    P.crop = c && (c[2] - c[0]) > 0.01 && (c[3] - c[1]) > 0.01 ? c.map(v => +v.toFixed(4)) : null; drag = null; drawCrop(); changed(); setStatus(P.crop ? 'Rendering only the cropped region' : 'Crop cleared'); return; }
  drag = null; });
cv.addEventListener('pointerleave', () => { $('#pick').hidden = true; $('#brush').hidden = true; });
// the light under the cursor: direction, luminance, exposure value, colour temperature
let pickT = 0;
function pickAt(e){ const now = performance.now(); if (now - pickT < 90 || !worker) return; pickT = now; const uv = evUV(e); const el = $('#pick'); if (!uv){ el.hidden = true; return; }
  const r = $('#view').getBoundingClientRect(); el.style.left = (e.clientX - r.left) + 'px'; el.style.top = (e.clientY - r.top) + 'px';
  const id = ++rbId; pending.set(id, m => { if (!m.xyz) return; const [X, Y, Z] = m.xyz, s = X + Y + Z, x = s > 0 ? X/s : 0, y = s > 0 ? Y/s : 0, n = (x - 0.3320)/(0.1858 - y);
    const cct = 449*n*n*n + 3525*n*n + 6823.3*n + 5520.33, [az, elv] = uvAzEl(uv), ev = Y > 0 ? Math.log2(Y*100/12.5) : -Infinity;
    el.hidden = false; el.innerHTML = `az ${az.toFixed(1)}° el ${elv.toFixed(1)}°<br>${Y >= 1000 ? Y.toExponential(2) : Y.toPrecision(3)} cd/m² · EV₁₀₀ ${isFinite(ev) ? ev.toFixed(1) : '–'}<br>${s > 0 && cct > 1000 && cct < 40000 ? Math.round(cct/10)*10 + ' K' : '–'} · xy ${x.toFixed(3)}, ${y.toFixed(3)}`; });
  worker.postMessage({type:'pick', id, u: uv[0], v: uv[1]}); }
// the brush outline while painting
function moveBrush(e){ const b = $('#brush'); if (!painting){ b.hidden = true; return; } const r = $('#view').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const pxDeg = view.mode === 1 ? r.height/(view.fov*R2D) : panoRect().w/360, d = 2*(+P.brushSize || 6)*pxDeg;
  b.hidden = false; b.classList.toggle('rem', painting === 'less'); Object.assign(b.style, {left: x + 'px', top: y + 'px', width: d + 'px', height: d + 'px'}); }
cv.addEventListener('wheel', e => { if (view.mode !== 1) return; e.preventDefault(); view.fov = clamp(view.fov*Math.exp(e.deltaY*0.001), 10*D2R, 140*D2R); sendView(); }, {passive:false});

$('#ptBtn').onclick = () => { P.ptPreview = !P.ptPreview; $('#ptBtn').classList.toggle('on', !!P.ptPreview); changed(); };
$('#ldBtn').onclick = () => { view.lookdev = !view.lookdev; $('#ldBtn').classList.toggle('on', view.lookdev); sendView(); };
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => { document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('on', x === b)); view.mode = +b.dataset.v; $('#legend').hidden = view.mode !== 2; sendView(); drawOverlay(); if (PLATE.img) plateLayout(); });
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
  for (const s of MARKS) for (const [u, v] of s.pts){ const p = uvToScreen(u, v); if (!p) continue; g.beginPath(); g.arc(p[0], p[1], Math.max(3, s.r*p[2]), 0, 2*Math.PI); g.fill(); }
  // (while painting: the paint itself, white where cloud is added, blue where it is cleared)
  if (painting){ const a = paintArr(), ch = P.brushLayer && P.brushLayer !== 'all' ? {cu: 0, sc: 1, ac: 2, ci: 3}[P.brushLayer] : -1;
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++){ const i = 4*(y*PW + x); let v = 0;
      if (ch >= 0) v = a[i + ch] - 128; else for (let c = 0; c < 4; c++) if (Math.abs(a[i + c] - 128) > Math.abs(v)) v = a[i + c] - 128; if (Math.abs(v) < 4) continue;
    const p = uvToScreen((x + 0.5)/PW, (y + 0.5)/PH*0.5); if (!p) continue; g.fillStyle = v > 0 ? `rgba(255,255,255,${Math.min(v/127, 1)*0.45})` : `rgba(40,120,255,${Math.min(-v/128, 1)*0.45})`;
    g.fillRect(p[0] - p[2]/PW*0.5, p[1] - p[2]/PH*0.25, p[2]/PW + 1, p[2]/PH*0.5 + 1); } } }
// ---------- painting cloud: more or less of it by direction (the paint raises or lowers every cloud field there) ----------
const PW = 128, PH = 32; let painting = null, paintStroke = false, PAINT = null, PAINTKEY = null, paintDirty = false;
// (four channels: cumulus, stratocumulus, altocumulus, cirrus; an older one-channel painting applies to all four)
function paintArr(){ if (!PAINT || PAINTKEY !== P.paint){ PAINT = new Uint8Array(PW*PH*4).fill(128); PAINTKEY = P.paint;
    if (P.paint){ try { const b = atob(P.paint); if (b.length === PW*PH*4) PAINT = Uint8Array.from(b, c => c.charCodeAt(0));
      else if (b.length === PW*PH) for (let i = 0; i < PW*PH; i++) PAINT.fill(b.charCodeAt(i), 4*i, 4*i + 4); } catch (e){} } } return PAINT; }
function setPainting(mode){ painting = painting === mode ? null : mode; if (painting && marking) toggleMarking();
  $('#view').classList.toggle('marking', !!painting);
  for (const b of document.querySelectorAll('button')){ if (b.dataset.paint) b.classList.toggle('on', b.dataset.paint === painting); }
  setStatus(painting ? (painting === 'more' ? 'Painting: drag over the sky where you want more cloud' : 'Painting: drag over the sky to clear it') : 'Painting off'); drawMarks(); }
function paintAt(e){ const r = $('#view').getBoundingClientRect(), uv = screenToUV(e.clientX - r.left, e.clientY - r.top); if (!uv || uv[1] > 0.5) return;
  const a = paintArr(), el = (0.5 - uv[1])*Math.PI, rad = +P.brushSize || 6;
  const ru = rad/360*PW/Math.max(Math.cos(el), 0.12), rv = rad/90*PH, cx = uv[0]*PW, cy = uv[1]*2*PH, sgn = painting === 'more' ? 1 : -1;
  const soft = Math.max(+P.brushSoft || 0, 0.05), chs = P.brushLayer && P.brushLayer !== 'all' ? [{cu: 0, sc: 1, ac: 2, ci: 3}[P.brushLayer]] : [0, 1, 2, 3];
  for (let y = Math.max(0, Math.floor(cy - rv)); y <= Math.min(PH - 1, Math.ceil(cy + rv)); y++) for (let xx = Math.floor(cx - ru); xx <= Math.ceil(cx + ru); xx++){
    const d = Math.sqrt(((xx + 0.5 - cx)/ru)**2 + ((y + 0.5 - cy)/rv)**2); if (d >= 1) continue; const x = ((xx % PW) + PW) % PW, i = 4*(y*PW + x);
    const s = clamp((1 - d)/soft, 0, 1), w = s*s*(3 - 2*s);
    for (const c of chs) a[i + c] = clamp(Math.round(a[i + c] + sgn*18*w), 0, 255); }
  paintDirty = true; drawMarks(); }
function commitPaint(){ if (!paintDirty) return; paintDirty = false; const a = paintArr(); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  P.paint = a.every(v => v === 128) ? '' : btoa(s); PAINTKEY = P.paint; changed(); }
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
// a preset starts from the defaults (every cloud layer off, average air), then sets what defines it
function applyPreset(o){
  const keep = {rndStyle: P.rndStyle, previewRes: P.previewRes, atmSteps: P.atmSteps, volQ: P.volQ, outRes: P.outRes, outSpp: P.outSpp, format: P.format, layers: P.layers, cloudLight: P.cloudLight, units: P.units, expSpace: P.expSpace, expAlpha: P.expAlpha, sunLight: P.sunLight, expRig: P.expRig, hazeRes: P.hazeRes, hazeShafts: P.hazeShafts, vxKm: P.vxKm, vxRes: P.vxRes, ldMat: P.ldMat, ldSpin: P.ldSpin, ldSize: P.ldSize, smKm: P.smKm, smRes: P.smRes, lat: P.lat, lon: P.lon, date: P.date, utc: P.utc, surface: P.surface, albedo: P.albedo, groundMode: P.groundMode};
  Object.assign(P, DEFAULTS, {cuOn: false}, keep, {mode: 'manual'}, o);
  for (const k of ['cuSeed', 'scSeed', 'acSeed', 'ciSeed']) P[k] = 1 + Math.floor(Math.random()*99991);
  syncUI(); changed();
}
function randomize(what){
  const st = clamp(P.rndStyle ?? 0.25, 0, 1), R = Math.random, U = (a, b) => a + (b - a)*R(), G = () => Math.sqrt(-2*Math.log(Math.max(R(), 1e-9)))*Math.cos(2*Math.PI*R());
  const pick = arr => { let t = R()*arr.reduce((s, a) => s + Math.max(a[0], 0), 0); for (const a of arr){ t -= Math.max(a[0], 0); if (t <= 0) return a[1]; } return arr[arr.length - 1][1]; };
  const seed = () => 1 + Math.floor(R()*99991);
  // with a place picked, the time and date are drawn for that place (the sun where it really is) and the weather from its
  // climate, roughly: by latitude band and the local season
  const loc = P.mode === 'location';
  if (loc && (what === 'all' || what === 'sun')){
    const yr = (P.date || '2026-06-21').slice(0, 4), doy = Math.floor(R()*365), dt = new Date(Date.UTC(+yr, 0, 1 + doy));
    P.date = dt.toISOString().slice(0, 10);
    const solarNoon = 12 - (P.lon || 0)/15 + (P.utc || 0);   // (local clock time of solar noon, roughly)
    const h = pick([[1 - 0.5*st, 'day'], [0.4 + 0.5*st, 'golden'], [0.1 + 0.2*st, 'night']]) === 'day' ? solarNoon + U(-4.5, 4.5) : R() < 0.5 ? solarNoon - U(5, 7.5) : solarNoon + U(5, 7.5);
    const hh = ((h % 24) + 24) % 24; P.time = `${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.floor((hh % 1)*60)).padStart(2, '0')}`;
  }
  const lat = Math.abs(P.lat || 0), mon = +(P.date || '2026-06-21').slice(5, 7);
  const summer = loc && ((P.lat >= 0) === (mon >= 5 && mon <= 9)), winter = loc && ((P.lat >= 0) === (mon <= 2 || mon >= 11));
  const zone = !loc ? null : lat < 15 ? 'tropical' : lat < 35 ? 'subtropical' : lat < 55 ? 'mid' : 'high';
  if ((what === 'all' || what === 'sun') && !loc){
    P.mode = 'manual';
    const tod = pick([[1 - 0.65*st, 'day'], [0.22 + 0.5*st, 'golden'], [0.07 + 0.3*st, 'twilight'], [0.04 + 0.08*st, 'night']]);
    P.sunEl = tod === 'day' ? 15 + 55*Math.pow(R(), 1.3) : tod === 'golden' ? U(0.5, 15) : tod === 'twilight' ? U(-6, 0.5) : U(-25, -10);
    P.sunAz = U(0, 360); P.moonEl = U(-30, 70); P.moonAz = U(0, 360);
  }
  if (what === 'all'){
    P.aerosol = pick([[5, 'continental'], [3, 'maritime'], [1 + st, 'urban'], [0.3 + 1.2*st, 'desert'], [0.2 + 1.2*st, 'smoke'], [1, 'clean']]);
    const aodMed = {continental: 0.1, maritime: 0.08, urban: 0.25, desert: 0.35, smoke: 0.5, clean: 0.04}[P.aerosol];   // (typical loads of each)
    P.aod = clamp(aodMed*Math.exp(G()*(0.5 + 0.4*st)), 0.02, 1.5);
    P.humidity = Math.round(clamp(U(30, 85) + G()*8*st + (zone === 'tropical' ? 15 : zone === 'high' ? 8 : 0) + (summer && zone === 'subtropical' ? -10 : 0), 10, 97));
    if (zone === 'high') P.aerosol = R() < 0.6 ? 'clean' : P.aerosol; else if (zone === 'subtropical' && summer && R() < 0.3) P.aerosol = 'desert';
    P.aerH = U(0.8, 2.2);
    P.fogVis = R() < 0.03 + 0.12*st && P.sunEl < 20 ? Math.exp(U(Math.log(0.4), Math.log(8))) : 50; P.fogH = U(0.05, 0.4);
    P.ozone = Math.round(U(270, 360));
  }
  if (what === 'all' || what === 'clouds'){
    const sEl = loc ? computeFrame(P).derived.sunEl : P.sunEl;
    const hi = sEl > 25;   // (deep convection builds in the afternoon heat)
    // (climate: the tropics and summer favour convection, winter and high latitudes stratiform decks)
    const kc = zone === 'tropical' ? 2.2 : summer ? 1.6 : winter ? 0.3 : 1, ks = zone === 'high' ? 2 : winter ? 2.2 : zone === 'tropical' ? 0.5 : 1;
    const reg = pick([[1.2 - 0.8*st, 'clear'], [(4 - 1.5*st)*Math.sqrt(kc), 'fair'], [2, 'cuci'], [((hi ? 1.2 : 0.2) + 2*st)*kc, 'congestus'], [1.5, 'ac'], [1.5*ks, 'scbroken'], [0.9*ks, 'overcast'], [1.3, 'ci'], [0.4 + 3*st, 'layered']]);
    const ang = U(0, 2*Math.PI), spd = U(5, 30 + 25*st); P.windX = Math.round(spd*Math.cos(ang)); P.windZ = Math.round(spd*Math.sin(ang));
    // (the upper wind: stronger, veered 10–60° — clockwise in the north, anticlockwise in the south)
    const veer = U(10, 60)*D2R*((P.mode === 'location' && P.lat < 0) ? -1 : 1), uf = U(1.3, 3 + st);
    P.windUpX = Math.round(spd*uf*Math.cos(ang - veer)); P.windUpZ = Math.round(spd*uf*Math.sin(ang - veer));
    P.cuOn = P.scOn = P.acOn = P.ciOn = false;
    P.cuSeed = seed(); P.scSeed = seed(); P.acSeed = seed(); P.ciSeed = seed();
    const lcl = clamp(0.025*(100 - P.humidity) + G()*0.1, 0.4, 3.2);   // km
    const cu = (cov, dev) => { P.cuOn = true; P.cuCover = clamp(cov, 0.03, 0.85); P.cuDev = clamp(dev, 0, 1); P.cuBase = +lcl.toFixed(2);
      P.cuSize = clamp(U(0.8, 1.25) + G()*0.15*st, 0.5, 2); P.cuOrg = U(0.2, 0.85); P.cuStreets = R() < 0.15 + 0.15*st ? U(0.3, 0.9) : 0; P.cuShear = U(0.2, 1.1 + 0.6*st);
      // (deep convection: a few storms, not a sky of them; and mostly standing off at a distance, as such skies are usually shot,
      // rather than with the camera under a storm's base — sometimes under it all the same)
      if (P.cuDev > 0.6){ P.cuCover = Math.min(P.cuCover, U(0.12, 0.3)); P.cuClear = R() < 0.75 ? +U(0.5, 0.9).toFixed(2) : 0; } else P.cuClear = 0; };
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

/* ---------- match a plate: a photograph laid over the view, the sun, haze and aerosol fitted to patches of its clear sky ---------- */
// The plate is shown over Look around, scaled so its field of view matches the camera's; the person lines its horizon up by
// dragging, then clicks patches of clear sky (and shift-clicks the sun if it is in frame). The fit compares the patches'
// colours and their brightness relative to one another (the plate's exposure drops out) with the clear sky this tool renders
// for a candidate sun and haze — each candidate a small panorama without clouds — and walks the candidates downhill
// (Nelder–Mead), trying each aerosol type along the way. A plate decoded as sRGB: a graded or tone-mapped plate biases it.
const PLATE = {img: null, cv: null, ctx: null, w: 0, h: 0, samples: [], sun: null, sampling: false, solving: null};
function plateRect(){ const r = $('#view').getBoundingClientRect(), a = PLATE.w/PLATE.h; let pw = r.width, ph = pw/a; if (ph > r.height){ ph = r.height; pw = ph*a; } return {x: (r.width - pw)/2, y: (r.height - ph)/2, w: pw, h: ph, r}; }
function plateLayout(){
  const im = $('#plateImg'); if (!PLATE.img){ im.hidden = true; $('#plateMarks').innerHTML = ''; return; }
  im.hidden = view.mode !== 1; im.style.opacity = P.plateOp ?? 0.6;
  const pr = plateRect(), tv = Math.tan((+P.plateHfov || 60)*D2R/2)*PLATE.h/PLATE.w;
  view.fov = 2*Math.atan(tv*pr.r.height/pr.h); sendView(); plateMarks(); }
function plateMarks(){ const el = $('#plateMarks'); if (!PLATE.img || view.mode !== 1){ el.innerHTML = ''; return; } const pr = plateRect();
  el.innerHTML = PLATE.samples.map((s, i) => `<div class="pmark" style="left:${pr.x + s.px/PLATE.w*pr.w}px;top:${pr.y + s.py/PLATE.h*pr.h}px">${i + 1}</div>`).join('')
    + (PLATE.sun ? `<div class="pmark sun" style="left:${pr.x + PLATE.sun.px/PLATE.w*pr.w}px;top:${pr.y + PLATE.sun.py/PLATE.h*pr.h}px">☀</div>` : ''); }
function loadPlate(f){
  const url = URL.createObjectURL(f), img = new Image();
  img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d', {willReadFrequently: true}); ctx.drawImage(img, 0, 0);
    Object.assign(PLATE, {img, cv: c, ctx, w: c.width, h: c.height, samples: [], sun: null}); $('#plateImg').src = url;
    const vb = document.querySelector('#viewSeg button[data-v="1"]'); if (view.mode !== 1 && vb) vb.click();
    plateLayout(); $('#plateInfo').textContent = `${f.name}: ${c.width} × ${c.height}. Drag to line the horizon up, then pick sky patches.`; };
  img.onerror = () => { $('#plateInfo').textContent = `Could not read ${f.name} as an image.`; };
  img.src = url;
}
function pickPlate(){ const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp'; inp.onchange = () => { if (inp.files[0]) loadPlate(inp.files[0]); }; inp.click(); }
function clearPlate(){ Object.assign(PLATE, {img: null, samples: [], sun: null, sampling: false}); plateLayout(); $('#plateInfo').textContent = 'No plate.'; }
function togglePlateSampling(){ if (!PLATE.img){ $('#plateInfo').textContent = 'Load a plate first.'; return; } PLATE.sampling = !PLATE.sampling;
  setStatus(PLATE.sampling ? 'Click patches of clear sky on the plate (shift-click the sun); click “Pick sky patches” again to stop' : 'Done picking'); }
// (a click on the plate: its pixel, and the mean linear colour of a small patch round it)
function plateClick(e){
  const r = $('#view').getBoundingClientRect(), pr = plateRect(), px = (e.clientX - r.left - pr.x)/pr.w*PLATE.w, py = (e.clientY - r.top - pr.y)/pr.h*PLATE.h;
  if (px < 0 || py < 0 || px >= PLATE.w || py >= PLATE.h) return;
  if (e.shiftKey){ PLATE.sun = {px, py}; plateMarks(); return; }
  const rad = Math.max(2, Math.round(PLATE.w*0.004)), x0 = Math.max(0, Math.round(px) - rad), y0 = Math.max(0, Math.round(py) - rad), w = Math.min(PLATE.w - x0, 2*rad + 1), h = Math.min(PLATE.h - y0, 2*rad + 1);
  const d = PLATE.ctx.getImageData(x0, y0, w, h).data, lin = c => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); }; const m = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) m[j] += lin(d[i + j]);
  const n = d.length/4, rgb = m.map(v => v/n);
  if (Math.max(...rgb) > 0.98 || Math.min(...rgb) < 1e-4){ setStatus('That patch is clipped or black: pick another'); return; }
  PLATE.samples.push({px, py, rgb}); plateMarks(); $('#plateInfo').textContent = `${PLATE.samples.length} patch${PLATE.samples.length > 1 ? 'es' : ''} picked.`; }
// a plate pixel's direction (azimuth, elevation in degrees) as the view now stands
function plateDir(px, py){ const pr = plateRect(); const uv = screenToUV(pr.x + px/PLATE.w*pr.w, pr.y + py/PLATE.h*pr.h); return uv ? uvAzEl(uv) : null; }
// the clear sky for the settings as they stand: a 256 × 128 panorama, linear Rec.709
function probeSky(){ return new Promise(res => { sendParams(); const W = 256, arr = new Float32Array(W*W/2*3);
  const X = expStart({W, spp: 1, kind: 'probe', name: '', space: 'rec709', onDone: r => res(r.blob)}); X.writer = {add: async b => arr.set(b.L[0], b.y0*W*3), finish: () => arr}; }); }
function panoAt(arr, az, el){ const W = 256, H = 128, u = ((((az - (+P.azOff || 0))/360 + 0.5) % 1) + 1) % 1, v = clamp(0.5 - el/180, 0, 1);
  const x = u*W - 0.5, y = clamp(v*H - 0.5, 0, H - 1.001), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, o = [0, 0, 0];
  for (const [dx, dy, w] of [[0, 0, (1 - fx)*(1 - fy)], [1, 0, fx*(1 - fy)], [0, 1, (1 - fx)*fy], [1, 1, fx*fy]]){ const i = ((y0 + dy)*W + (((x0 + dx) % W) + W) % W)*3; for (let j = 0; j < 3; j++) o[j] += w*arr[i + j]; }
  return o; }
async function solvePlate(){
  if (PLATE.solving || EXP || TL || !worker || !ready) return;
  if (PLATE.samples.length < 3){ $('#plateInfo').textContent = 'Pick at least three patches of clear sky (five or more, spread out, fit better).'; return; }
  if (view.mode !== 1){ $('#plateInfo').textContent = 'Switch to Look around with the plate lined up first.'; return; }
  const dirs = PLATE.samples.map(s => plateDir(s.px, s.py)); if (dirs.some(d => !d)){ $('#plateInfo').textContent = 'Some patches are off the view: line the plate up again.'; return; }
  const sunD = PLATE.sun ? plateDir(PLATE.sun.px, PLATE.sun.py) : null, keepSun = !sunD && !!P.plateKeepSun;
  const saved = {cuOn: P.cuOn, scOn: P.scOn, acOn: P.acOn, ciOn: P.ciOn, mode: P.mode, crop: P.crop}, Sv = PLATE.solving = {stop: false};
  Object.assign(P, {cuOn: false, scOn: false, acOn: false, ciOn: false, mode: 'manual', crop: null});
  if (sunD){ P.sunAz = sunD[0]; P.sunEl = sunD[1]; }
  const lp = PLATE.samples.map(s => s.rgb.map(c => Math.log(Math.max(c, 1e-5))));
  let evals = 0; const t0 = performance.now();
  const cost = async x => { if (Sv.stop) throw new Error('stopped');
    const [az, el, la] = x; if (!sunD && !keepSun){ P.sunAz = ((az % 360) + 360) % 360; P.sunEl = clamp(el, -6, 90); } P.aod = clamp(Math.exp(la), 0.01, 2);
    const arr = await probeSky(); evals++;
    const lm = dirs.map(d => panoAt(arr, d[0], d[1]).map(c => Math.log(Math.max(c, 1e-9))));
    let k = 0, n = 0; for (let i = 0; i < lm.length; i++) for (let j = 0; j < 3; j++){ k += lp[i][j] - lm[i][j]; n++; } k /= n;   // (the exposure that fits best)
    let e = 0; for (let i = 0; i < lm.length; i++) for (let j = 0; j < 3; j++){ const d = lp[i][j] - lm[i][j] - k; e += d*d; }
    $('#plateInfo').textContent = `Fitting… ${evals} skies tried, error ${Math.sqrt(e/n).toFixed(3)} (log units)`; return e/n; };
  const nm = async (x0, steps, iters) => { // Nelder–Mead over the free coordinates
    const free = sunD || keepSun ? [2] : [0, 1, 2], dim = free.length, mk = v => { const x = [...x0]; free.forEach((f, i) => x[f] = v[i]); return x; };
    let S = [free.map(f => x0[f])]; for (let i = 0; i < dim; i++){ const v = [...S[0]]; v[i] += steps[free[i]]; S.push(v); }
    let F = []; for (const v of S) F.push(await cost(mk(v)));
    for (let it = 0; it < iters; it++){
      const o = F.map((f, i) => i).sort((a, b) => F[a] - F[b]); S = o.map(i => S[i]); F = o.map(i => F[i]);
      if (F[dim] - F[0] < 1e-5) break;
      const c = S[0].map((_, j) => S.slice(0, dim).reduce((a, v) => a + v[j], 0)/dim), at = t => c.map((cj, j) => cj + t*(S[dim][j] - cj));
      const xr = at(-1), fr = await cost(mk(xr));
      if (fr < F[0]){ const xe = at(-2), fe = await cost(mk(xe)); if (fe < fr){ S[dim] = xe; F[dim] = fe; } else { S[dim] = xr; F[dim] = fr; } }
      else if (fr < F[dim - 1]){ S[dim] = xr; F[dim] = fr; }
      else { const xc = at(fr < F[dim] ? -0.5 : 0.5), fc = await cost(mk(xc));
        if (fc < Math.min(fr, F[dim])){ S[dim] = xc; F[dim] = fc; }
        else for (let i = 1; i <= dim; i++){ S[i] = S[i].map((v, j) => S[0][j] + 0.5*(v - S[0][j])); F[i] = await cost(mk(S[i])); } } }
    const b = F.indexOf(Math.min(...F)); return {x: mk(S[b]), f: F[b]}; };
  let best = null;
  try {
    // (a coarse start: the sun's azimuth from the brightest patch's side of the sky, unless it is known)
    let x = [P.sunAz, Math.max(P.sunEl, 5), Math.log(P.aod || 0.1)];
    if (!sunD && !keepSun){ let bi = 0; PLATE.samples.forEach((s, i) => { if (s.rgb[1] > PLATE.samples[bi].rgb[1]) bi = i; }); x[0] = dirs[bi][0]; x[1] = Math.max(dirs[bi][1] + 15, 10); }
    best = await nm(x, [40, 15, 0.8], 40); best.type = P.aerosol;
    for (const t of Object.keys(AEROSOLS)){ if (t === best.type) continue; P.aerosol = t; const f = await cost(best.x); if (f < best.f) best = {x: best.x, f, type: t}; }
    P.aerosol = best.type; best = {...(await nm(best.x, [10, 5, 0.3], 25)), type: best.type};
  } catch (e){ if (e.message !== 'stopped') $('#plateInfo').textContent = `The fit failed: ${e.message}`; }
  Object.assign(P, saved); PLATE.solving = null;
  if (best){ if (!sunD && !keepSun){ P.sunAz = Math.round(((best.x[0] % 360) + 360) % 360*10)/10; P.sunEl = Math.round(clamp(best.x[1], -6, 90)*10)/10; }
    if (sunD){ P.sunAz = Math.round(sunD[0]*10)/10; P.sunEl = Math.round(sunD[1]*10)/10; } P.aod = +clamp(Math.exp(best.x[2]), 0.01, 2).toFixed(3); P.aerosol = best.type;
    if (saved.mode !== 'manual') P.mode = 'manual';
    $('#plateInfo').textContent = `Fitted in ${fmtSecs((performance.now() - t0)/1000)} (${evals} skies): sun ${P.sunEl}° up at ${P.sunAz}°, haze ${P.aod} (${AEROSOLS[P.aerosol].name}). Error ${Math.sqrt(best.f).toFixed(3)} in log colour${saved.mode !== 'manual' ? '; the sun is now set by hand' : ''}.`; }
  syncUI(); changed(); }

/* ---------- look-dev model: an .obj or .glb dropped in, shown in Look around with Look-dev on ---------- */
// Read into one list of triangles (position, normal), centred and scaled to a unit radius; normals made smooth where the file
// has none.
function parseOBJ(text){
  const V = [], N = [], verts = [], idx = [], key = new Map(); let hasN = true;
  const vert = (s) => { const k = s; let i = key.get(k); if (i !== undefined) return i;
    const [vi, , ni] = s.split('/'); const a = +vi < 0 ? V.length/3 + +vi : +vi - 1, b = ni ? (+ni < 0 ? N.length/3 + +ni : +ni - 1) : -1;
    if (b < 0) hasN = false; i = verts.length; verts.push([a, b]); key.set(k, i); return i; };
  for (const line of text.split('\n')){ const t = line.trim().split(/\s+/);
    if (t[0] === 'v') V.push(+t[1], +t[2], +t[3]); else if (t[0] === 'vn') N.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'f' && t.length > 3){ const f = t.slice(1).map(vert); for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]); } }
  const pos = new Float32Array(verts.length*3), nor = hasN ? new Float32Array(verts.length*3) : null;
  verts.forEach(([a, b], i) => { pos.set(V.slice(3*a, 3*a + 3), 3*i); if (nor) nor.set(N.slice(3*b, 3*b + 3), 3*i); });
  return {pos, nor, idx: new Uint32Array(idx), weldBy: hasN ? null : verts.map(v => v[0])};
}
function parseGLB(buf){
  const dv = new DataView(buf); if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a binary glTF (.glb)');
  let o = 12, json = null, bin = null;
  while (o < buf.byteLength){ const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 8, len))); else if (type === 0x004e4942) bin = new Uint8Array(buf, o + 8, len);
    o += 8 + len; }
  if (!json || !bin) throw new Error('the .glb has no mesh data');
  if ((json.extensionsRequired || []).length) throw new Error(`the .glb needs ${json.extensionsRequired.join(', ')} (compressed meshes are not read)`);
  const acc = i => { const a = json.accessors[i], bv = json.bufferViews[a.bufferView], n = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
    const C = {5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array, 5122: Int16Array, 5120: Int8Array}[a.componentType];
    const stride = bv.byteStride || n*C.BYTES_PER_ELEMENT, base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0), out = new Float32Array(a.count*n), d = new DataView(bin.buffer);
    const rd = {5126: (p) => d.getFloat32(p, true), 5125: (p) => d.getUint32(p, true), 5123: (p) => d.getUint16(p, true), 5121: (p) => d.getUint8(p), 5122: (p) => d.getInt16(p, true), 5120: (p) => d.getInt8(p)}[a.componentType];
    for (let k = 0; k < a.count; k++) for (let j = 0; j < n; j++) out[k*n + j] = rd(base + k*stride + j*C.BYTES_PER_ELEMENT);
    return out; };
  const mul = (a, b) => { const r = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j*4 + i] += a[k*4 + i]*b[j*4 + k]; return r; };
  const local = nd => { if (nd.matrix) return nd.matrix; const [x, y, z, w] = nd.rotation || [0, 0, 0, 1], [sx, sy, sz] = nd.scale || [1, 1, 1], t = nd.translation || [0, 0, 0];
    return [(1 - 2*(y*y + z*z))*sx, 2*(x*y + z*w)*sx, 2*(x*z - y*w)*sx, 0, 2*(x*y - z*w)*sy, (1 - 2*(x*x + z*z))*sy, 2*(y*z + x*w)*sy, 0, 2*(x*z + y*w)*sz, 2*(y*z - x*w)*sz, (1 - 2*(x*x + y*y))*sz, 0, t[0], t[1], t[2], 1]; };
  const P = [], Nn = [], I = []; let hasN = true;
  const visit = (ni, M) => { const nd = json.nodes[ni], W = mul(M, local(nd));
    if (nd.mesh !== undefined) for (const pr of json.meshes[nd.mesh].primitives){ if ((pr.mode ?? 4) !== 4) continue;
      const p = acc(pr.attributes.POSITION), n = pr.attributes.NORMAL !== undefined ? acc(pr.attributes.NORMAL) : null; if (!n) hasN = false;
      const b = P.length/3, cnt = p.length/3;
      for (let k = 0; k < cnt; k++){ const x = p[3*k], y = p[3*k + 1], z = p[3*k + 2];
        P.push(W[0]*x + W[4]*y + W[8]*z + W[12], W[1]*x + W[5]*y + W[9]*z + W[13], W[2]*x + W[6]*y + W[10]*z + W[14]);
        if (n){ const a = n[3*k], c = n[3*k + 1], e = n[3*k + 2]; Nn.push(W[0]*a + W[4]*c + W[8]*e, W[1]*a + W[5]*c + W[9]*e, W[2]*a + W[6]*c + W[10]*e); } else Nn.push(0, 0, 0); }
      if (pr.indices !== undefined){ for (const v of acc(pr.indices)) I.push(b + v); } else for (let k = 0; k < cnt; k++) I.push(b + k); }
    for (const c of nd.children || []) visit(c, W); };
  const sc = json.scenes ? json.scenes[json.scene || 0].nodes : json.nodes.map((_, i) => i);
  for (const r of sc) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {pos: new Float32Array(P), nor: hasN ? new Float32Array(Nn) : null, idx: new Uint32Array(I), weldBy: null};
}
// centred on its bounds, scaled to a unit radius, smooth normals where missing; interleaved position, normal
function meshPack(m){
  const p = m.pos, nv = p.length/3; let mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
  for (let i = 0; i < nv; i++) for (let j = 0; j < 3; j++){ mn[j] = Math.min(mn[j], p[3*i + j]); mx[j] = Math.max(mx[j], p[3*i + j]); }
  const c = mn.map((v, j) => (v + mx[j])/2); let r = 1e-9; for (let i = 0; i < nv; i++) r = Math.max(r, Math.hypot(p[3*i] - c[0], p[3*i + 1] - c[1], p[3*i + 2] - c[2]));
  let nor = m.nor;
  if (!nor){ nor = new Float32Array(nv*3); const w = m.weldBy, acc = w ? new Float32Array((w.reduce((a, b) => Math.max(a, b), 0) + 1)*3) : nor, at = i => w ? w[i] : i;
    for (let t = 0; t < m.idx.length; t += 3){ const [a, b, d] = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
      const e1 = [0, 1, 2].map(j => p[3*b + j] - p[3*a + j]), e2 = [0, 1, 2].map(j => p[3*d + j] - p[3*a + j]);
      const n = [e1[1]*e2[2] - e1[2]*e2[1], e1[2]*e2[0] - e1[0]*e2[2], e1[0]*e2[1] - e1[1]*e2[0]];
      for (const v of [a, b, d]) for (let j = 0; j < 3; j++) acc[3*at(v) + j] += n[j]; }
    if (w) for (let i = 0; i < nv; i++) for (let j = 0; j < 3; j++) nor[3*i + j] = acc[3*w[i] + j]; }
  const vtx = new Float32Array(nv*6);
  for (let i = 0; i < nv; i++){ const l = Math.hypot(nor[3*i], nor[3*i + 1], nor[3*i + 2]) || 1;
    for (let j = 0; j < 3; j++){ vtx[6*i + j] = (p[3*i + j] - c[j])/r; vtx[6*i + 3 + j] = nor[3*i + j]/l; } }
  return {vtx, idx: m.idx, tris: m.idx.length/3};
}
async function loadModelFile(f){
  try {
    const m = /\.glb$/i.test(f.name) ? parseGLB(await f.arrayBuffer()) : /\.obj$/i.test(f.name) ? parseOBJ(await f.text()) : null;
    if (!m) throw new Error('choose an .obj or a .glb file');
    if (!m.idx.length) throw new Error('no triangles found');
    const pk = meshPack(m); worker.postMessage({type:'mesh', vtx: pk.vtx, idx: pk.idx}, [pk.vtx.buffer, pk.idx.buffer]);
    if (!view.lookdev){ view.lookdev = true; $('#ldBtn').classList.add('on'); }
    const vb = document.querySelector('#viewSeg button[data-v="1"]'); if (view.mode !== 1 && vb) vb.click();
    sendView(); $('#ldInfo').textContent = `${f.name}: ${pk.tris.toLocaleString()} triangles.`;
  } catch (e){ $('#ldInfo').textContent = `Could not read ${f.name}: ${e.message}`; }
}
function pickModel(){ const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.obj,.glb'; inp.onchange = () => { if (inp.files[0]) loadModelFile(inp.files[0]); }; inp.click(); }
function clearModel(){ worker && worker.postMessage({type:'mesh', vtx: null, idx: null}); $('#ldInfo').textContent = 'No model.'; }

/* ---------- export ---------- */
// The worker renders in bands of rows and sends each band, layer by layer, as soon as it is done; the page compresses each
// band straight into the file's blocks and lets the floats go, so memory holds a band, not the image (8K and 16K, layered,
// fit). Colours come in the chosen colour space, unclipped: a colour outside its gamut keeps its negative components.
let EXP = null;
const LAYER_NAMES = ['sun', 'sky', 'moon', 'night'];
function sunInfo(){
  const d = (lastStatus && lastStatus.derived) || {}, m = (lastStatus && lastStatus.meter) || {};
  const az = d.sunAz ?? P.sunAz, el = d.sunEl ?? P.sunEl, rad = d.sunRad ?? 0.2666*D2R;
  return {az, el, rad, dni: m.dni || [0, 0, 0], tc: m.sunT ?? 1, up: el > -1};
}
function expStart(o){
  // o: {W, spp, kind: 'image' | 'haze' | 'frame', name, onDone, info}
  const kind = o.kind || 'image', layers = kind === 'image' && P.layers === 'layers', W = o.W, H = W/2;
  const space = o.space || P.expSpace || 'rec709', fmt = kind === 'haze' ? (P.format === 'exr16' ? 'exr16' : 'exr32') : layers && P.format === 'hdr' ? 'exr32' : P.format;
  const alpha = (kind === 'image' || kind === 'frame') && fmt !== 'hdr' && !!P.expAlpha, noSun = kind === 'image' && P.sunLight === 'split';
  const names = kind === 'haze' ? HAZE_D.flatMap(d => [`haze_${hazeNm(d)}`, `trans_${hazeNm(d)}`]) : layers ? LAYER_NAMES : [''];
  const X = EXP = {W, H, kind, layers, names, nL: names.length, fmt, space, alpha, noSun, name: o.name, info: o.info, onDone: o.onDone, sun: sunInfo(),
    units: P.units, pend: new Map(), q: Promise.resolve(), peak: 0, t0: performance.now(), err: null};
  X.writer = fmt === 'hdr' ? hdrWriter(W, H, space) : exrWriter(W, H, fmt === 'exr16', expChans(X), expAttrs(X));
  worker.postMessage({type:'export', W, spp: o.spp, units: P.units, layers, pt: P.cloudLight === 'pt', space, alpha, noSun,
    haze: kind === 'haze' ? HAZE_D : null, hazeShafts: kind === 'haze' && !!P.hazeShafts});
  return X;
}
// the file's channels: each layer's R, G, B — with light layers, the main R, G, B their sum — and, asked for, cloud.A (the
// clouds' opacity) and ground.A (the ground and horizon's holdout)
function expChans(X){
  const ch = [];
  if (X.layers) for (const c of [0, 1, 2]) ch.push({name: 'RGB'[c], li: -1, c});
  X.names.forEach((n, li) => { for (const c of [0, 1, 2]) ch.push({name: n ? `${n}.${'RGB'[c]}` : 'RGB'[c], li, c}); });
  if (X.alpha){ ch.push({name: 'cloud.A', a: 0}, {name: 'ground.A', a: 1}); }
  return ch;
}
function expAttrs(X){
  const s = X.sun, A = [['chromaticities', 'chromaticities', exrF32(CSPACE_XY[X.space])], ['envmap', 'envmap', new Uint8Array([0])]];
  if (X.kind !== 'haze' && s.up){ const k = X.units === 'watts' ? 1/683 : 1, rgb = mul3(CSPACE[X.space], s.dni).map(v => v*k);
    A.push(['sunAzimuth', 'float', exrF32([s.az])], ['sunElevation', 'float', exrF32([s.el])], ['sunAngularDiameter', 'float', exrF32([2*s.rad*R2D])],
      ['sunIrradiance', 'v3f', exrF32(rgb)], ['sunCloudTransmission', 'float', exrF32([s.tc])], ['sunInImage', 'int', exrI32([X.noSun ? 0 : 1])]); }
  A.push(['comments', 'string', new TextEncoder().encode(`Spectral Sky Next: ${CSPACE_NAME[X.space]}, ${X.units === 'watts' ? 'radiance in W/(m2 sr) (luminance/683)' : 'luminance in cd/m2'}; north at azimuth ${(+P.azOff || 0).toFixed(1)} deg from the image centre, east to the right.` + (X.noSun ? ' The sun disc is left out: light it with a distant light (sunIrradiance, normal to the beam, clear air; times sunCloudTransmission for the clouds over the camera).' : ''))]);
  return A;
}
function hazeNm(d){ return String(Math.round(d*1000)).padStart(5, '0') + 'm'; }
function expChunk(m){
  const X = EXP; if (!X || X.W !== m.W) return;
  let b = X.pend.get(m.y0); if (!b){ b = {y0: m.y0, rows: m.rows, L: [], A: null, n: 0}; X.pend.set(m.y0, b); }
  b.L[m.layer] = m.rgb; b.n++; if (m.alpha) b.A = m.alpha;
  if (b.n < X.nL) return;
  X.pend.delete(m.y0);
  if (X.kind === 'image' || X.kind === 'frame'){ const w = m.lumW, n = m.W*m.rows; let pk = X.peak;
    for (let i = 0; i < n; i++){ let y = 0; for (const l of b.L) y += w[0]*l[3*i] + w[1]*l[3*i + 1] + w[2]*l[3*i + 2]; if (y > pk) pk = y; } X.peak = pk; }
  X.q = X.q.then(() => X.writer.add(b)).catch(e => { X.err = e; });
}
async function expDone(secs){
  const X = EXP; if (!X) return; EXP = null;
  await X.q; if (X.err){ $('#expInfo').textContent = `Could not write the file (${X.err.message || X.err}).`; return; }
  const blob = X.writer.finish();
  X.onDone({X, blob, secs});
}
function startExport(){
  if (EXP || TL || !worker || !ready) return;
  const W = +P.outRes, spp = +P.outSpp;
  const name = `sky_el${Math.round(sunInfo().el)}_az${Math.round(sunInfo().az)}_${W}`;
  expStart({W, spp, kind: 'image', name, onDone: saveExport});
  $('#expInfo').textContent = `Rendering ${W} × ${W/2} at ${spp} samples…`;
}
// haze for comp: the air's own light and its transmission out to a set of distances, as EXR layers: a CG element at distance d
// composited as  element × trans_d + haze_d  sits in this sky's air (with the clouds' shadows in the air, asked for)
const HAZE_D = [0.25, 0.5, 1, 2, 5, 10, 20, 50];
function startHaze(){
  if (EXP || TL || !worker || !ready) return;
  const W = +P.hazeRes || 1024, spp = Math.min(+P.outSpp, 32);
  expStart({W, spp, kind: 'haze', name: `haze_el${Math.round(sunInfo().el)}_az${Math.round(sunInfo().az)}_${W}`, onDone: saveExport});
  $('#expInfo').textContent = `Rendering the haze at ${HAZE_D.length} distances, ${W} × ${W/2}…`;
}
async function saveExport({X, blob, secs}){
  const ext = X.fmt === 'hdr' ? '.hdr' : '.exr', files = [{name: X.name + ext, blob}];
  const rig = X.kind === 'image' && (X.noSun || P.expRig) && X.sun.up;
  if (rig) files.push(...rigFiles(X, X.name + ext));
  try { await deliver(files, X.name, t => { $('#expInfo').textContent = t; }); }
  catch (e){ $('#expInfo').textContent = e && e.code === 'declined' ? 'Download declined.' : `Could not save the file (${e && e.code || e && e.message || e}).`; return; }
  const u = P.units === 'watts' ? 'W·m⁻²·sr⁻¹' : 'cd/m²';
  $('#expInfo').textContent = `Rendered ${X.W} × ${X.H} in ${fmtSecs(secs)} and downloaded (${(blob.size/1048576).toFixed(0)} MB, ${CSPACE_NAME[X.space]}).` + (X.kind === 'haze' ? '' : ` Peak ${X.peak.toPrecision(3)} ${u}.`) + (rig ? ' With the sun light as JSON, USD and Nuke files.' : '');
}
// hands files over: inside Claude through the page's downloads capability, which takes .zip (so always a zip there); on
// its own page a single file as is, several as a zip
async function deliver(files, name, say){
  const dl = await claudeDownloads();
  if (dl || files.length > 1){ say && say('Packing into a zip…'); const z = await zipFiles(files, f => say && say(`Packing into a zip… ${Math.round(f*100)}%`));
    if (dl){ await dl.save({filename: name + '.zip', data: z}); return; } files = [{name: name + '.zip', blob: z}]; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(files[0].blob); a.download = files[0].name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------- the sun as a separate light: JSON, USD (.usda) and Nuke (.nk) companions ----------
// Directions in the companions follow the OpenEXR latitude-longitude convention that USD dome lights use: Y up, the image's
// centre toward +Z, its right-hand side toward −X. So the scene's +Z looks at the panorama's centre (azimuth azOff from
// north), and a DomeLight with no rotation lines up with the sun light.
function rigData(X, file){
  const s = X.sun, k = X.units === 'watts' ? 1/683 : 1, M = CSPACE[X.space], lumW = inv3(M)[1];
  const rgb = mul3(M, s.dni).map(v => v*k), E = s.dni[1]*k;
  const mx = Math.max(...rgb, 1e-30), col = rgb.map(v => v/mx), lc = lumW[0]*col[0] + lumW[1]*col[1] + lumW[2]*col[2];
  const a = (s.az - (+P.azOff || 0))*D2R, e = s.el*D2R, dir = [-Math.sin(a)*Math.cos(e), Math.sin(e), Math.cos(a)*Math.cos(e)];
  const u = ((((s.az - (+P.azOff || 0))/360 + 0.5) % 1) + 1) % 1, v = 0.5 - s.el/180, om = 2*Math.PI*(1 - Math.cos(s.rad));
  return {s, E, rgb, col, lc, dir, u, v, om, file, units: X.units === 'watts' ? 'W/m2 (radiance W/(m2 sr))' : 'lux (luminance cd/m2)'};
}
function rigFiles(X, file){
  const r = rigData(X, file), f = (x, n = 6) => Number(x.toPrecision(n)), base = X.name;
  const json = {generator: 'Spectral Sky Next', image: file, colorSpace: CSPACE_NAME[X.space], units: r.units,
    sunInImage: !X.noSun, sun: {azimuthDeg: f(r.s.az), elevationDeg: f(r.s.el), angularDiameterDeg: f(2*r.s.rad*R2D),
      direction_yUp_centreZ: r.dir.map(x => f(x)), imageUV: [f(r.u), f(r.v)],
      irradianceRGB_clearAir: r.rgb.map(x => f(x)), illuminance_clearAir: f(r.E), cloudTransmissionAtCamera: f(r.s.tc),
      irradianceRGB_throughClouds: r.rgb.map(x => f(x*r.s.tc)), discMeanRadianceRGB: r.rgb.map(x => f(x/r.om)),
      colour: r.col.map(x => f(x, 5)), intensityForColour: f(r.E/r.lc)},
    panorama: {northAzimuthOfCentreDeg: f(+P.azOff || 0), centreDirection: '+Z', rightDirection: '-X', up: '+Y'}};
  // (a matrix whose third row is the sun's direction: a distant light shines down its own −Z, from the sun toward the scene)
  const zA = r.dir, xA = (() => { const c = [zA[2], 0, -zA[0]], l = Math.hypot(...c); return l > 1e-6 ? c.map(x => x/l) : [1, 0, 0]; })();
  const yA = [zA[1]*xA[2] - zA[2]*xA[1], zA[2]*xA[0] - zA[0]*xA[2], zA[0]*xA[1] - zA[1]*xA[0]];
  const m4 = `( (${xA.map(x => f(x, 8)).join(', ')}, 0), (${yA.map(x => f(x, 8)).join(', ')}, 0), (${zA.map(x => f(x, 8)).join(', ')}, 0), (0, 0, 0, 1) )`;
  const usda = `#usda 1.0
(
    defaultPrim = "SkyRig"
    upAxis = "Y"
    metersPerUnit = 1
    doc = """Spectral Sky Next light rig for ${file}: ${CSPACE_NAME[X.space]}, ${r.units}.
The panorama's centre faces +Z (azimuth ${f(+P.azOff || 0, 4)} deg from north), east is -X. ${X.noSun ? 'The sun disc is not in the image: the DistantLight carries it.' : 'The sun disc is also in the image: deactivate the DistantLight or the dome will light twice.'}
Sun intensity is the clear-air illuminance normal to the beam; the clouds over the camera pass ${f(r.s.tc, 3)} of it (a shadow matte or the scene's own clouds shadow it). Renderers differ in how they read DistantLight intensity and dome orientation: check the sun's shadow against the sun in the dome."""
)

def Xform "SkyRig"
{
    def DomeLight "Sky"
    {
        asset inputs:texture:file = @./${file}@
        token inputs:texture:format = "latlong"
        float inputs:intensity = 1
        float inputs:exposure = 0
        color3f inputs:color = (1, 1, 1)
    }

    def DistantLight "Sun" (
        active = ${X.noSun ? 'true' : 'false'}
    )
    {
        float inputs:angle = ${f(2*r.s.rad*R2D, 5)}
        color3f inputs:color = (${r.col.map(x => f(x, 5)).join(', ')})
        float inputs:intensity = ${f(r.E/r.lc)}
        float inputs:exposure = 0
        bool inputs:normalize = 1
        matrix4d xformOp:transform = ${m4}
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }
}
`;
  // Nuke: the panorama read in, and a DirectLight (which shines down its −Z) turned toward the scene from the sun; rotate
  // order ZXY, so the light's +Z is (cos rx sin ry, −sin rx, cos rx cos ry). Its intensity is the radiance of a white matte
  // card facing the sun (illuminance/π), as Nuke's renderer gives a white card under a light of intensity 1 the value 1.
  const rx = -Math.asin(clamp(r.dir[1], -1, 1))*R2D, ry = Math.atan2(r.dir[0], r.dir[2])*R2D;
  const nk = `set cut_paste_input [stack 0]
version 13.0 v1
Read {
 inputs 0
 file "[file dirname [value root.name]]/${file}"
 format "${X.W} ${X.H} 0 0 ${X.W} ${X.H} 1 "
 colorspace linear
 raw true
 name SkyPanorama
 xpos 0
 ypos 0
}
Environment {
 name SkyEnvironment
 xpos 0
 ypos 100
}
DirectLight {
 inputs 0
 rot_order ZXY
 rotate {${f(rx, 6)} ${f(ry, 6)} 0}
 color {${r.col.map(x => f(x, 5)).join(' ')}}
 intensity ${f(r.E/r.lc/Math.PI)}
 disable ${X.noSun ? 'false' : 'true'}
 name Sun
 label "elevation ${f(r.s.el, 4)}  azimuth ${f(r.s.az, 4)}"
 xpos 150
 ypos 100
}
StickyNote {
 inputs 0
 name SkyNotes
 label "Spectral Sky Next: ${CSPACE_NAME[X.space]}, ${r.units}.\\nPanorama centre toward +Z (azimuth ${f(+P.azOff || 0, 4)} from north), east toward -X.\\nSun at image UV ${f(r.u, 5)} ${f(r.v, 5)}. Clouds over the camera pass ${f(r.s.tc, 3)} of the sun.\\nCheck the light's direction against the sun in the panorama: renderers differ in spherical-map orientation."
 xpos 300
 ypos 0
}
`;
  const t = new TextEncoder();
  return [{name: base + '_sun.json', blob: new Blob([JSON.stringify(json, null, 2)])}, {name: base + '_rig.usda', blob: new Blob([t.encode(usda)])}, {name: base + '_rig.nk', blob: new Blob([t.encode(nk)])}];
}

// ---------- timelapse: frames over a span of time — the clouds drifting with the wind and, with a place set, the sun moving ----------
// (each frame rendered like an export and written into one zip as it is done)
let TL = null;
async function startTimelapse(){
  if (TL || EXP || !worker || !ready) return;
  const n = clamp(Math.round(+P.tlFrames || 24), 2, 600), span = (+P.tlSpan || 30)/60, W = +P.tlRes || 1024, spp = +P.outSpp;
  const base = {...P}, t0h = (() => { const [hh, mm] = (P.time || '12:00').split(':').map(Number); return hh + mm/60; })();
  TL = {cancelled: false}; const files = [], t0 = performance.now();
  try {
    for (let i = 0; i < n && !TL.cancelled; i++){
      const th = span*i/(n - 1);
      P.tlHours = th;
      if (P.mode === 'location'){ const tt = t0h + th, d = Math.floor(tt/24), hh = ((tt % 24) + 24) % 24; P.time = `${String(Math.floor(hh)).padStart(2, '0')}:${String(Math.floor((hh % 1)*60 + 1e-6)).padStart(2, '0')}`;
        if (d){ const dt = new Date(base.date + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + d); P.date = dt.toISOString().slice(0, 10); } }
      sendParams();
      const R = await new Promise(res => { const pl = P.layers, ps = P.sunLight; P.layers = 'beauty'; P.sunLight = 'dome';
        try { expStart({W, spp, kind: 'frame', name: '', onDone: res}); } finally { P.layers = pl; P.sunLight = ps; } TL.res = res; });
      if (TL.cancelled || !R) break;
      files.push({name: `frame_${String(i + 1).padStart(4, '0')}${P.format === 'hdr' ? '.hdr' : '.exr'}`, blob: R.blob});
      const el = (performance.now() - t0)/1000; $('#tlInfo').textContent = `Frame ${i + 1} of ${n} done, about ${fmtSecs(el/(i + 1)*(n - i - 1))} left`;
    }
  } finally { Object.assign(P, {tlHours: 0, time: base.time, date: base.date}); sendParams(); syncUI(); }
  if (TL.cancelled){ TL = null; $('#tlInfo').textContent = 'Timelapse cancelled.'; return; }
  TL = null;
  const name = `timelapse_${n}f_${Math.round(span*60)}min`;
  const z = await zipFiles(files, f => { $('#tlInfo').textContent = `Packing into a zip… ${Math.round(f*100)}%`; });
  try { await deliver([{name: name + '.zip', blob: z}], name); } catch (e){ $('#tlInfo').textContent = `Could not save the file (${e && e.code || e}).`; return; }
  $('#tlInfo').textContent = `${n} frames over ${Math.round(span*60)} minutes rendered in ${fmtSecs((performance.now() - t0)/1000)} and downloaded as a zip.`;
}
function cancelTimelapse(){ if (!TL) return; TL.cancelled = true; const r = TL.res; cancelExport(); r && r(null); }
// ---------- the cloud volume for other software: a grid of extinction around the camera, with loaders for Houdini and Blender ----------
// (the grid is in the light rig's frame — Y up, +Z toward the panorama's centre, −X to its right — so it lines up with the
// .usda/.nk sun and dome; the ground under the camera at the origin)
let VXX = null;
function startVolume(){
  if (VXX || !worker || !ready) return;
  const km = +P.vxKm || 10, nx = +P.vxRes || 256;
  VXX = {km, nx, parts: [], name: `cloud_volume_${km}km_${nx}`};
  $('#vxInfo').textContent = `Sampling the clouds over ${km} km…`;
  worker.postMessage({type:'volExport', nx, km, az: (+P.azOff || 0)*D2R});
}
function cancelVolume(){ if (!VXX) return; worker.postMessage({type:'volCancel'}); VXX = null; $('#vxInfo').textContent = 'Volume export cancelled.'; }
async function finishVolume(secs){
  const X = VXX; if (!X) return; VXX = null;
  const g = X.grid, vm = g.vox*1000, meta = {generator: 'Spectral Sky Next', file: 'cloud_density.f16', dtype: 'float16 little-endian', order: 'x fastest, then y, then z',
    resolution: [g.nx, g.ny, g.nz], voxelSize_m: vm, origin_m: [-X.km*500, g.y0*1000, -X.km*500],
    quantity: 'extinction coefficient', storedUnits: '1/km', toPerMetre: 0.001,
    frame: {up: '+Y', centreOfPanorama: '+Z', rightOfPanorama: '-X', northAzimuthOfPanoramaCentreDeg: +P.azOff || 0, groundUnderCamera: [0, 0, 0], cameraHeight_m: (+P.camH || 0)*1000},
    note: 'Voxel (i, j, k) covers origin + [i, j, k]·voxelSize to origin + [i+1, j+1, k+1]·voxelSize. Ground is flat here (the curvature of the Earth is taken out). Single-scattering albedo of cloud droplets ~1 (no absorption).'};
  const houdini = `# Spectral Sky Next cloud volume -> Houdini.
# Paste into a Python SOP (in a Geometry node), set FOLDER to the unzipped folder, then append a
# Convert VDB SOP (Convert To: VDB) for a VDB. Units: metres; density is extinction per metre.
import json, os
import numpy as np
import hou
FOLDER = hou.text.expandString("$HIP/${X.name}")
meta = json.load(open(os.path.join(FOLDER, "cloud_volume.json")))
nx, ny, nz = meta["resolution"]
a = np.fromfile(os.path.join(FOLDER, meta["file"]), dtype="<f2").astype(np.float32) * meta["toPerMetre"]
vs = meta["voxelSize_m"]; o = meta["origin_m"]
geo = hou.pwd().geometry()
vol = geo.createVolume(nx, ny, nz, hou.BoundingBox(o[0], o[1], o[2], o[0] + nx*vs, o[1] + ny*vs, o[2] + nz*vs))
vol.setAllVoxelsFromString(a.tobytes())   # (x fastest, then y, then z, as Houdini stores them)
geo.addAttrib(hou.attribType.Prim, "name", "")
vol.setAttribValue("name", "density")
`;
  const blender = `# Spectral Sky Next cloud volume -> Blender (writes a .vdb next to the data and imports it).
# Run in Blender's Text Editor with FOLDER set to the unzipped folder. Blender is Z up: the grid's
# Y (height) becomes Z and its +Z (toward the panorama's centre) becomes -Y. Density is extinction per metre:
# use a Principled Volume with Density 1.
import bpy, json, os
import numpy as np
try:
    import openvdb as vdb
except ImportError:
    import pyopenvdb as vdb
FOLDER = r"${X.name}"
if not os.path.isabs(FOLDER):
    FOLDER = os.path.join(bpy.path.abspath("//"), FOLDER)
meta = json.load(open(os.path.join(FOLDER, "cloud_volume.json")))
nx, ny, nz = meta["resolution"]
a = np.fromfile(os.path.join(FOLDER, meta["file"]), dtype="<f2").astype(np.float32).reshape(nz, ny, nx) * meta["toPerMetre"]
b = np.ascontiguousarray(a.transpose(2, 0, 1)[:, ::-1, :])   # [x, -z, y]
vs = meta["voxelSize_m"]; o = meta["origin_m"]
g = vdb.FloatGrid(); g.name = "density"; g.copyFromArray(b)
t = (o[0] + 0.5*vs, -(o[2] + nz*vs) + 0.5*vs, o[1] + 0.5*vs)
g.transform = vdb.createLinearTransform([[vs, 0, 0, 0], [0, vs, 0, 0], [0, 0, vs, 0], [t[0], t[1], t[2], 1]])
path = os.path.join(FOLDER, "cloud_density.vdb")
vdb.write(path, grids=[g])
bpy.ops.object.volume_import(filepath=path)
`;
  const t = new TextEncoder(), files = [{name: `${X.name}/cloud_density.f16`, blob: new Blob(X.parts)}, {name: `${X.name}/cloud_volume.json`, blob: new Blob([JSON.stringify(meta, null, 2)])},
    {name: `${X.name}/houdini_load_volume.py`, blob: new Blob([t.encode(houdini)])}, {name: `${X.name}/blender_load_volume.py`, blob: new Blob([t.encode(blender)])}];
  if (X.onDone){ X.onDone({meta, files}); return; }   // (tests)
  const z = await zipFiles(files, f => { $('#vxInfo').textContent = `Packing into a zip… ${Math.round(f*100)}%`; });
  try { await deliver([{name: X.name + '.zip', blob: z}], X.name); } catch (e){ $('#vxInfo').textContent = `Could not save the file (${e && e.code || e}).`; return; }
  $('#vxInfo').textContent = `Cloud volume ${g.nx} × ${g.ny} × ${g.nz} (${vm.toFixed(0)} m voxels) sampled in ${fmtSecs(secs)} and downloaded (${(z.size/1048576).toFixed(0)} MB) with Houdini and Blender loaders.`;
}
function volMsg(m){
  if (m.type === 'vxStart'){ if (VXX) VXX.grid = m; }
  else if (m.type === 'vxChunk'){ if (VXX) VXX.parts.push(m.data); }
  else if (m.type === 'vxProgress'){ if (VXX) $('#vxInfo').textContent = `Sampling the clouds: ${Math.round(m.f*100)}%, ${fmtSecs(m.secs/m.f - m.secs)} left`; }
  else if (m.type === 'vxDone') finishVolume(m.secs);
  else if (m.type === 'vxError'){ VXX = null; $('#vxInfo').textContent = m.text; }
}
let SMX = null;
function startMatte(){
  if (SMX || !worker || !ready) return;
  const N = +P.smRes, km = +P.smKm;
  SMX = {N, km, rgb: new Float32Array(N*N*3), name: `shadow_matte_${km}km_sun_el${Math.round(P.sunEl)}_az${Math.round(P.sunAz)}_${N}`};
  $('#smInfo').textContent = `Tracing the clouds' shadow over ${km} km at ${N} × ${N}…`;
  worker.postMessage({type:'shadowMatte', N, km});
}
async function finishMatte(secs){
  const X = SMX; if (!X) return; SMX = null;
  if (X.onDone){ X.onDone({N: X.N, rgb: X.rgb}); return; }   // (tests)
  const w = exrWriter(X.N, X.N, false, [0, 1, 2].map(c => ({name: 'RGB'[c], li: 0, c})), [['comments', 'string', new TextEncoder().encode('Spectral Sky Next shadow matte, top-down, north up: R sun transmission, G sky transmission, B optical depth toward the sun.')]]);
  for (let y = 0; y < X.N; y += 256){ const rows = Math.min(256, X.N - y); await w.add({y0: y, rows, L: [X.rgb.subarray(y*X.N*3, (y + rows)*X.N*3)]}); $('#smInfo').textContent = `Encoding… ${Math.round(y/X.N*100)}%`; }
  try { await deliver([{name: X.name + '.exr', blob: w.finish()}], X.name); }
  catch (e){ $('#smInfo').textContent = e && e.code === 'declined' ? 'Download declined.' : `Could not save the file (${e && e.code || e}).`; return; }
  let mn = 1; for (let i = 0; i < X.rgb.length; i += 3) mn = Math.min(mn, X.rgb[i]);
  $('#smInfo').textContent = `Shadow matte ${X.N} × ${X.N} over ${X.km} km traced in ${fmtSecs(secs)} and downloaded. Darkest sun transmission ${mn.toPrecision(2)}.`;
}
function cancelExport(){ if (!EXP) return; worker.postMessage({type:'exportCancel'}); EXP = null; $('#expInfo').textContent = 'Export cancelled.'; }
const fmtSecs = s => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s/60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
let dlNs;
async function claudeDownloads(){ if (dlNs !== undefined) return dlNs; try { dlNs = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e){ dlNs = null; } return dlNs; }

// ---------- zip (stored: the files inside are compressed already), read back as a stream for the CRC, ZIP64 past 4 GB ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crcBlob(blob, onProg, done0, total){
  let c = 0xffffffff, done = done0; const rd = blob.stream().getReader();
  for (;;){ const {value, done: end} = await rd.read(); if (end) break;
    for (let i = 0; i < value.length; i++) c = CRC_T[(c ^ value[i]) & 255] ^ (c >>> 8);
    done += value.length; onProg && onProg(done/total); }
  return (c ^ 0xffffffff) >>> 0;
}
async function zipFiles(files, onProg){
  const parts = [], cen = []; let off = 0; const total = files.reduce((a, f) => a + f.blob.size, 0) || 1; let done = 0;
  const B = 0xffffffff, big = x => x >= B;
  for (const f of files){
    const nm = new TextEncoder().encode(f.name), n = f.blob.size, crc = await crcBlob(f.blob, onProg, done, total); done += n;
    const z64 = big(n) || big(off);
    const loc = new DataView(new ArrayBuffer(30 + (z64 ? 20 : 0))); loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, z64 ? 45 : 20, true); loc.setUint32(14, crc, true);
    loc.setUint32(18, z64 ? B : n, true); loc.setUint32(22, z64 ? B : n, true); loc.setUint16(26, nm.length, true); loc.setUint16(28, z64 ? 20 : 0, true);
    const c = new DataView(new ArrayBuffer(46 + (z64 ? 28 : 0))); c.setUint32(0, 0x02014b50, true); c.setUint16(4, z64 ? 45 : 20, true); c.setUint16(6, z64 ? 45 : 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, z64 ? B : n, true); c.setUint32(24, z64 ? B : n, true); c.setUint16(28, nm.length, true); c.setUint16(30, z64 ? 28 : 0, true); c.setUint32(42, z64 ? B : off, true);
    const lx = z64 ? (() => { const x = new DataView(new ArrayBuffer(20)); x.setUint16(0, 1, true); x.setUint16(2, 16, true); x.setBigUint64(4, BigInt(n), true); x.setBigUint64(12, BigInt(n), true); return [x]; })() : [];
    const cx = z64 ? (() => { const x = new DataView(new ArrayBuffer(28)); x.setUint16(0, 1, true); x.setUint16(2, 24, true); x.setBigUint64(4, BigInt(n), true); x.setBigUint64(12, BigInt(n), true); x.setBigUint64(20, BigInt(off), true); return [x]; })() : [];
    // (the local header's extra field follows the name, the central one's too)
    parts.push(new Uint8Array(loc.buffer, 0, 30), nm, ...lx, f.blob); cen.push(new Uint8Array(c.buffer, 0, 46), nm, ...cx);
    off += 30 + nm.length + (z64 ? 20 : 0) + n; }
  const cdLen = cen.reduce((a, x) => a + (x.byteLength ?? x.size), 0), tail = [];
  if (big(off) || big(cdLen) || files.length >= 0xffff){
    const e64 = new DataView(new ArrayBuffer(56)); e64.setUint32(0, 0x06064b50, true); e64.setBigUint64(4, 44n, true); e64.setUint16(12, 45, true); e64.setUint16(14, 45, true);
    e64.setBigUint64(24, BigInt(files.length), true); e64.setBigUint64(32, BigInt(files.length), true); e64.setBigUint64(40, BigInt(cdLen), true); e64.setBigUint64(48, BigInt(off), true);
    const loc = new DataView(new ArrayBuffer(20)); loc.setUint32(0, 0x07064b50, true); loc.setBigUint64(8, BigInt(off + cdLen), true); loc.setUint32(16, 1, true);
    tail.push(e64, loc); }
  const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, Math.min(files.length, 0xffff), true); end.setUint16(10, Math.min(files.length, 0xffff), true);
  end.setUint32(12, Math.min(cdLen, B), true); end.setUint32(16, Math.min(off, B), true);
  return new Blob([...parts, ...cen, ...tail, end], {type: 'application/zip'});
}

// ---------- OpenEXR (scanline, ZIP compression in blocks of 16 lines) and Radiance HDR writers, fed band by band ----------
function toHalf(v){ const f = toHalf.f, u = toHalf.u; f[0] = v; const x = u[0]; const s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0){ if (e < -10) return s; m = (m | 0x800000) >>> (1 - e); return s | ((m + 0x1000) >>> 13); } if (e >= 31) return s | 0x7bff; return s | Math.min((e << 10) + ((m + 0x1000) >>> 13), 0x7bff); }   // (added, not or'ed: rounding can carry into the exponent)
toHalf.f = new Float32Array(1); toHalf.u = new Uint32Array(toHalf.f.buffer);
async function deflate(u8){ const cs = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate')); return new Uint8Array(await new Response(cs).arrayBuffer()); }
const exrF32 = a => { const b = new Uint8Array(a.length*4), d = new DataView(b.buffer); a.forEach((v, i) => d.setFloat32(4*i, v, true)); return b; };
const exrI32 = a => { const b = new Uint8Array(a.length*4), d = new DataView(b.buffer); a.forEach((v, i) => d.setInt32(4*i, v, true)); return b; };
// chans: [{name, li, c}] (li −1: the sum of all layers) or [{name, a}] (a band's second-buffer values, two per pixel);
// attrs: [[name, type, bytes]] beyond the required ones. Each band: {y0, rows, L: [Float32Array rows·W·3 per layer], A}.
function exrWriter(W, H, half, chans, attrs){
  chans = [...chans].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);   // (EXR channels are stored in name order)
  const NC = chans.length, zip = typeof CompressionStream !== 'undefined', lines = zip ? 16 : 1, bpp = half ? 2 : 4;
  const enc = new TextEncoder(), hdr = [], put = u8 => { for (let i = 0; i < u8.length; i++) hdr.push(u8[i]); }, pushStr = s => { put(enc.encode(s)); hdr.push(0); };
  const i32 = v => put(exrI32([v])), f32v = v => put(exrF32([v]));
  hdr.push(0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0);
  const nameLen = chans.reduce((a, c) => a + enc.encode(c.name).length + 1, 0);
  pushStr('channels'); pushStr('chlist'); i32(nameLen + NC*16 + 1); for (const c of chans){ pushStr(c.name); i32(half ? 1 : 2); hdr.push(0, 0, 0, 0); i32(1); i32(1); } hdr.push(0);
  pushStr('compression'); pushStr('compression'); i32(1); hdr.push(zip ? 3 : 0);
  pushStr('dataWindow'); pushStr('box2i'); i32(16); i32(0); i32(0); i32(W - 1); i32(H - 1);
  pushStr('displayWindow'); pushStr('box2i'); i32(16); i32(0); i32(0); i32(W - 1); i32(H - 1);
  pushStr('lineOrder'); pushStr('lineOrder'); i32(1); hdr.push(0);
  pushStr('pixelAspectRatio'); pushStr('float'); i32(4); f32v(1);
  pushStr('screenWindowCenter'); pushStr('v2f'); i32(8); f32v(0); f32v(0);
  pushStr('screenWindowWidth'); pushStr('float'); i32(4); f32v(1);
  for (const [n, t, b] of attrs || []){ pushStr(n); pushStr(t); i32(b.length); put(b); }
  hdr.push(0);
  const nChunks = Math.ceil(H/lines), sizes = new Array(nChunks).fill(0), blobs = [];
  return {
    async add(b){
      const L = b.L, A = b.A;
      for (let j0 = 0; j0 < b.rows; j0 += lines){
        const y0 = b.y0 + j0, n = Math.min(lines, b.rows - j0, H - y0), raw = new Uint8Array(n*W*NC*bpp), dv = new DataView(raw.buffer); let o = 0;
        for (let j = 0; j < n; j++){ const row = (j0 + j)*W;
          for (const cc of chans){
            for (let x = 0; x < W; x++){ const i = row + x; let v;
              if (cc.a !== undefined) v = A ? A[2*i + cc.a] : 0;
              else if (cc.li >= 0) v = L[cc.li][3*i + cc.c];
              else { v = 0; for (const l of L) v += l[3*i + cc.c]; }
              if (half){ dv.setUint16(o, toHalf(Math.max(-65504, Math.min(v, 65504))), true); o += 2; } else { dv.setFloat32(o, v, true); o += 4; } } } }
        let data = raw;
        if (zip){ const t = new Uint8Array(raw.length), h2 = (raw.length + 1) >> 1; for (let i = 0, a = 0, bb = h2; i < raw.length; i += 2){ t[a++] = raw[i]; if (i + 1 < raw.length) t[bb++] = raw[i + 1]; }
          let p = t[0]; for (let i = 1; i < t.length; i++){ const d = (t[i] - p + 384) & 255; p = t[i]; t[i] = d; }
          const z = await deflate(t); if (z.length < raw.length) data = z; }
        const head = new Uint8Array(8), hv = new DataView(head.buffer); hv.setInt32(0, y0, true); hv.setInt32(4, data.length, true);
        sizes[Math.floor(y0/lines)] = 8 + data.length; blobs.push(new Blob([head, data]));
      }
    },
    finish(){
      const header = new Uint8Array(hdr), table = new Uint8Array(nChunks*8), tv = new DataView(table.buffer);
      let off = header.length + table.length; for (let c = 0; c < nChunks; c++){ tv.setBigUint64(c*8, BigInt(off), true); off += sizes[c]; }
      return new Blob([header, table, ...blobs], {type: 'application/octet-stream'});
    }};
}
function hdrWriter(W, H, space){
  const xy = CSPACE_XY[space] || CSPACE_XY.rec709;
  const parts = [new TextEncoder().encode(`#?RADIANCE\n# Spectral Sky Next: ${CSPACE_NAME[space]}, linear\nFORMAT=32-bit_rle_rgbe\nPRIMARIES= ${xy.join(' ')}\nEXPOSURE=1.0\n\n-Y ${H} +X ${W}\n`)];
  const ch = [new Uint8Array(W), new Uint8Array(W), new Uint8Array(W), new Uint8Array(W)];
  return {
    async add(b){ const rgb = b.L[0], out = [];
      for (let j = 0; j < b.rows; j++){
        for (let x = 0; x < W; x++){ const i = (j*W + x)*3; const r = Math.max(rgb[i], 0), g = Math.max(rgb[i + 1], 0), bl = Math.max(rgb[i + 2], 0), v = Math.max(r, g, bl);
          if (!(v >= 1e-32)){ ch[0][x] = ch[1][x] = ch[2][x] = ch[3][x] = 0; } else { let e = Math.floor(Math.log2(v)) + 1; let sc = Math.pow(2, -e)*256; if (v*sc >= 256){ e++; sc /= 2; }
            ch[0][x] = Math.floor(r*sc); ch[1][x] = Math.floor(g*sc); ch[2][x] = Math.floor(bl*sc); ch[3][x] = e + 128; } }
        out.push(2, 2, W >> 8, W & 255); for (let c = 0; c < 4; c++) rle(ch[c], W, out); }
      parts.push(new Blob([new Uint8Array(out)])); },
    finish: () => new Blob(parts, {type: 'application/octet-stream'})};
}
function rle(d, n, out){ let cur = 0;
  while (cur < n){ let beg = cur, run = 0, old = 0;
    while (run < 4 && beg < n){ beg += run; old = run; run = 1; while (beg + run < n && run < 127 && d[beg] === d[beg + run]) run++; }
    if (old > 1 && old === beg - cur){ out.push(128 + old, d[cur]); cur = beg; }
    while (cur < beg){ let nr = beg - cur; if (nr > 128) nr = 128; out.push(nr); for (let i = 0; i < nr; i++) out.push(d[cur + i]); cur += nr; }
    if (run >= 4){ out.push(128 + run, d[beg]); cur += run; } } }

// (files dropped on the page: a model for look-dev, an image as a plate to match)
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return;
  if (/\.(obj|glb)$/i.test(f.name)) loadModelFile(f); else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)) loadPlate(f); });

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
    else if (m.type === 'pick'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'probe'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'shot' || m.type === 'snap'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'pixels'){ const r = pending.get(m.id); pending.delete(m.id); if (r) r(m); }
    else if (m.type === 'exportChunk') expChunk(m);
    else if (m.type === 'exportProgress'){ if (EXP){ const el = m.secs, eta = m.f > 0.02 ? el/m.f - el : NaN; $('#expInfo').textContent = `Rendering ${EXP.W} × ${EXP.H}: ${Math.round(m.f*100)}%` + (isFinite(eta) ? `, about ${fmtSecs(eta)} left` : ''); setStatus(`Exporting · ${Math.round(m.f*100)}%`); } }
    else if (m.type === 'exportDone') expDone(m.secs);
    else if (m.type === 'smChunk'){ if (SMX && SMX.N === m.N){ const a = m.data, o = SMX.rgb, b = m.y0*m.N*3; for (let i = 0; i < m.rows*m.N; i++){ o[b + 3*i] = a[4*i]; o[b + 3*i + 1] = a[4*i + 1]; o[b + 3*i + 2] = a[4*i + 2]; } } }
    else if (m.type === 'smProgress'){ if (SMX) $('#smInfo').textContent = `Tracing the clouds' shadow: ${Math.round(m.f*100)}%`; }
    else if (m.type === 'smDone') finishMatte(m.secs);
    else if (m.type.startsWith('vx')) volMsg(m); };
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
  volume: (nx, km) => new Promise(res => { P.vxRes = nx; P.vxKm = km; startVolume(); if (VXX) VXX.onDone = async r => { const out = []; for (const f of r.files){ const u8 = new Uint8Array(await f.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); out.push({name: f.name, b64: btoa(s)}); } res(out); }; else res(null); }),
  matte: (N, km) => new Promise(res => { P.smRes = N; P.smKm = km; startMatte(); if (SMX) SMX.onDone = res; else res(null); }),
  shot: () => new Promise(res => { const id = ++rbId; pending.set(id, res); worker.postMessage({type:'shot', id}); }),
  // (an export as the page would write it, returned instead of downloaded: {files: [{name, b64}], peak, secs})
  exportTest: (o) => new Promise(res => { Object.assign(P, o.P || {}); syncUI(); sendParams();
    const kind = o.kind || 'image', X = expStart({W: o.W, spp: o.spp, kind, name: 'test', onDone: async ({X, blob, secs}) => {
      const files = [{name: 'test.' + (X.fmt === 'hdr' ? 'hdr' : 'exr'), blob}]; if (kind === 'image' && (X.noSun || P.expRig)) files.push(...rigFiles(X, 'test.exr'));
      const out = []; for (const f of files){ const u8 = new Uint8Array(await f.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); out.push({name: f.name, b64: btoa(s)}); }
      res({files: out, peak: X.peak, secs}); }}); }),
};
start();
