// Spectral Sky Next — physical state of the sky from the settings: sun and moon, air, aerosols, ozone, fog, ground.
// Produces the Frame uniform block (layout must match struct Frame in common.wgsl) and readouts for the UI.
'use strict';
const FRAME_LAYOUT = [
  ['BR', 6], ['BMs', 6], ['BMa', 6], ['BO', 6], ['Alb', 6], ['SunE', 6], ['MoonE', 6], ['SunK', 6], ['SunA', 6], ['MoonK', 6], ['Air', 6],
  ['CMFx', 6], ['CMFy', 6], ['CMFz', 6], ['Star', 96],
  ['atm', 1], ['atm2', 1], ['fogPh', 1], ['sunDir', 1], ['moonDir', 1], ['moonLight', 1], ['pole', 1], ['eqX', 1], ['eqY', 1], ['eqZ', 1],
  ['galX', 1], ['galY', 1], ['galZ', 1], ['opts', 1],
];
const FRAME_OFF = (() => { const o = {}; let n = 0; for (const [k, len] of FRAME_LAYOUT){ o[k] = n; n += len*4; } o._size = n; return o; })();

function utcMs(P){ const [y, m, d] = P.date.split('-').map(Number); const [hh, mm] = P.time.split(':').map(Number); return Date.UTC(y, (m||1) - 1, d||1, hh||0, mm||0) - P.utc*3600e3; }

// P: the settings. Returns {frame: Float32Array, atmKey, derived}. In 'location' mode the sun and moon come from the
// ephemerides and are written back into derived.sun/moon (the UI shows them).
function computeFrame(P){
  const utc = utcMs(P); let au = 1, moonDist = P.moonDistKm || 384400, lst = lstOnly(utc, P.lon);
  let sunAz = P.sunAz, sunEl = P.sunEl, moonAz = P.moonAz, moonEl = P.moonEl;
  if (P.mode === 'location'){ const e = ephemeris(utc, P.lat, P.lon); sunAz = e.saz; sunEl = e.sel; moonAz = e.maz; moonEl = e.mel; au = e.au; moonDist = e.dist; lst = e.lst; }
  const sd = dirAzEl(sunAz, sunEl), md = dirAzEl(moonAz, moonEl);
  let ml = V.norm(V.sub(V.mul(sd, 1.496e8*au), V.mul(md, moonDist)));
  let phase = Math.acos(clamp(V.dot(ml, V.mul(md, -1)), -1, 1));
  if (P.moonOverride){ phase = Math.acos(clamp(2*P.moonIllum - 1, -1, 1)); const vm = V.mul(md, -1); let e = V.sub(sd, V.mul(vm, V.dot(sd, vm)));
    if (V.len(e) < 1e-5) e = V.cross(vm, [0, 1, 0]); if (V.len(e) < 1e-5) e = [1, 0, 0]; e = V.norm(e);
    ml = V.norm(V.add(V.mul(vm, Math.cos(phase)), V.mul(e, Math.sin(phase)))); }
  const pole = dirAzEl(0, P.lat);
  const phi = P.lat*D2R, Lr = lst*D2R; const xp = [0, Math.cos(phi), -Math.sin(phi)], eW = [-1, 0, 0], zp = [0, Math.sin(phi), Math.cos(phi)];
  const eqX = V.add(V.mul(xp, Math.cos(Lr)), V.mul(eW, Math.sin(Lr))), eqY = V.sub(V.mul(xp, Math.sin(Lr)), V.mul(eW, Math.cos(Lr)));
  // diurnal boundary layer: dawn = shallow, cool, moist stable layer (haze trapped low, radiation mist);
  // dusk = deep afternoon mixed layer that has lofted dust and pollution to 1.5–2.5 km
  const low = 1 - smooth(-6, 35, sunEl), east = 0.5 + 0.5*Math.sin(sunAz*D2R);
  const dawn = P.diurnal ? low*east : 0, dusk = P.diurnal ? low*(1 - east) : 0;
  const RHp = clamp(P.humidity + 22*dawn - 8*dusk, 0, 97);
  const earthF = 1/(au*au), altK = Math.exp(-(P.siteAlt || 0)/8);
  const ae = AEROSOLS[P.aerosol] || AEROSOLS.continental; const RH = RHp/100;
  const grow = Math.pow((1 - RH)/0.5, -ae.hyg); const alphaE = ae.alpha*(1 - 0.25*clamp((RH - 0.5)/0.47, 0, 1));
  const aodE = P.aod*grow*(1 - 0.2*dawn + 0.25*dusk), HM = P.aerH*(1 - 0.45*dawn + 0.35*dusk), betaM550 = aodE/HM;
  const nO3 = P.ozone*2.687e20/15000;
  const mist = dawn*smooth(72, 96, RHp); const mistS = mist > 0.05 ? 3.912/(40 + (1.5 - 40)*mist) : 0;
  const userFog = P.fogVis >= 49.5 ? 0 : 3.912/P.fogVis;
  const fogS = userFog + mistS, fogH = userFog > 0 ? P.fogH : (mistS > 0 ? 0.06 : P.fogH);
  const surf = SURFACES[P.surface] || SURFACES.grey;
  const dropF = dropletPhase(11);
  const sunRad = 0.2666*D2R/au, omegaSun = 2*Math.PI*(1 - Math.cos(sunRad));
  const moonRad = Math.asin(1737.4/moonDist), omegaMoon = 2*Math.PI*(1 - Math.cos(moonRad));
  const phaseDeg = phase*R2D, allen = Math.pow(10, -0.4*(0.026*phaseDeg + 4e-9*phaseDeg**4));
  const meanALS = moonDiskMean(md, ml, pole);
  const F = new Float32Array(FRAME_OFF._size);
  const put = (k, i, v) => { F[FRAME_OFF[k] + i] = v; };
  for (let i = 0; i < NL; i++){ const l = LAM[i];
    const ext = betaM550*Math.pow(l/550, -alphaE); const ssa = 1 - (1 - ae.ssa(l))/Math.pow(grow, 0.7);
    put('BR', i, BETA_R[i]*altK); put('BMs', i, ext*ssa); put('BMa', i, ext*(1 - ssa)); put('BO', i, nO3*lerpT(O3XS, l)*1e-4*1000);
    put('Alb', i, surf.t ? lerpT(surf.t, l) : P.albedo);
    const Es = SOLAR_BIN[i]*earthF; put('SunE', i, Es);
    const alpha = -0.023 + 0.292/(l/1000); put('SunA', i, alpha); put('SunK', i, Es/(omegaSun*2/(alpha + 2)));
    const geoAlb = 0.12*(1 + 0.9*(l - 550)/550); const Em = Es*geoAlb*Math.pow(1737.4/moonDist, 2)*allen; put('MoonE', i, Em); put('MoonK', i, Em/(omegaMoon*meanALS));
    const phot = lnm => 7.958e8*1.98645e-25/(lnm*1e-9); let ag = 4*phot(l);
    for (const [ll, R] of [[557.7, 250], [589.3, 40], [630.0, 60], [636.4, 20]]) if (Math.abs(ll - l) <= 7.5) ag += R*phot(ll)/DL;
    put('Air', i, ag*P.airglow);
    put('CMFx', i, CMFX[i]); put('CMFy', i, CMFY[i]); put('CMFz', i, CMFZ[i]);
  }
  F.set(STAR_SPEC, FRAME_OFF.Star);
  const sunOn = sunEl > -14 ? 1 : 0, moonOn = (moonEl > -2 && sunEl < 2) ? 1 : 0;
  const v4 = (k, a, b, c, d) => F.set([a, b, c, d], FRAME_OFF[k]);
  v4('atm', 8.0, HM, fogS, fogH);
  v4('atm2', ae.g, P.camH, P.azOff*D2R, sunRad);
  v4('fogPh', dropF.gHG, dropF.gD, dropF.a, dropF.wD);
  v4('sunDir', ...sd, sunOn); v4('moonDir', ...md, moonOn); v4('moonLight', ...ml, moonRad*P.moonScale);
  v4('pole', ...pole, sunSquash(sunEl));
  v4('eqX', ...eqX, sunEl < 0 ? 1 : 0); v4('eqY', ...eqY, P.stars ? 1 : 0); v4('eqZ', ...zp, P.starMag);
  v4('galX', ...GALACTIC.x, P.mw); v4('galY', ...GALACTIC.y, Math.round(15*Math.log10(4600/2500))); v4('galZ', ...GALACTIC.z, P.includeSun ? 1 : 0);
  v4('opts', P.atmSteps || 32, P.groundMode === 'black' ? 1 : 0, P.includeSun ? 1 : 0, 0);
  // the tables depend only on the air and the ground, not on the sun (except the sky irradiance table, rebuilt per change)
  const atmKey = [aodE, HM, alphaE, fogS, fogH, P.aerosol, P.ozone, P.surface, P.albedo, RH, P.siteAlt || 0].map(v => typeof v === 'number' ? v.toPrecision(5) : v).join('|');
  const i550 = 11, h = P.camH, b550 = BETA_R[i550]*altK*Math.exp(-h/8) + (F[FRAME_OFF.BMs + i550] + F[FRAME_OFF.BMa + i550])*Math.exp(-h/HM) + fogS*Math.exp(-h/fogH);
  const derived = {sunAz, sunEl, moonAz, moonEl, vis:3.912/b550, aodE, illum:(1 + Math.cos(phase))/2, phaseDeg, RHp, dawn, dusk, mistVis:mistS ? 3.912/mistS : 0};
  return {frame:F, atmKey, derived};
}
