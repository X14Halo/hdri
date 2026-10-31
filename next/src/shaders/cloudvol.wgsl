// ---------- cloud density lookups (needs densTex, noiseTex, linSamp, wrapSamp) ----------
fn rawCloud(xz: vec2f, alt: f32, l: u32) -> vec4f { return textureSampleLevel(densTex, linSamp, volUVW(xz, alt, l, CU.res.x, CU.res.y), 0.0); }
fn sigmaOf(v: vec4f) -> f32 { return select(0.05*exp2(v.g*13.0), 0.0, v.g <= 0.0); }
fn profileOf(v: f32) -> f32 { return 0.35 + 0.65*smoothstep(0.0, 0.8, v); }   // adiabatic: denser toward the tops

// position in volume coordinates: horizontal x/z, altitude above the curved ground
// (gnomonic: the horizontal coordinates are where the point's vertical meets the tangent plane at the camera)
fn volPos(p: vec3f) -> vec3f { let d = p - C0; let r = length(d); let k = Rg/max(d.y, 1.0); return vec3f(d.x*k, r - Rg, d.z*k); }

// extinction (1/km) without the fine erosion: for the light pass and quick tests
fn densMacroL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  if (f32(l) < CU.vol.w) { let d = v.r - 0.5; return sigmaOf(v)*profileOf(v.b)*smoothstep(-0.02, 0.06, d); }
  return sigmaOf(v)*profileOf(v.b)*v.r;
}
fn densMacro(q: vec3f) -> f32 {
  if (q.y < CU.band.x - 0.3 || q.y > CU.band.y + 0.1) { return 0.0; }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  var s = densMacroL(q, l); if (lb.y > 0.0) { s = mix(s, densMacroL(q, l + 1u), lb.y); } return s;
}
// signed distance to the nearest cloud surface (km, level 0–2 only; > 0 inside), for stepping through empty air
// how far the fine detail can push a cumulus surface outward (km), from the cloud's size code
fn cuPush(a: f32) -> f32 { return 0.03; }
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
// puffs on puffs: billows at a third and a ninth of the cloud's own size (each cloud is lumpy in proportion to itself, so the
// lumps are self-similar and never tile) and at a fixed ~70 m, read through a slow swirl so outlines curl
fn cuDetail(q: vec3f, Rc: f32) -> vec2f {
  let w = (nzs(q/(2.3*Rc) + vec3f(0.11, 0.53, 0.29)).gba - 0.5)*0.4*Rc;
  let qw = q + w;
  // rounded bulges with sharp creases between them (inverted cellular noise): turrets at ~0.3 R, sub-turrets at ~0.1 R, and
  // the fine billows at fixed scales (as before, which read crisply)
  let t1 = nzs(qw/(8.0*0.3*Rc) + vec3f(0.31, 0.17, 0.73)).g;
  let t2 = nzs(qw/(8.0*0.1*Rc) + vec3f(0.6, 0.2, 0.4)).g;
  let f1 = nzs(qw/0.237 + vec3f(0.6, 0.2, 0.4)).r;
  let f2 = nzs(qw/0.071 + vec3f(0.1, 0.5, 0.9)).r;
  return vec2f(0.3*t1 + 0.25*t2 + 0.27*f1 + 0.18*f2, t2);
}
fn densFullL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  let sig = sigmaOf(v); if (sig <= 0.0) { return 0.0; }
  if (f32(l) < CU.vol.w) {
    let d = v.r - 0.5; if (d < -cuPush(v.a) - 0.02) { return 0.0; }
    if (v.a < 0.55) {
      // cumulus: lumps push the surface out and cut into it (deep notches, separate turrets); the flat base stays nearly intact
      let Rc = clamp(v.a/0.5*2.4, 0.25, 2.4);
      let hfac = 0.2 + 0.8*smoothstep(0.02, 0.3, v.b);
      // erosion: subtractive (the surface is cut back between lumps, never inflated), deeper on big clouds
      let A = CU.band.w*min(0.1 + 0.16*Rc, 0.45)*hfac;
      let dd = cuDetail(q, Rc);
      let de = d - A*(1.0 - dd.x) + 0.03;
      // inside: water content varies from turret to turret (dark folds, bright bulges)
      let soft = 0.015 + 0.03*(1.0 - hfac);
      return sig*profileOf(v.b)*(0.7 + 0.6*dd.y)*smoothstep(0.0, soft, de);
    }
    if (v.a > 0.8) {
      // ice: fibres drawn out along the wind (crystals spread by shear into long thin strands), soft-edged and wispy
      let wd = CU.wind.xy; let al = dot(q.xz, wd); let ac = dot(q.xz, vec2f(-wd.y, wd.x)); let L = CU.wind.z;
      let f1 = nzs(vec3f(al/(4.0*L), q.y/0.6, ac/(0.25*L)) + vec3f(0.17, 0.41, 0.83)).a;
      let f2 = nzs(vec3f(al/(1.3*L), q.y/0.3, ac/(0.06*L)) + vec3f(0.53, 0.29, 0.07)).a;
      let fib = clamp(0.55*f1 + 0.45*f2, 0.0, 1.0);
      return sig*profileOf(v.b)*smoothstep(0.0, 0.12, d + 0.06)*smoothstep(0.35, 0.75, fib)*1.6;
    }
    // water sheets (stratus, altostratus): fine and shallow detail (their texture is in their fields)
    let e = CU.band.w*0.04;
    let n = nzs(q/0.237 + vec3f(0.6, 0.2, 0.4)).r*0.6 + nzs(q/0.071 + vec3f(0.1, 0.5, 0.9)).r*0.4;
    return sig*profileOf(v.b)*smoothstep(0.0, 0.035, d - e*(1.0 - n) + 0.02);
  }
  return sig*profileOf(v.b)*v.r;
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
