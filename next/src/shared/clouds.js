// Spectral Sky Next — cloud layers: from the settings to what the GPU builds the cloud volume from.
// Every cloud type is its own layer with its own controls; they are all built into one 3D volume and lit the same way.
'use strict';

// ---------- small deterministic random numbers (same clouds on every machine) ----------
function rng32(seed){ let h = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => { h = (h + 0x6d2b79f5) >>> 0; let z = h; z = Math.imul(z ^ (z >>> 15), z | 1); z ^= z + Math.imul(z ^ (z >>> 7), z | 61); return ((z ^ (z >>> 14)) >>> 0)/4294967296; }; }
const gaussR = r => Math.sqrt(-2*Math.log(Math.max(r(), 1e-12)))*Math.cos(2*Math.PI*r());
// smooth value noise in 2D (for the mesoscale moisture that groups clouds), deterministic
function vnoise2(x, y, seed){ const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const h = (i, j) => { let z = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0; z = Math.imul(z ^ (z >>> 13), 1274126177); return (((z ^ (z >>> 16)) >>> 0)/4294967296)*2 - 1; };
  const u = fx*fx*(3 - 2*fx), v = fy*fy*(3 - 2*fy);
  return (h(xi, yi)*(1 - u) + h(xi + 1, yi)*u)*(1 - v) + (h(xi, yi + 1)*(1 - u) + h(xi + 1, yi + 1)*u)*v; }
function fbm2(x, y, seed, oct){ let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++){ s += a*vnoise2(x, y, seed + 17*i); n += a; x *= 2.03; y *= 2.03; a *= 0.5; } return s/n; }

// ---------- the volume ----------
// camera-centred levels, each twice as wide as the one before; all span the same altitudes (0 … ZTOP km above the ground)
const VOL = {E0: 16, ZTOP: 16, NLEV: 6, SDF_LEVELS: 2, GRID: 2, DOMAIN: 512};
// altitude ↔ slice (as altToSlice / sliceToAlt in cloudu.wgsl)
const VZS = 6, VFZ = 0.75;
const altToSlice = (alt, nz) => alt < VZS ? alt/VZS*VFZ*nz : (VFZ + (alt - VZS)/(VOL.ZTOP - VZS)*(1 - VFZ))*nz;   // km; levels below SDF_LEVELS hold distances, the rest coverage

// ---------- cumulus: a field of individual clouds, each grown from rising thermals ----------
// Placement: clouds are dropped at random, more often where the mesoscale air is moist (a smooth random field ~25 km across)
// and, with cloud streets, along rolls lined up with the wind. Sizes follow the power law seen in satellite counts of cumulus
// fields (many small, few large; N(D) ∝ D^-b, b ≈ 1.7–2.3). Height grows with width, up to the top of the convection.
// Each cloud is stored as one record; its turrets (the bubbles of rising air that give the cauliflower shape) are made on the GPU
// from the cloud's seed.
function genCumulus(P, calib){
  const out = {clouds: [], top: 0, base: 1e9};
  if (!P.cuOn || !(P.cuCover > 0.001)) return out;
  const r = rng32(P.cuSeed*7919 + 13);
  const dev = clamp(P.cuDev, 0, 1);                        // 0 fair weather, 0.5 congestus, 1 cumulonimbus
  const size = P.cuSize;
  const Dmin = 0.3*size, Dmax = (1.6 + 7*Math.pow(dev, 1.4))*size;
  const b = 2.2 - 0.6*dev;                                  // shallower size spectrum as convection deepens
  const base = P.cuBase, capTop = base + 0.9 + 1.6*dev + 9*Math.pow(dev, 2.2);   // top of the convection (the inversion)
  const sig0 = (45 + 70*dev)*P.cuDens;                     // core extinction, 1/km
  const half = VOL.DOMAIN/2, A = VOL.DOMAIN*VOL.DOMAIN;
  const cover = clamp(P.cuCover, 0, 0.95);
  const org = clamp(P.cuOrg, 0, 1), streets = clamp(P.cuStreets, 0, 1);
  const wind = [P.windX || 5, P.windZ || 0], wl = Math.hypot(wind[0], wind[1]) || 1, wd = [wind[0]/wl, wind[1]/wl];
  const shear = [wd[0]*0.12*P.cuShear, wd[1]*0.12*P.cuShear];   // km of drift per km of height (tops lean downwind)
  const seedM = (P.cuSeed*31 + 5) | 0;
  // where clouds may form: mesoscale moisture (clustered fields have clear gaps and dense patches)
  // (tabulated on a 1 km grid: the placement loop looks it up hundreds of thousands of times)
  const MN = 513, mt = new Float32Array(MN*MN), st = new Float32Array(MN*MN);
  const rollSp0 = 2.6*(0.5 + base);
  for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++){ const x = i - half, z = j - half; mt[j*MN + i] = fbm2(x/26 + 3.1, z/26 + 7.7, seedM, 4); st[j*MN + i] = fbm2(x/9, z/9, seedM + 3, 2); }
  const lk = (t, x, z) => { const fx = clamp(x + half, 0, MN - 1.001), fz = clamp(z + half, 0, MN - 1.001), i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j*MN + i;
    return (t[k]*(1 - u) + t[k + 1]*u)*(1 - v) + (t[k + MN]*(1 - u) + t[k + MN + 1]*u)*v; };
  // (the camera's own neighbourhood is kept average, so the cover setting describes the sky you are under)
  const m00 = lk(mt, 0, 0); const moist = (x, z) => lk(mt, x, z) - m00*Math.exp(-(x*x + z*z)/(2*30*30));
  const rollSp = 2.6*(0.5 + base);                          // roll spacing ≈ 2–3 × the boundary-layer depth
  const accept = (x, z) => { let p = Math.exp(3.2*org*moist(x, z));
    if (streets > 0){ const c = x*(-wd[1]) + z*wd[0]; p *= 1 - streets*0.85*(0.5 - 0.5*Math.cos(2*Math.PI*c/rollSp + 1.3*lk(st, x, z))); }
    return p; };
  const pMax = Math.exp(3.2*org);
  // Complexes: a cumulus field is mostly complexes of a few cells side by side (growing, mature and decaying turret groups that
  // merge), lined up loosely with each other, with small fragments around them (young thermals, dissolving remnants).
  // Complex lengths follow the power law; a complex's cells set the widths and heights.
  const Lmin = 0.45*size, Lmax = (2.6 + 9*Math.pow(dev, 1.4))*size, bL = 1.75 - 0.35*dev;
  const k1 = 1 - bL, lo = Math.pow(Lmin, k1), hi = Math.pow(Lmax, k1);
  const windAng = Math.atan2(wd[1], wd[0]);
  let cBase = base;   // the condensation level of the complex being built (its cells share it)
  const addCell = (x, z, D, el, ang, hmul, flatK) => {
    const R = D/2, s = clamp((D - Dmin)/(Dmax - Dmin + 1e-6), 0, 1);
    // aspect (height/width): small fair-weather cumulus are flat, bigger ones taller; deep convection builds towers
    const aspect = (0.28 + 0.34*Math.sqrt(s) + 0.9*dev*s)*(1 + 0.15*gaussR(r))*hmul*flatK;
    const bz = cBase + 0.012*gaussR(r);
    const H = clamp(aspect*D, 0.13, capTop - bz);
    out.clouds.push({x, z, R, base: bz, H, seed: (r()*1e6) | 0, sx: shear[0], sz: shear[1], sig: sig0*(0.85 + 0.3*r()), dev, el, ang});
    out.top = Math.max(out.top, bz + H*1.2); out.base = Math.min(out.base, bz);
    return Math.PI*R*R*el; };
  // calib: footprint area placed per unit of cover actually seen from below (measured on the GPU, see the worker)
  // (overlapping clouds hide each other: cover = 1 − e^(−footprint/area), so the footprint asked for is −ln(1 − cover))
  let area = 0, tries = 0; const want = -Math.log(1 - Math.min(cover, 0.97))*A*(calib || 2);
  while (area < want && tries < 4e6 && out.clouds.length < 500000){ tries++;
    const x = (r()*2 - 1)*half, z = (r()*2 - 1)*half;
    if (r()*pMax > accept(x, z)) continue;
    const L = Math.pow(lo + r()*(hi - lo), 1/k1);           // truncated power law
    cBase = base + 0.035*gaussR(r) + 0.1*Math.max(moist(x, z), 0)*(1 - dev);   // bases: nearly level (the condensation level)
    const W = L*(0.4 + 0.35*r());
    const ang = (streets > 0.2 || r() < 0.35) ? windAng + 0.5*gaussR(r) : r()*Math.PI;   // complexes tend to line up with the wind
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const nCell = clamp(Math.round(L/W*1.3 + r()*1.6 - 0.3), 1, 7);
    let cov = 0;
    for (let i = 0; i < nCell; i++){
      const u = nCell === 1 ? 0 : (i/(nCell - 1) - 0.5)*L*0.62 + 0.08*L*gaussR(r), v = W*0.16*gaussR(r);
      const edge = nCell === 1 ? 0 : Math.abs(u)/(0.5*L);
      const D = Math.max(W*(0.62 + 0.38*r())*(1 - 0.3*edge), Dmin);
      // each cell at its own stage: the middle ones (most mature) are the tallest
      const hmul = (0.55 + 0.6*r())*(1 - 0.35*edge);
      cov += addCell(x + u*ca - v*sa, z + u*sa + v*ca, D, 1.2 + 0.6*r(), ang + 0.6*gaussR(r), hmul, 1);
    }
    // fragments around the complex
    // (beyond ~60 km fragments are far smaller than a voxel; their cover is folded into the complexes instead)
    const far = Math.max(Math.abs(x), Math.abs(z)) > 60;
    const nf = far ? 0 : Math.floor(r()*(1.2 + 2.2*L)*(1 - 0.6*dev));
    for (let i = 0; i < nf; i++){ const rr = (0.55 + 0.9*r())*L*0.6, a2 = r()*2*Math.PI;
      const D = Dmin*(1 + 1.6*r()*r());
      cov += addCell(x + Math.cos(a2)*rr, z + Math.sin(a2)*rr, D, 1 + 0.8*r(), r()*Math.PI, 0.6 + 0.4*r(), 0.7); }
    area += cov*0.8;   // (cells overlap within a complex)
  }
  return out;
}

// ---------- packing for the GPU: cloud records and a 2 km grid of which clouds reach each cell ----------
function packCumulus(cu){
  const n = cu.clouds.length, recs = new Float32Array(Math.max(n, 1)*12);
  cu.clouds.forEach((c, i) => { recs.set([c.x, c.z, c.R, c.base, c.H, c.seed, c.sx, c.sz, c.sig, c.dev, c.el || 1, c.ang || 0], i*12); });
  const G = VOL.GRID, NC = VOL.DOMAIN/G, half = VOL.DOMAIN/2;
  const counts = new Uint32Array(NC*NC);
  const cellsOf = (c, fn) => { const ext = c.R*1.3*(c.el || 1) + Math.hypot(c.sx, c.sz)*c.H*1.2 + 0.05;
    const x0 = Math.max(0, Math.floor((c.x - ext + half)/G)), x1 = Math.min(NC - 1, Math.floor((c.x + ext + half)/G));
    const z0 = Math.max(0, Math.floor((c.z - ext + half)/G)), z1 = Math.min(NC - 1, Math.floor((c.z + ext + half)/G));
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) fn(j*NC + i); };
  const cells = cu.clouds.map(c => { const a = []; cellsOf(c, k => { a.push(k); counts[k]++; }); return a; });
  const start = new Uint32Array(NC*NC + 1); for (let k = 0; k < NC*NC; k++) start[k + 1] = start[k] + counts[k];
  const idx = new Uint32Array(Math.max(start[NC*NC], 1)), fill = start.slice(0, NC*NC);
  cells.forEach((a, i) => { for (const k of a) idx[fill[k]++] = i; });
  let maxPer = 0; for (let k = 0; k < NC*NC; k++) maxPer = Math.max(maxPer, counts[k]);
  return {recs, start, idx, n, maxPer};
}

// ---------- the layered cloud types: the uniform block for the generator (struct Layers in cloudgen.wgsl) ----------
// thr: per-layer coverage thresholds (from the measured distribution of each layer's field)
function layerUniforms(P, thr){
  const wl = Math.hypot(P.windX, P.windZ) || 1, wang = Math.atan2(P.windZ, P.windX);
  const on = (k) => P[k + 'On'] && P[k + 'Cover'] > 0.001;
  const sigAc = 6 + 26*clamp(P.acForm, 0, 1);
  return new Float32Array([
    on('sc') ? P.scCover : 0, P.scBase, P.scThick, P.scForm,   P.scCell, P.scSeed, (22 + 22*clamp(P.scForm, 0, 1))*P.scDens, wang,
    on('ac') ? P.acCover : 0, P.acBase, P.acThick, P.acForm,   P.acCell, P.acSeed + 101, sigAc*P.acDens, wang,
    on('ci') ? P.ciCover : 0, P.ciBase, P.ciThick, P.ciForm,   P.ciCell, P.ciSeed + 211, 1.4*P.ciDens, wang,
    P.windX/wl, P.windZ/wl, 1.8*P.ciShear, P.ciFall,
    thr.sc ?? 0.5, thr.ac ?? 0.5, thr.ci ?? 0.5, 0]);
}
// altitude range a layer can occupy (for the build slab and the renderer's cloud band)
function layerBand(P){
  let lo = 1e9, hi = 0;
  if (P.scOn && P.scCover > 0.001){ lo = Math.min(lo, P.scBase - 0.05); hi = Math.max(hi, P.scBase + P.scThick*1.15); }
  if (P.acOn && P.acCover > 0.001){ lo = Math.min(lo, P.acBase); hi = Math.max(hi, P.acBase + P.acThick); }
  if (P.ciOn && P.ciCover > 0.001){ lo = Math.min(lo, P.ciBase - (P.ciForm > 0.2 ? P.ciFall : 0)); hi = Math.max(hi, P.ciBase + P.ciThick); }
  return hi > 0 ? [Math.max(lo, 0), hi] : null;
}
const LAYER_KEYS = {sc: /^sc(Form|Cell|Seed|Base|Thick)$/, ac: /^ac(Form|Cell|Seed|Base|Thick)$/, ci: /^ci(Form|Cell|Seed|Base|Thick)$/};
