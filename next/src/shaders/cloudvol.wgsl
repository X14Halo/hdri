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
// small cumulus are diluted: a thermal entrains surrounding air at a rate ∝ 1/radius, so the small ones hold a much smaller
// share of their adiabatic water (their mixed fraction ~R/(R + 0.25 km)); σ ∝ LWC^(2/3). A lone 200 m cloud ends up ~half as
// dense as the core of a big one, a 100 m fragment about a third
fn cuDil(a: f32) -> f32 { if (a >= 0.5) { return 1.0; } let R = clamp(a/0.5*2.4, 0.05, 2.4); return pow(R/(R + 0.25), 0.6667); }
fn isRain(a: f32) -> bool { return a > 0.72 && a < 0.78; }
fn profileV(v: vec4f, alt: f32) -> f32 { if (isRain(v.a)) { return 1.0; } return select(profileOf(v.b), cuSigmaZ(alt - v.b*CU_BSCALE)*cuDil(v.a), v.a < 0.8); }
// rain falls in curtains: streaks stretched down the fall, a few hundred metres across, with gaps between
fn rainStreak(q: vec3f) -> f32 {
  let n1 = nzs(RM1*vec3f(q.x/0.53, q.y/3.7, q.z/0.53) + vec3f(0.21, 0.66, 0.42)).a;
  let n2 = nzs(RM2*vec3f(q.x/0.17, q.y/1.9, q.z/0.17) + vec3f(0.84, 0.31, 0.15)).a;
  return clamp(0.15 + 1.2*smoothstep(0.3, 0.75, 0.65*n1 + 0.35*n2), 0.0, 1.35);
}

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
fn cuPush(a: f32) -> f32 { return select(0.09, 0.15, a < 0.5); }   // (cumulus: down to the ragged fragments under its base)
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
fn t3D(q: vec3f) -> vec4f { return textureSampleLevel(detailTex, wrapSamp, q, 0.0); }
fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (v - a)/(b - a)*(d - c); }
// the billowy shape noise: Perlin–Worley, carved by the cellular fBm (lobes with sharp creases between them)
fn pwShape(q: vec3f) -> f32 { let s = nzs(q); return clamp(remap(s.r, s.g*0.6 + s.b*0.4 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0); }
// The cloud's surface, in the way the first tool built it (which read as natural): the macro shape (the volume's signed
// distance) is carved into lobes by shape noise at two scales, puffs on puffs, then displaced by a cascade of finer octaves:
// cellular billows (rounded, the cauliflower) and curly wisps (shredded). Each finer octave is carried round by the eddies of
// the coarser one, so small features curl into each other instead of sitting as separate balls. Where the cloud mixes with
// clear air (its sides, its base, small and dissolving clouds) the billows give way to wisps and the margin frays: a band of
// partial cloud, notched and fringed. Only the tops of growing towers stay hard: the rising core pushes the surface out faster
// than mixing can eat it. Returns (the cloud's field in km, > 0 inside; the edge softness in km; an interior variation 0–1).
fn cuSurface(q: vec3f, d: f32, z: f32, Rc: f32, A: f32, decay: f32, hfac: f32, lay: bool) -> vec3f {
  let S = mix(0.45, 1.0, clamp(Rc/1.5, 0.0, 1.0))*select(1.0, 0.7, lay);   // feature scale (km): smaller clouds, smaller lumps
  let Hc = 2.0*Rc*mix(0.35, 0.65 + 1.6*CU.wind.w, clamp(Rc/1.5, 0.0, 1.0));
  let topCrisp = select(smoothstep(0.45, 0.9, z/max(Hc, 0.05))*(1.0 - decay), 0.0, lay);
  let rag = mix(1.0, 0.3, topCrisp)*(1.0 + 0.6*decay);
  // the slow swirl: towers and sides wander and bulge, more so higher up
  let qw = q + wv(q, 1.3*S, vec3f(0.11, 0.53, 0.29))*vec3f(0.35, 0.15, 0.35)*S*(0.5 + hfac);
  let qv = qw*vec3f(1.0, select(0.7, 1.0, lay), 1.0);   // (convective lobes a little taller than wide)
  // puffs on puffs: big lobes ~2.6 S, smaller lobes ~0.9 S on them
  let B1 = pwShape(qv/(2.6*S) + vec3f(0.37, 0.11, 0.73)); let B2 = pwShape(qv/(0.9*S) + vec3f(0.83, 0.47, 0.19));
  let big = B1*(0.35 + 0.8*B2);
  var f = d - A*(1.0 - min(big, 1.0)) + 0.04;
  let f0 = f;
  // the cascade: billows (cellular fBm) and wisps (curly fBm) at 1.2, 0.4 and 0.13 S, the finer ones advected by the coarser
  let d1 = t3D(qw/(1.2*S) + vec3f(0.0, 0.29, 0.0));
  let d2 = t3D((qw + (d1.gba - 0.5)*0.11*S)/(0.4*S) + vec3f(0.31, 0.53, 0.17));
  let d3 = t3D((qw + (d1.rgb - 0.5)*0.05*S + (d2.gba - 0.5)*0.035*S)/(0.13*S) + vec3f(0.71, 0.13, 0.43));
  let W1 = d1.r*0.625 + d1.g*0.25 + d1.b*0.125; let W2 = d2.r*0.625 + d2.g*0.25 + d2.b*0.125; let W3 = d3.r*0.625 + d3.g*0.25 + d3.b*0.125;
  var billow = (W1 - 0.56)*0.55 + (W2 - 0.56)*0.3 + (W3 - 0.56)*0.15;
  var wisp = (d1.a - 0.5)*0.5 + (d2.a - 0.5)*0.3 + (d3.a - 0.5)*0.2;
  if (detailLod > 0.01) {   // a ~45 m octave, close to the camera only
    let d4 = t3D((qw + (d2.rgb - 0.5)*0.02*S)/(0.042*S) + vec3f(0.19, 0.61, 0.61));
    billow += ((d4.r*0.625 + d4.g*0.25 + d4.b*0.125) - 0.56)*0.12*detailLod; wisp += (d4.a - 0.5)*0.16*detailLod; }
  let amp = (0.09 + 0.1*S)*CU.band.w*select(1.0, 0.6, lay);
  // margins: billows give way to wisps, so edges fray rather than ending in smooth balls
  let edgeB = 1.0 - smoothstep(0.0, 0.07, f0);
  let bw = clamp(hfac*(1.0 - 0.6*decay)*(1.0 - 0.45*edgeB*rag), 0.0, 1.0);
  var disp = mix(wisp, billow, bw)*amp*(2.4 + 1.2*decay);
  if (disp > 0.0) { disp *= 0.4*smoothstep(-0.1*amp, 0.02, f); }   // detail mostly cuts in; it pushes out only near the surface
  f += disp;
  f -= (0.06 + 0.1*decay)*CU.band.w*(1.0 - smoothstep(0.0, 0.25, f))*max(d2.a - 0.35, 0.0);
  // the margin itself: fringes and notches within a band whose width follows how ragged this part is
  let band = exp(-(f*f)/(0.0012 + 0.0024*rag));
  f += ((d2.a - 0.5)*0.6 + (d3.a - 0.5)*0.4 + (W3 - 0.56)*0.5)*1.5*amp*rag*band*CU.band.w;
  f -= (0.05 + 0.04*rag)*CU.band.w*(1.0 - smoothstep(0.0, 0.12, f))*max(d3.a - 0.45, 0.0)*2.0;
  // the edge itself: hard on growing tops, a ramp of tens of metres where the cloud is mixing (liquid water fades out)
  // (tens of metres: liquid water ends within a few tens of metres of a cumulus's surface; the breakup of the outline is the
  // fray and the notches above, not a blur — a wide ramp read as smoke from below)
  let soft = mix(0.045, 0.012, clamp(topCrisp*mix(0.7, 1.0, hfac), 0.0, 1.0))*(1.0 + 0.8*decay);
  let iv = smoothstep(0.2, 0.85, W1*0.6 + B2*0.4);
  return vec3f(f, soft, iv);
}
// ice fibres drawn out along the wind (crystals spread by shear into long thin strands, 0.1–1 km across). The strands bend and
// wander (a slow warp across the wind), come in bundles that fade in and out, and are sampled through slanted rotations of the
// noise volume, so the field never repeats
fn iceFib(q: vec3f) -> f32 {
  let wd = CU.wind.xy; var al = dot(q.xz, wd); var ac = dot(q.xz, vec2f(-wd.y, wd.x)); let L = CU.wind.z;
  let w0 = nzs(RM2*vec3f(al/(9.1*L), q.y/2.3, ac/(6.7*L)) + vec3f(0.29, 0.61, 0.13)).a - 0.5;
  let w1 = nzs(RM1*vec3f(al/(3.3*L), q.y/1.1, ac/(2.6*L)) + vec3f(0.83, 0.07, 0.47)).a - 0.5;
  ac += w0*2.4*L + w1*0.7*L; al += w1*1.5*L;
  let f1 = nzs(RM1*vec3f(al/(4.0*L), q.y/0.6, ac/(0.25*L)) + vec3f(0.17, 0.41, 0.83)).a;
  let f2 = nzs(RM2*vec3f(al/(1.3*L), q.y/0.3, ac/(0.07*L)) + vec3f(0.53, 0.29, 0.07)).a;
  let bundle = smoothstep(0.3, 0.7, nzs(RM2*vec3f(al/(6.1*L), q.y/1.7, ac/(1.3*L)) + vec3f(0.71, 0.37, 0.59)).a);
  return smoothstep(0.35, 0.75, clamp(0.55*f1 + 0.45*f2*mix(0.4, 1.0, bundle), 0.0, 1.0))*mix(0.55, 1.0, bundle);
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
      let z = q.y - v.b*CU_BSCALE; let hfac = 0.42 + 0.58*max(smoothstep(0.03, 0.35, z), smoothstep(0.01, 0.07, z - max(d, 0.0)));
      // erosion: subtractive (the surface is cut back between lumps, never inflated), deeper on big clouds
      // decaying clouds (low extinction factor): blurred, more deeply eaten edges
      let decay = clamp((0.8 - sig)/0.45, 0.0, 1.0);
      // (in proportion to the cloud: ~100 m on a 0.5 km cloud, 0.3 km on a 2 km one, a stratocumulus deck ~20% of its depth)
      // (layers: lumps at their cells' scale but shallow, the deck's top and base stay continuous)
      let A = CU.band.w*min(0.3*pow(Rc, 0.8), 0.45)*hfac*(1.0 + 0.5*decay)*select(1.0, 0.45, v.a >= 0.5);
      let su = cuSurface(q, d, z, Rc, A, decay, hfac, v.a >= 0.5);
      let de = su.x; let soft = su.y;
      // the mixing shell: dry air is stirred into a cloud's outer part (inhomogeneous mixing: fewer droplets, the same size),
      // so its water content falls over the outer ~10–20% of its size (more on dissolving clouds), patchily: translucent,
      // ragged edges rather than a hard surface; the cores keep their full density
      let shellW = clamp(0.12*Rc, 0.03, 0.18)*(1.0 + decay)*select(1.0, 0.6, v.a >= 0.5);
      let sh = smoothstep(0.0, shellW, de);
      let edge = 0.45 + 0.55*sh;
      // inside: water content varies from lobe to lobe (dark folds, bright bulges); in cumulus strongly (updraft cores against
      // diluted downdraft pockets, roughly 2–3× apart), which is also what gives a base seen from below its darker and lighter
      // patches
      let body = sig*cuSigmaZ(z)*cuDil(v.a)*select(0.5 + 1.0*su.z, 0.65 + 0.7*su.z, v.a >= 0.5)*edge*smoothstep(0.0, soft, de);
      // ragged fragments hanging under the base (fractus, scud: air dragged up into the condensation level by eddies and
      // condensing patchily), from just below the base to ~150 m under it, beside and under the cloud only; darker than the base
      // (less light reaches under it), they give a base seen from below its texture and break up its edge
      if (v.a < 0.5 && z < 0.05 && z > -0.17 && d > -0.15) {
        let qs = q*vec3f(1.0, 1.7, 1.0);
        let sn = t3D(RM1*qs/0.19 + vec3f(0.27, 0.61, 0.09)).a; let sb = t3D(RM2*qs/0.071 + vec3f(0.55, 0.13, 0.81));
        let hang = smoothstep(-0.17, -0.05, z)*(1.0 - smoothstep(0.0, 0.05, z))*smoothstep(-0.15, -0.03, d);
        let scud = sig*30.0*smoothstep(0.56, 0.8, 0.7*sn + 0.3*(sb.r*0.625 + sb.g*0.375))*hang*CU.band.w;
        return max(body, scud);
      }
      return body;
    }
    if (v.a > 0.8) {
      // ice: fibres drawn out along the wind (crystals spread by shear into long thin strands), soft-edged and wispy
      // (thick ice — an anvil — is a continuous sheet with fibrous edges, not separate strands)
      return sig*profileOf(v.b)*smoothstep(0.0, 0.12, d + 0.06)*mix(iceFib(q)*1.6, 0.75 + 0.5*iceFib(q), smoothstep(1.5, 4.0, sig));
    }
    if (isRain(v.a)) { return sig*smoothstep(-0.03, 0.2, d)*rainStreak(q); }
    // water sheets (stratus, altostratus): fine and shallow detail (their texture is in their fields)
    let e = CU.band.w*0.04;
    let n = nzs(q/0.237 + vec3f(0.6, 0.2, 0.4)).r*0.6 + nzs(q/0.071 + vec3f(0.1, 0.5, 0.9)).r*0.4;
    return sig*cuSigmaZ(q.y - v.b*CU_BSCALE)*smoothstep(0.0, 0.035, d - e*(1.0 - n) + 0.02);
  }
  var far = sig*profileV(v, q.y)*v.r;
  if (v.a > 0.8) { far *= mix(iceFib(q)*1.6, 0.75 + 0.5*iceFib(q), smoothstep(1.5, 4.0, sig)); } else if (isRain(v.a)) { far *= rainStreak(q); }   // (ice keeps its fibres at every distance: they are what makes cirrus read)
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
