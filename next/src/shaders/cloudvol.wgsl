// ---------- cloud density lookups (needs densTex, noiseTex, linSamp, wrapSamp) ----------
fn rawCloud(xz: vec2f, alt: f32, l: u32) -> vec4f {
  let v = textureSampleLevel(densTex, linSamp, volUVW(xz, alt, l, CU.res.x, CU.res.y), 0.0);
  if (f32(l) >= CU.vol.w) { let c = max(v.r, 0.02); return vec4f(v.r, min(v.g/c, 1.0), min(v.b/c, 1.0), min(v.a/c, 1.0)); }   // (coverage levels: premultiplied)
  return v;
}
fn sigmaOf(v: vec4f) -> f32 { return select(0.05*exp2(v.g*13.0), 0.0, v.g <= 0.0); }
fn profileOf(v: f32) -> f32 { return 0.35 + 0.65*smoothstep(0.0, 0.8, v); }   // layers: denser toward the tops (v: height fraction)
// cumulus and water layers: extinction from the height above the cloud's own base (b channel: the base altitude / 8 km; stored
// per cloud rather than as a height, so it is constant within each cloud and the profile stays smooth). Liquid water grows adiabatically with
// height (~2 g/m³ per km) and is diluted by entrainment (adiabatic fraction falling from ~0.9 near the base to ~0.4 at 2 km);
// with a fixed droplet number (~300/cm³, continental) σ ∝ LWC^(2/3): ~25/km 50 m above the base, ~85 at 0.4 km, ~140 at 1 km,
// ~190 at 2 km (observed: fair-weather cumulus ~20 → 60–110 → 100+, congestus 50–200); the cloud's own factor (g channel) scales it
const CU_BSCALE: f32 = 8.0;
fn cuSigmaZ(z: f32) -> f32 { let zz = max(z, 0.0); return max(85.0*pow(zz/(1.0 + 0.35*zz)/0.351, 0.6667), 10.0); }
// (all liquid clouds, cumulus and the water layers alike, from their own base; ice by height fraction)
fn profileV(v: vec4f, alt: f32) -> f32 { return select(profileOf(v.b), cuSigmaZ(alt - v.b*CU_BSCALE), v.a < 0.8); }

// position in volume coordinates: horizontal x/z, altitude above the curved ground
// (gnomonic: the horizontal coordinates are where the point's vertical meets the tangent plane at the camera)
fn volPos(p: vec3f) -> vec3f { let d = p - C0; let r = length(d); let k = Rg/max(d.y, 1.0); return vec3f(d.x*k, r - Rg, d.z*k); }

// extinction (1/km) without the fine erosion: for the light pass and quick tests
fn densMacroL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  if (f32(l) < CU.vol.w) { let d = v.r - 0.5; return sigmaOf(v)*profileV(v, q.y)*smoothstep(-0.02, 0.06, d); }
  return sigmaOf(v)*profileV(v, q.y)*v.r;
}
fn densMacro(q: vec3f) -> f32 {
  if (q.y < CU.band.x - 0.3 || q.y > CU.band.y + 0.1) { return 0.0; }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  var s = densMacroL(q, l); if (lb.y > 0.0) { s = mix(s, densMacroL(q, l + 1u), lb.y); } return s;
}
// signed distance to the nearest cloud surface (km, level 0–2 only; > 0 inside), for stepping through empty air
// how far the fine detail can push a cumulus surface outward (km), from the cloud's size code
fn cuPush(a: f32) -> f32 { return 0.045; }
// (the far levels hold coverage, not distances: there an empty voxel lets the ray skip half a voxel, anything else is sampled)
fn hintL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  if (f32(l) < CU.vol.w) { return v.r - 0.5 + cuPush(v.a); }
  if (v.r <= 0.0) { return -0.5*levelE(l)/CU.res.x; }
  return 0.0;
}
fn distHint(q: vec3f) -> f32 {
  if (q.y < CU.band.x - 0.3 || q.y > CU.band.y + 0.1) { return 1e9; }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  var h = hintL(q, l); if (lb.y > 0.0) { h = max(h, hintL(q, l + 1u)); }
  return h;
}
fn nzs(q: vec3f) -> vec4f { return textureSampleLevel(noiseTex, wrapSamp, q, 0.0); }
// how much of the finest detail this sample can show (1 near, fading where a pixel spans more than ~15 m; the sky sets it)
var<private> detailLod: f32 = 1.0;
// a smooth random vector field (from the volume's smooth Perlin channel), about −0.5…0.5
fn wv(q: vec3f, s: f32, o: vec3f) -> vec3f { return vec3f(nzs(q/s + o).a, nzs(q/s + o + vec3f(0.37, 0.11, 0.53)).a, nzs(q/s + o + vec3f(0.71, 0.59, 0.23)).a) - 0.5; }
// rounded bubbles about `cell` km across, with sharp creases between them
fn bub(q: vec3f, cell: f32, o: vec3f) -> f32 { return nzs(q/(8.0*cell) + o).g; }
// the cauliflower: domes on domes on domes. Each octave is a set of bubbles whose surface relief is in proportion to its size
// (the self-similar, fractal surface of real cumulus, perimeter dimension ~1.35): turrets at ~0.3 of the cloud's radius,
// sub-turrets at ~0.1, then billows at fixed sizes, ~80 m and, near the camera, ~25 m. Returns the depth the surface is cut
// back (km) and an interior variation (0–1). Turrets are rising thermals, taller than wide, so their lumps stay coherent up
// the cloud's side; layers get rounder, shallower lumps and no columns. The fixed-size billows are read through a broad
// random displacement (more than their own repeat), so the noise volume's tiling never shows.
fn cuDetail(q: vec3f, Rc: f32, A: f32, hfac: f32, lay: bool) -> vec2f {
  let qw = q + wv(q, 2.3*Rc, vec3f(0.11, 0.53, 0.29))*0.8*Rc;   // a slow swirl, so outlines curl
  let qt = qw*vec3f(1.0, select(0.55, 1.0, lay), 1.0);
  let b1 = bub(qt, 0.3*Rc, vec3f(0.31, 0.17, 0.73));
  let b2 = bub(qt, 0.1*Rc, vec3f(0.6, 0.2, 0.4));
  let qf = qw + wv(q, 1.9, vec3f(0.83, 0.27, 0.41))*1.3;
  let b3 = bub(qf, 0.08, vec3f(0.13, 0.71, 0.37));
  var cut = select(A*(0.6*(1.0 - b1) + 0.3*(1.0 - b2)), A*(0.75*(1.0 - b1) + 0.15*(1.0 - b2)), lay);
  cut += hfac*select(0.035, 0.015, lay)*(1.0 - b3);
  if (detailLod > 0.01 && !lay) { cut += hfac*detailLod*0.012*(1.0 - bub(qf, 0.025, vec3f(0.43, 0.09, 0.61))); }
  return vec2f(cut, select(b2, b1, lay));
}
// ice fibres drawn out along the wind (crystals spread by shear into long thin strands, 0.1–1 km across)
fn iceFib(q: vec3f) -> f32 {
  let wd = CU.wind.xy; let al = dot(q.xz, wd); let ac = dot(q.xz, vec2f(-wd.y, wd.x)); let L = CU.wind.z;
  let f1 = nzs(vec3f(al/(4.0*L), q.y/0.6, ac/(0.25*L)) + vec3f(0.17, 0.41, 0.83)).a;
  let f2 = nzs(vec3f(al/(1.3*L), q.y/0.3, ac/(0.06*L)) + vec3f(0.53, 0.29, 0.07)).a;
  return smoothstep(0.35, 0.75, clamp(0.55*f1 + 0.45*f2, 0.0, 1.0));
}
fn densFullL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  let sig = sigmaOf(v); if (sig <= 0.0) { return 0.0; }
  if (f32(l) < CU.vol.w) {
    let d = v.r - 0.5; if (d < -cuPush(v.a) - 0.02) { return 0.0; }
    if (v.a < 0.63) {
      // cumulus: lumps push the surface out and cut into it (deep notches, separate turrets); the flat base stays nearly intact
      let Rc = clamp(select((v.a - 0.5)/0.12*1.2, v.a/0.5*2.4, v.a < 0.5), 0.05, 2.4);
      // the flat base stays nearly intact, but the cloud's sides are lumpy right down to it (they make its outline seen from
      // below): erosion is held back only where the base, not a side, is the nearest surface
      let z = q.y - v.b*CU_BSCALE; let hfac = 0.2 + 0.8*max(smoothstep(0.03, 0.35, z), smoothstep(0.01, 0.07, z - max(d, 0.0)));
      // erosion: subtractive (the surface is cut back between lumps, never inflated), deeper on big clouds
      // decaying clouds (low extinction factor): blurred, more deeply eaten edges
      let decay = clamp((0.8 - sig)/0.45, 0.0, 1.0);
      // (in proportion to the cloud: ~100 m on a 0.5 km cloud, 0.3 km on a 2 km one, a stratocumulus deck ~20% of its depth)
      // (layers: lumps at their cells' scale but shallow, the deck's top and base stay continuous)
      let A = CU.band.w*min(0.3*pow(Rc, 0.8), 0.45)*hfac*(1.0 + 0.5*decay)*select(1.0, 0.45, v.a >= 0.5);
      let dd = cuDetail(q, Rc, A, hfac, v.a >= 0.5);
      let de = d - dd.x + 0.04;
      // inside: water content varies from turret to turret (dark folds, bright bulges)
      let soft = (0.01 + 0.03*(1.0 - hfac))*(1.0 + 1.5*decay);
      return sig*cuSigmaZ(z)*(0.7 + 0.6*dd.y)*smoothstep(0.0, soft, de);
    }
    if (v.a > 0.8) {
      // ice: fibres drawn out along the wind (crystals spread by shear into long thin strands), soft-edged and wispy
      return sig*profileOf(v.b)*smoothstep(0.0, 0.12, d + 0.06)*iceFib(q)*1.6;
    }
    // water sheets (stratus, altostratus): fine and shallow detail (their texture is in their fields)
    let e = CU.band.w*0.04;
    let n = nzs(q/0.237 + vec3f(0.6, 0.2, 0.4)).r*0.6 + nzs(q/0.071 + vec3f(0.1, 0.5, 0.9)).r*0.4;
    return sig*cuSigmaZ(q.y - v.b*CU_BSCALE)*smoothstep(0.0, 0.035, d - e*(1.0 - n) + 0.02);
  }
  var far = sig*profileV(v, q.y)*v.r;
  if (v.a > 0.8) { far *= iceFib(q)*1.6; }   // (ice keeps its fibres at every distance: they are what makes cirrus read)
  return far;
}
fn densFull(q: vec3f) -> f32 {
  if (q.y < CU.band.x - 0.3 || q.y > CU.band.y + 0.1) { return 0.0; }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  var s = densFullL(q, l); if (lb.y > 0.0) { s = mix(s, densFullL(q, l + 1u), lb.y); } return s;
}
fn phaseCloud(c0: f32) -> f32 {
  let c = clamp(c0, -1.0, 1.0); let g2 = CU.cph.x*CU.cph.x;
  let hg = (1.0 - g2)/(4.0*PI*pow(max(1.0 + g2 - 2.0*CU.cph.x*c, 1e-7), 1.5));
  let gd = CU.cph.y; let gd2 = gd*gd;
  let dr = (1.0 - gd2)*(1.0 + CU.cph.z*c*c)/(4.0*PI*(1.0 + CU.cph.z*(1.0 + 2.0*gd2)/3.0)*pow(max(1.0 + gd2 - 2.0*gd*c, 1e-7), 1.5));
  return mix(hg, dr, CU.cph.w);
}
