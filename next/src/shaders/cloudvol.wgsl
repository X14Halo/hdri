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
fn distHint(q: vec3f) -> f32 {
  if (q.y < CU.band.x - 0.3 || q.y > CU.band.y + 0.1) { return 1e9; }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  if (f32(l) >= CU.vol.w || lb.y > 0.0) { return -1.0; }
  return rawCloud(q.xz, q.y, l).r - 0.5;
}
// fine detail: billows (inverted cellular noise) at two incommensurate scales, so nothing repeats
fn detailNoise(q: vec3f) -> f32 {
  let a = textureSampleLevel(noiseTex, wrapSamp, q*(1.0/0.83) + vec3f(0.31, 0.17, 0.73), 0.0);
  let b = textureSampleLevel(noiseTex, wrapSamp, q*(1.0/0.237) + vec3f(0.6, 0.2, 0.4), 0.0);
  let c = textureSampleLevel(noiseTex, wrapSamp, q*(1.0/0.071) + vec3f(0.1, 0.5, 0.9), 0.0);
  return 0.5*a.r + 0.3*b.r + 0.2*c.r;
}
// extinction (1/km) with the fine erosion of the near levels
fn densFullL(q: vec3f, l: u32) -> f32 {
  let v = rawCloud(q.xz, q.y, l);
  let sig = sigmaOf(v); if (sig <= 0.0) { return 0.0; }
  if (f32(l) < CU.vol.w) {
    let d = v.r - 0.5; if (d < -0.25) { return 0.0; }
    // erosion eats more at the cloud base and sides than into the domed tops
    // (small clouds are eroded in proportion: a 200 m fragment keeps its shape instead of vanishing)
    // erosion carves the domed tops and sides into billows; the flat base (the condensation level) is left nearly intact
    // cumulus (style < 0.55, coding the cloud's size): billows, small clouds in proportion; sheets (water 0.65, ice 0.9): fine
    // and shallow (their texture is in their fields)
    let isCu = v.a < 0.55;
    let e = CU.band.w*select(0.04 - 0.02*smoothstep(0.75, 0.9, v.a), min(0.2, 0.45*(v.a/0.5*2.4) + 0.02)*(0.15 + 0.85*smoothstep(0.03, 0.3, v.b)), isCu);
    let n = detailNoise(q);
    let de = d - e*(1.0 - n) + 0.02;
    return sig*profileOf(v.b)*smoothstep(0.0, 0.035, de);
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
