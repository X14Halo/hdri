// ---------- the panorama: one sample per pixel per pass, added into the accumulation buffer ----------
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transTex: texture_2d_array<f32>;
@group(0) @binding(2) var msTex: texture_2d_array<f32>;
@group(0) @binding(3) var linSamp: sampler;
@group(0) @binding(4) var<storage, read> amb: array<vec4f>;
@group(0) @binding(5) var<uniform> PS: Pass;
@group(0) @binding(6) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(7) var<uniform> CU: Cloud;
@group(0) @binding(8) var densTex: texture_3d<f32>;
@group(0) @binding(9) var lightTex: texture_3d<f32>;
@group(0) @binding(10) var noiseTex: texture_3d<f32>;
@group(0) @binding(11) var wrapSamp: sampler;
@group(0) @binding(12) var detailTex: texture_3d<f32>;
@group(0) @binding(13) var<storage, read_write> alphaAcc: array<f32>;   // (exports: cloud opacity and ground holdout per pixel, when PS.opt.w has bit 1)

const MARIA = /*@MARIA*/;
const CRATERS = /*@CRATERS*/;
const RAYS = /*@RAYS*/;

fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); var f = p - i; f = f*f*(3.0 - 2.0*f); let b = vec3u(vec3i(i) + vec3i(4096));
  let a000 = hash3(b).x; let a100 = hash3(b + vec3u(1u, 0u, 0u)).x; let a010 = hash3(b + vec3u(0u, 1u, 0u)).x; let a110 = hash3(b + vec3u(1u, 1u, 0u)).x;
  let a001 = hash3(b + vec3u(0u, 0u, 1u)).x; let a101 = hash3(b + vec3u(1u, 0u, 1u)).x; let a011 = hash3(b + vec3u(0u, 1u, 1u)).x; let a111 = hash3(b + vec3u(1u, 1u, 1u)).x;
  return mix(mix(mix(a000, a100, f.x), mix(a010, a110, f.x), f.y), mix(mix(a001, a101, f.x), mix(a011, a111, f.x), f.y), f.z);
}
fn fbm3(p0: vec3f) -> f32 { var s = 0.0; var a = 0.5; var p = p0; for (var i = 0; i < 5; i++) { s += a*vnoise(p); p *= 2.03; a *= 0.5; } return s; }
fn selDir(ll: vec2f) -> vec3f { let lo = radians(ll.x); let la = radians(ll.y); return vec3f(cos(la)*sin(lo), sin(la), cos(la)*cos(lo)); }
fn moonHeight(n: vec3f) -> f32 { return fbm3(n*16.0)*0.6 + vnoise(n*48.0)*0.3 + vnoise(n*140.0)*0.1; }
fn moonAlbedo(n: vec3f) -> f32 {
  var dark = 0.0;
  let wv = (fbm3(n*5.0 + 11.0) - 0.47)*2.0;
  for (var i = 0; i < i32(arrayLength_MARIA); i++) { let m = MARIA[i]; let ang = degrees(acos(clamp(dot(n, selDir(m.xy)), -1.0, 1.0))) + wv*m.z*0.45;
    dark = max(dark, m.w*(1.0 - smoothstep(m.z*0.55, m.z*1.2, ang))); }
  var a = 1.0 - dark*(0.75 + 0.5*fbm3(n*12.0)) + 0.09*(fbm3(n*9.0) - 0.5) + 0.07*(vnoise(n*42.0) - 0.5)*(1.0 - dark) + 0.05*(vnoise(n*130.0) - 0.5);
  a += 0.3*smoothstep(0.86, 0.97, vnoise(n*95.0))*(1.0 - 0.6*dark) + 0.2*smoothstep(0.9, 0.98, vnoise(n*230.0 + 5.0));
  for (var i = 0; i < i32(arrayLength_CRATERS); i++) { let c = CRATERS[i]; let ang = degrees(acos(clamp(dot(n, selDir(c.xy)), -1.0, 1.0))); a += c.w*(1.0 - smoothstep(c.z*0.6, c.z*1.3, ang)); }
  for (var i = 0; i < i32(arrayLength_RAYS); i++) { let r = RAYS[i]; let c = selDir(r.xy); let ang = degrees(acos(clamp(dot(n, c), -1.0, 1.0)));
    if (ang < r.z) { let e1 = normalize(cross(c, vec3f(0.0, 1.0, 0.0))); let e2 = cross(c, e1); let v = n - c*dot(n, c); let ph = atan2(dot(v, e2), dot(v, e1));
      let pat = pow(vnoise(vec3f(cos(ph)*11.0, sin(ph)*11.0, f32(i)*7.31)), 3.0) + 0.5*pow(vnoise(vec3f(cos(ph)*29.0, sin(ph)*29.0, f32(i)*3.7 + 40.0)), 4.0);
      a += r.w*pat*pow(1.0 - ang/r.z, 1.4)*smoothstep(1.0, 2.5, ang)*(0.7 + 0.6*vnoise(n*60.0)); } }
  return max(a, 0.2);
}
fn starSpec(t: u32, g: u32) -> vec4f { return F.Star[t*6u + g]; }

// δ-Eddington slab reflectance of conservative water cloud (g = 0.86): for a collimated beam at cosine mu, and for diffuse
// light (mean cosine 0.5); within a few % of Monte Carlo with the Mie phase function for τ 1–100
const GM: f32 = 0.86;
fn rDir(tau: f32, mu: f32) -> f32 { let k = (1.0 - GM)*tau; return clamp((k + (0.6667 - mu)*(1.0 - exp(-(1.0 - GM*GM)*tau/max(mu, 0.05))))/(1.3333 + k), 0.0, 1.0); }
fn rDiff(tau: f32) -> f32 { return rDir(tau, 0.5); }

// stars found near this direction (at most 9), their weights and blackbody index, gathered once per pixel
struct Stars { w: array<f32, 9>, t: array<u32, 9>, n: u32 }


// ---------- path-traced light inside the clouds (the slow reference for final renders) ----------
// From a point where the view ray scatters, a random walk through the cloud: free flights drawn from its extinction, new
// directions from the droplets' (or crystals') phase function, the sun and moon added at every scattering (next-event
// estimation through the light volume), the sky or the ground where the walk leaves the cloud. Clouds absorb almost nothing,
// so the walk is ended only by leaving or by a bounce cap. It replaces the two-stream estimates of all orders beyond the
// first; everything else (the first order, the air, the background) is the same as the fast model.
// ---------- town lights ----------
// mean upward luminance of the ground at xz (cd/m²): each town a bright centre falling off into its suburbs
fn townLum(xz: vec2f) -> f32 {
  var s = 0.0; let n = u32(F.townO.x);
  for (var k = 0u; k < n; k++) { let t = F.Town[k]; let r = length(xz - t.xy)/max(t.z, 0.05); s += t.w*exp(-1.5*r*r)*(1.0 + 2.0*exp(-8.0*r*r)); }
  return s;
}
// seen directly, the lit ground is a scatter of separate lights (streets, windows, yards): ~50 m cells of very uneven
// brightness, averaging to 1
// the towns' light falling on a point above the ground (illuminance from below, per unit of their spectrum): each a Lambertian
// disc, at its distance and angle, through the air between (mean extinction ext)
fn townE(p: vec3f, ext: f32) -> f32 {
  var e = 0.0; let n = u32(F.townO.x);
  for (var k = 0u; k < n; k++) { let tw = F.Town[k]; let tp = C0 + normalize(vec3f(tw.x, Rg, tw.y))*Rg;
    let v = p - tp; let dd = length(v); let cz = max(dot(v/dd, normalize(tp - C0)), 0.0);
    e += tw.w*PI*tw.z*tw.z*cz*cz/(dd*dd + tw.z*tw.z)*exp(-ext*dd); }
  return e;
}
fn townSparkle(xz: vec2f) -> f32 { let c = vec2i(floor(xz/0.05)); let h = hash3(vec3u(bitcast<u32>(c.x), bitcast<u32>(c.y), 515u)).x; return 0.15 + 4.25*h*h*h*h; }
var<private> rs: vec3u;
fn rnd() -> f32 { rs.z += 0x9E3779B9u; return hash3(rs).x; }
// the light volume read at a point jittered by about a voxel, differently each sample: its trilinear interpolation has
// creases at every voxel face, which in a cloud's shading drew a faint regular grid (crosshatch in perspective); jittered
// and averaged over the samples, the creases blur into a smooth field
fn lightJ(q: vec3f) -> vec4f {
  let v = levelE(u32(levelOf(q.xz).x))/CU.res.z;
  return lightAt(q + (vec3f(rnd(), rnd(), rnd()) - 0.5)*vec3f(1.3*v, 0.6*v, 1.3*v));
}
fn sampleHG(d: vec3f, g: f32) -> vec3f {
  let xi = rnd(); let s = (1.0 - g*g)/(1.0 - g + 2.0*g*xi);
  let ct = clamp((1.0 + g*g - s*s)/(2.0*g), -1.0, 1.0); let st = sqrt(max(1.0 - ct*ct, 0.0)); let ph = 6.2831853*rnd();
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(d.x) > 0.9); let u = normalize(cross(a, d)); let v = cross(d, u);
  return normalize(u*(st*cos(ph)) + v*(st*sin(ph)) + d*ct);
}
struct Walk { sun: f32, moon: f32, sky: f32, g: f32, gS: f32, gM: f32, gA: f32, gT: f32 }
// (the droplets' narrow diffraction peak — half the scattering, within a degree or two of straight on — is folded into the
// beam, δ-scaling: the walk sees the cloud's extinction times the broad part's weight, scatters by the broad part alone
// (sampled from a Henyey–Greenstein of about its asymmetry, weighted by the ratio), and the sun's beam reaching each
// scattering is likewise attenuated by the scaled depth. Same transport, without the spike that made every path a firefly)
fn phaseBroad(c: f32, ice: bool) -> f32 {
  if (ice) { return phaseHG(c, 0.6); }
  let gd = CU.cph.y; let gd2 = gd*gd; let al = CU.cph.z;
  return (1.0 - gd2)*(1.0 + al*c*c)/(4.0*PI*(1.0 + al*(1.0 + 2.0*gd2)/3.0)*pow(max(1.0 + gd2 - 2.0*gd*c, 1e-7), 1.5));
}
fn ptWalk(p0: vec3f, d0: vec3f, ice: bool) -> Walk {
  var w = Walk(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  let Ls = F.sunDir.xyz; let Lm = F.moonDir.xyz;
  let gS = select(0.75, 0.6, ice); let kS = select(CU.cph.w, 0.5, ice);   // (sampling asymmetry; the broad part's share of σ)
  var p = p0; var thr = 1.0;
  var d = sampleHG(d0, gS); thr *= phaseBroad(dot(d0, d), ice)/phaseHG(dot(d0, d), gS);
  // (no absorption in cloud: a walk ends when it leaves, or after enough scatterings that what is left is negligible —
  // deep in a thick cloud that takes hundreds)
  for (var b = 0; b < 192; b++) {
    // free flight: march until the optical depth drawn (−ln ξ) is used up, skipping empty air
    let tgt = -log(max(rnd(), 1e-7)); var tau = 0.0; var hit = false;
    for (var k = 0; k < 320; k++) {
      let q = volPos(p);
      if (q.y > CU.band.y + 0.1 || q.y < max(CU.band.x - 0.35, 0.0) || max(abs(q.x), abs(q.z)) > 0.45*levelE(u32(CU.vol.z) - 1u)) { break; }
      let dh = distHint(q);
      if (dh < -0.06) { p += d*max(0.7*(-dh) - 0.03, 0.02); continue; }
      let sg = kS*densMacro(q); let ds = clamp(0.35/max(sg, 1e-3), 0.004, 0.04);
      if (tau + sg*ds >= tgt) { p += d*((tgt - tau)/max(sg, 1e-6)); hit = true; break; }
      tau += sg*ds; p += d*ds;
    }
    if (!hit) {
      let up = normalize(p - C0);
      if (dot(d, up) > 0.0) { w.sky += thr/PI; }
      else {   // down to the ground, lit through the clouds' shadows
        let qg = volPos(p); let tg = qg.y/max(-dot(d, up), 0.05); let gx = volPos(p + d*tg);
        let gl = lightAt(gx*vec3f(1.0, 0.0, 1.0));
        w.g += thr/PI; w.gS += thr*exp(-gl.x)/PI; w.gM += thr*exp(-gl.y)/PI; w.gA += thr/(1.0 + 0.105*gl.z)/PI;
        if (F.townO.x > 0.0) { w.gT += thr*townLum(gx.xz); }
      }
      break;
    }
    // a scattering: the sun and moon from here, through the (δ-scaled) cloud toward them
    let lt = lightAt(volPos(p));
    if (F.sunDir.w > 0.5) { w.sun += thr*phaseBroad(dot(d, Ls), ice)*exp(-kS*lt.x); }
    if (F.moonDir.w > 0.5) { w.moon += thr*phaseBroad(dot(d, Lm), ice)*exp(-kS*lt.y); }
    let dn = sampleHG(d, gS); thr *= phaseBroad(dot(d, dn), ice)/phaseHG(dot(d, dn), gS); d = dn;
  }
  return w;
}


// ---------- the horizon: distant hills and a tree line ----------
// Silhouettes standing on the ground at a distance, as heights by azimuth (so they wrap round the panorama seamlessly). The ray
// ends on them, so the air in front gives them their aerial perspective, and they are lit like the ground: sun (with the
// clouds' shadows), sky, by the slope of their faces.
fn h1(x: f32) -> f32 { return fract(sin(x*12.9898 + 4.1414)*43758.5453); }
// a range's height (0…1) and its slope along the horizon, from octaves at whole-number frequencies (periodic in azimuth)
fn ridge(az: f32, seed: f32, rough: f32) -> vec2f {
  var h = 0.0; var dh = 0.0; var n = 0.0; var f = 1.0;
  for (var j = 0; j < 10; j++) {
    let fk = round(f); let a = pow(fk, -mix(1.5, 0.95, rough)); let ph = 6.2831853*h1(fk + 17.0*seed + f32(j));
    let s = sin(fk*az + ph);
    // (ridged above the middle octaves: sharper crests than a sine)
    let v = select(0.5 + 0.5*s, 1.0 - abs(s), j >= 3); let dv = select(0.5*fk*cos(fk*az + ph), -sign(s)*fk*cos(fk*az + ph), j >= 3);
    h += a*v; dh += a*dv; n += a; f *= 1.7;
  }
  return vec2f(h/n, dh/n);
}
struct Terr { t: f32, n: vec3f, alb: f32, tree: bool }
fn terrainHit(rd: vec3f, camH: f32) -> Terr {
  var r = Terr(-1.0, vec3f(0.0, 1.0, 0.0), 1.0, false);
  let hl = length(rd.xz); if (hl < 1e-4) { return r; }
  let az = atan2(rd.x, rd.z); let hd = rd.xz/hl; let el = atan2(rd.y, hl);
  let tg = vec2f(hd.y, -hd.x);   // (along the horizon, toward increasing azimuth)
  // tree line: crowns of ~8 m along a band that comes and goes with the cover
  if (F.terr2.x > 0.0) {
    let D = F.terr2.y; let Ht = F.terr2.x;
    let cv = 0.5 + 0.25*sin(3.0*az + 6.28*h1(F.terr2.w)) + 0.15*sin(7.0*az + 6.28*h1(F.terr2.w + 3.1)) + 0.1*sin(13.0*az + 6.28*h1(F.terr2.w + 7.7));
    let m = smoothstep(1.0 - F.terr2.z - 0.04, 1.0 - F.terr2.z + 0.04, cv);
    if (m > 0.0) {
      let u = (az + 3.1415927)*D/0.008; let i = floor(u); let fu = u - i;
      var top = 0.0;
      for (var k = -1; k <= 1; k++) { let c = i + f32(k); let ht = 0.55 + 0.45*h1(c + 91.0*F.terr2.w); let w = 0.6 + 0.6*h1(c + 7.0);
        let x = (fu - f32(k) - 0.5)/w; top = max(top, ht*sqrt(max(1.0 - x*x, 0.0))); }
      let elT = atan2(Ht*m*top - camH - D*D/(2.0*Rg), D);
      if (el < elT && el > -0.2) { r.t = D/max(cos(el), 0.05); r.n = normalize(vec3f(-hd.x, 0.45, -hd.y)); r.alb = F.terr3.y; r.tree = true; return r; }
    }
  }
  // two ranges of hills: a farther, higher one and a nearer, lower one in front of it
  if (F.terr.x > 0.0) {
    for (var k = 0; k < 2; k++) {
      let near = k == 1; let D = F.terr.y*select(1.0, 0.55, near); let H = F.terr.x*select(1.0, 0.55, near);
      let rg = ridge(az, F.terr.w + select(0.0, 13.0, near), F.terr.z);
      let hp = smoothstep(0.2, 0.85, rg.x); let dhp = rg.y*select(0.0, 1.0/0.65, rg.x > 0.2 && rg.x < 0.85);
      let elH = atan2(H*hp - camH - D*D/(2.0*Rg), D);
      if (el < elH && el > -0.2) {
        let t = D/max(cos(el), 0.05);
        if (r.t < 0.0 || t < r.t) {
          // the face toward the camera, tilted left or right by the ridge's slope along the horizon
          let lat = -H*dhp/D*2.0;
          r.t = t; r.n = normalize(vec3f(0.0, 1.0, 0.0) - vec3f(hd.x, 0.0, hd.y)*0.7*(0.4 + hp) + vec3f(tg.x, 0.0, tg.y)*lat); r.alb = F.terr3.x;
        }
      }
    }
  }
  return r;
}


// ---------- optics of ice and rain: refraction peaks that the smooth phase functions leave out, per wavelength ----------
// Ice (hexagonal prisms, n(λ) from 1.318 at 400 nm to 1.307 at 750 nm): light through two faces at 60° has a minimum deviation
// of ~22°, through faces at 90° ~46°: randomly oriented crystals pile light up just outside those angles (the 22° and 46°
// halos, red inside, blue fading outward). Plates falling flat send the 22° light to either side of the sun at its own
// height (sundogs), farther out the higher the sun. Rain drops (n 1.344 … 1.331): light in, reflected once (twice) inside
// and out leaves no closer than ~42° (51°) to the antisolar point: the primary (secondary, colours reversed) rainbow. All
// added to the first-order light by wavelength (the deviation angles from the refractive index), so the colours are the
// physics' own.
fn nIce(lum: f32) -> f32 { return 1.3017 + 0.00268/(lum*lum); }
fn nWater(lum: f32) -> f32 { return 1.3251 + 0.002946/(lum*lum); }
fn haloPeak(th: f32, th0: f32, w: f32) -> f32 { return smoothstep(th0 - 0.35, th0 + 0.1, th)*exp(-max(th - th0, 0.0)/w); }
// extra phase (1/sr) of ice at angle th (deg) from the sun, viewing direction rd, for the four wavelengths of group g
fn haloSpec(g: u32, th: f32, rd: vec3f, Ls: vec3f) -> vec4f {
  var o = vec4f(0.0);
  let es = asin(clamp(Ls.y, -1.0, 1.0)); let ev = asin(clamp(rd.y, -1.0, 1.0));
  let hs = normalize(vec2f(Ls.x, Ls.z) + 1e-6); let hv = normalize(vec2f(rd.x, rd.z) + 1e-6);
  let da = degrees(acos(clamp(dot(hs, hv), -1.0, 1.0)));   // (azimuth from the sun)
  for (var k = 0u; k < 4u; k++) {
    let lum = (387.5 + 15.0*f32(4u*g + k))*0.001; let n = nIce(lum);
    let t22 = degrees(2.0*asin(n*0.5)) - 60.0; let t46 = degrees(2.0*asin(n*0.70710678)) - 90.0;
    var v = F.optic.x*(0.22*haloPeak(th, t22, 1.4) + 0.05*haloPeak(th, t46, 2.5));
    // sundogs: plates' effective index in the horizontal plane, n' = √(n² − sin²e)/cos e
    let ce = cos(es); let ne = sqrt(max(n*n - sin(es)*sin(es), 0.0))/max(ce, 0.05);
    if (F.optic.y > 0.0 && ne*0.5 < 1.0) { let D = degrees(2.0*asin(ne*0.5)) - 60.0;
      v += F.optic.y*0.9*haloPeak(da, D, 1.8)*exp(-pow(degrees(ev - es)/0.8, 2.0)); }
    o[k] = v;
  }
  return o;
}
// extra phase (1/sr) of rain at angle th (deg) from the sun, for the four wavelengths of group g
fn bowSpec(g: u32, th: f32) -> vec4f {
  var o = vec4f(0.0); let al = 180.0 - th;   // (from the antisolar point)
  for (var k = 0u; k < 4u; k++) {
    let lum = (387.5 + 15.0*f32(4u*g + k))*0.001; let n = nWater(lum);
    let i1 = acos(sqrt((n*n - 1.0)/3.0)); let r1 = asin(sin(i1)/n); let R1 = 180.0 - (180.0 + degrees(2.0*i1 - 4.0*r1));
    let i2 = acos(sqrt((n*n - 1.0)/8.0)); let r2 = asin(sin(i2)/n); let R2 = (360.0 + degrees(2.0*i2 - 6.0*r2)) - 180.0;
    // (each bow sharp on its outer side for the primary, inner for the secondary, with the brighter sky inside the primary and
    // the darker band between them)
    let b1 = exp(-pow((al - R1 + 0.35)/0.55, 2.0)) + 0.12*select(0.0, exp(-(R1 - al)/9.0), al < R1);
    let b2 = 0.42*exp(-pow((al - R2 - 0.45)/0.75, 2.0)) + 0.04*select(0.0, exp(-(al - R2)/9.0), al > R2);
    o[k] = F.optic.z*0.09*(b1 + b2);
  }
  return o;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = PS.W; let H = PS.H; let py = id.y + PS.rowOff; let pxX = id.x + PS.colOff;
  if (pxX >= PS.colEnd || py >= PS.rowEnd) { return; }
  let fW = f32(W); let fH = f32(H);
  let n = PS.frame;
  // (each pixel's own rotation of the sample sequences: with one sequence shared by every pixel, all pixels sampled the same
  // sub-pixel spot and the same depths at once, and the noise of a part-converged image lined up into faint stripes)
  let cp = hash3(vec3u(pxX, py, 6151u));
  let jit = select(vec2f(fract(cp.x + f32(n)*0.7548776662) - 0.5, fract(cp.y + f32(n)*0.5698402910) - 0.5), vec2f(0.0), n == 0u);
  let px = vec2f(f32(pxX), f32(py)) + 0.5 + jit;
  let rd = dirFromPixel(px, fW, fH);
  let camH = F.atm2.y; let ro = vec3f(0.0, camH, 0.0); let r0 = Rg + camH; let mu = rd.y;
  var gN = groundHit(r0, mu);
  // (hills and trees on the horizon: the ray ends on them where they stand above the ground it would reach)
  var gNrm = vec3f(0.0); var gAlb = 1.0; var onTerr = false; var onTree = false;
  if (F.opts.y < 0.5 && (F.terr.x > 0.0 || F.terr2.x > 0.0)) { let tr = terrainHit(rd, camH); if (tr.t > 0.0 && (gN <= 0.0 || tr.t < gN)) { gN = tr.t; gNrm = tr.n; gAlb = tr.alb; onTerr = true; onTree = tr.tree; } }
  let hitG = gN > 0.0 && F.opts.y < 0.5;
  // (haze for comp: the air alone, out to a set distance: what lies between the camera and a CG element there)
  let hazeD = PS.opt.y; let hazeM = u32(PS.opt.z);
  let tEnd = select(select(distToTop(r0, mu), gN, gN > 0.0), min(select(distToTop(r0, mu), gN, gN > 0.0), hazeD), hazeD > 0.0);
  let Ls = F.sunDir.xyz; let Lm = F.moonDir.xyz; let cS = dot(rd, Ls); let cM = dot(rd, Lm);
  let pRs = phaseR(cS); let pMs = phaseCS(cS, F.atm2.x); let pFs = phaseFog(cS);
  let pRm = phaseR(cM); let pMm = phaseCS(cM, F.atm2.x); let pFm = phaseFog(cM);
  let ign = fract(hash3(vec3u(pxX, py, 977u)).x + f32(n)*0.61803398875);
  let jt = select(fract(ign + f32(n)*0.61803398875), 0.5, n == 0u);
  let NS = u32(F.opts.x);

  // ---- what lies behind, as wavelength-independent factors: ground, sun disc, moon disc, stars, Milky Way
  var ground = vec4f(0.0, 0.0, 0.0, 0.0);   // x: μ_sun, y: μ_moon at the ground point (hitG)
  var sunSm: array<f32, 16>; var sunN = 0u;
  var moonAcc = 0.0; var inMoon = false; var mwL = 0.0; var st: Stars; st.n = 0u;
  let vr = 1.0/sqrt(max(1.0 - pow(Rg/(Rg + 95.0), 2.0)*(1.0 - mu*mu), 1e-4));   // airglow: van Rhijn brightening toward the horizon
  // (z, w: the sun's and moon's incidence on the surface — the ground's own μ, or a hill face's)
  var gUp = 1.0; var gR = Rg; var gTown = 0.0;
  if (hitG) { let pg = ro + rd*gN; let up = normalize(pg - C0); gR = length(pg - C0);
    if (F.townO.x > 0.0 && !onTerr) { let gx = volPos(pg).xz; gTown = townLum(gx)*townSparkle(gx); }
    ground = vec4f(dot(up, Ls), dot(up, Lm), dot(up, Ls), dot(up, Lm));
    if (onTerr) { let nw = normalize(gNrm + up - vec3f(0.0, 1.0, 0.0)); ground.z = dot(nw, Ls); ground.w = dot(nw, Lm); gUp = 0.5 + 0.5*dot(nw, up); } }
  else if (gN <= 0.0) {
    let pa = PI/fH; let sunRad = F.atm2.w; let squash = F.pole.w;
    if (F.opts.z > 0.5 && length(rd - Ls) < sunRad/squash + 3.0*pa) {
      // the solar disc (limb-darkened, squashed by refraction near the horizon), 16 sub-samples
      let upT = select(vec3f(1.0, 0.0, 0.0), normalize(vec3f(0.0, 1.0, 0.0) - Ls*Ls.y), abs(Ls.y) < 0.999); let rtT = cross(upT, Ls);
      for (var k = 0u; k < 16u; k++) {
        let so = (vec2f(f32(k % 4u), f32(k/4u)) + 0.5)/4.0 - 0.5; let d = dirFromPixel(px + so, fW, fH); let v = d - Ls*dot(d, Ls);
        let x = length(vec2f(dot(v, rtT), dot(v, upT)/squash))/sunRad;
        if (x < 1.0 && dot(d, Ls) > 0.0) { sunSm[sunN] = max(sqrt(1.0 - x*x), 1e-4); sunN++; }
      }
    }
    let moonRad = F.moonLight.w;
    if (length(rd - Lm) < moonRad + 3.0*pa) {
      let zM = -Lm; let yM = normalize(F.pole.xyz - dot(F.pole.xyz, zM)*zM); let xM = cross(yM, Lm); let rho = sin(moonRad);
      for (var k = 0u; k < 16u; k++) {
        let so = (vec2f(f32(k % 4u), f32(k/4u)) + 0.5)/4.0 - 0.5; let d = dirFromPixel(px + so, fW, fH); let dist = length(cross(d, Lm));
        if (dist < rho && dot(d, Lm) > 0.0) {
          let tt = dot(d, Lm) - sqrt(rho*rho - dist*dist); let nn = (d*tt - Lm)/rho;
          let nm = vec3f(dot(nn, xM), dot(nn, yM), dot(nn, zM));
          let E = 0.004; let h0 = moonHeight(nm);
          let gm = vec3f(moonHeight(nm + vec3f(E, 0.0, 0.0)) - h0, moonHeight(nm + vec3f(0.0, E, 0.0)) - h0, moonHeight(nm + vec3f(0.0, 0.0, E)) - h0)/E;
          let gw = gm.x*xM + gm.y*yM + gm.z*zM; let nb = normalize(nn - 0.012*(gw - nn*dot(gw, nn)));
          let m0 = dot(nb, F.moonLight.xyz); let mv = max(dot(nn, -d), 0.0);
          moonAcc += moonAlbedo(nm)*select(2e-4*mv, m0/(m0 + mv), m0 > 0.0)*smoothstep(-0.02, 0.03, dot(nn, F.moonLight.xyz) + 0.02);
        }
      }
      moonAcc /= 16.0; inMoon = length(rd - Lm) < moonRad;
    }
    if (F.eqX.w > 0.5 && !inMoon) {
      let q = vec3f(dot(F.eqX.xyz, rd), dot(F.eqY.xyz, rd), dot(F.eqZ.xyz, rd));
      if (F.galX.w > 0.0) {
        let b = asin(clamp(dot(q, F.galZ.xyz), -1.0, 1.0)); let l = atan2(dot(q, F.galY.xyz), dot(q, F.galX.xyz)); let lw = abs(l);
        let disk = exp(-abs(b)/radians(7.5))*(0.32 + 0.68*exp(-lw*lw/2.0));
        let bulge = exp(-(l*l)/(2.0*0.30*0.30) - (b*b)/(2.0*0.16*0.16));
        let nz = fbm3(q*7.0 + 3.1);
        let lanes = 1.0 - 0.75*exp(-abs(b + 0.015*sin(l*5.0))/radians(2.2))*smoothstep(0.35, 0.75, fbm3(q*11.0 + 7.3))*exp(-lw*lw/(2.0*1.4*1.4));
        mwL = 6e-4*F.galX.w*(disk*(0.55 + 0.9*nz) + 1.3*bulge)*lanes;
      }
      if (F.eqY.w > 0.5) {
        // stars: a hashed catalogue on the faces of a cube in the equatorial frame, magnitudes from a power law
        let aq = abs(q); var face = 0u; var fuv = vec2f(0.0);
        if (aq.x >= aq.y && aq.x >= aq.z) { face = select(1u, 0u, q.x > 0.0); fuv = vec2f(q.z, q.y)/aq.x; }
        else if (aq.y >= aq.z) { face = select(3u, 2u, q.y > 0.0); fuv = vec2f(q.x, q.z)/aq.y; }
        else { face = select(5u, 4u, q.z > 0.0); fuv = vec2f(q.x, q.y)/aq.z; }
        let NC = 256.0; let cell = vec2i(floor((fuv*0.5 + 0.5)*NC)); let sig = 0.5*pa;
        for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
          let c = cell + vec2i(dx, dy); if (c.x < 0 || c.y < 0 || c.x >= 256 || c.y >= 256) { continue; }
          let hh = hash3(vec3u(u32(c.x), u32(c.y), face*7919u + 17u));
          let m = (log(max(hh.x, 1e-9)*393216.0)/log(10.0) - 0.9)/0.47; if (m > F.eqZ.w) { continue; }
          let h2 = hash3(vec3u(u32(c.y) + 911u, u32(c.x) + 313u, face*104729u + 3u));
          let suv = (vec2f(c) + hh.yz)/NC*2.0 - 1.0; var sd: vec3f;
          if (face == 0u) { sd = vec3f(1.0, suv.y, suv.x); } else if (face == 1u) { sd = vec3f(-1.0, suv.y, suv.x); }
          else if (face == 2u) { sd = vec3f(suv.x, 1.0, suv.y); } else if (face == 3u) { sd = vec3f(suv.x, -1.0, suv.y); }
          else if (face == 4u) { sd = vec3f(suv.x, suv.y, 1.0); } else { sd = vec3f(suv.x, suv.y, -1.0); }
          sd = normalize(sd); let ang = length(q - sd); if (ang > 4.0*sig) { continue; }
          let kern = exp(-ang*ang/(2.0*sig*sig))/(2.0*PI*sig*sig); let Ev = 2.54e-6*pow(10.0, -0.4*m);
          let u = h2.x; var Tk: f32;
          if (u < 0.12) { Tk = mix(3000.0, 3800.0, h2.y); } else if (u < 0.42) { Tk = mix(3900.0, 5200.0, h2.y); } else if (u < 0.70) { Tk = mix(5200.0, 6000.0, h2.y); }
          else if (u < 0.85) { Tk = mix(6000.0, 7500.0, h2.y); } else if (u < 0.95) { Tk = mix(7500.0, 10000.0, h2.y); } else { Tk = mix(10000.0, 25000.0, h2.y); }
          st.w[st.n] = Ev*kern; st.t[st.n] = u32(clamp(floor(15.0*log(Tk/2500.0)/log(10.0) + 0.5), 0.0, 15.0)); st.n++;
        } }
      }
    }
  }

  // ---- the view ray: air in segments (spectral), and inside each segment the clouds (grey: water droplets scatter all
  // wavelengths alike, so everything inside the clouds is one number per step; colour comes from the light reaching them)
  var L: array<vec4f, 6>; var T: array<vec4f, 6>;
  for (var g = 0u; g < 6u; g++) { L[g] = vec4f(0.0); T[g] = vec4f(1.0); }
  var Tc = 1.0;                                   // transmittance through the clouds so far
  let cloudOn = CU.band.z > 0.5 && hazeD <= 0.0;
  // (the clouds' shadows in the air — the god rays — also in the haze for comp when asked: PS.opt.w bit 2)
  let cloudSh = CU.band.z > 0.5 && (hazeD <= 0.0 || (u32(PS.opt.w) & 2u) != 0u);
  let cs1 = phaseCloud(cS); let cm1 = phaseCloud(cM);
  // ice crystals (cirrus, 20–100 µm): a narrower diffraction peak and a broad body, asymmetry ≈ 0.8 (halos are separate)
  let ci1 = 0.5*phaseHG(cS, 0.995) + 0.5*phaseHG(cS, 0.6); let cim = 0.5*phaseHG(cM, 0.995) + 0.5*phaseHG(cM, 0.6);
  let iso = 1.0/(4.0*PI);
  var cloudSteps = 0u;
  // (the cloud march carries on from one air segment into the next where it left off: restarting it at each segment's start
  // double-counted or skipped the cloud around every boundary, a faint line across clouds at that distance)
  var tCl = -1.0;
  let rj = fract(hash3(vec3u(pxX, py, 4211u)).x + f32(n)*0.7548776662);
  let thS = degrees(acos(clamp(cS, -1.0, 1.0)));   // (angle from the sun, for halos and rainbows)
  let ptOn = PS.opt.x > 0.5; rs = vec3u(pxX, py, n*7919u + 13u);
  for (var i = 0u; i < NS; i++) {
    let f0 = f32(i)/f32(NS); let f1 = f32(i + 1u)/f32(NS); let ta = tEnd*f0*f0; let tb = tEnd*f1*f1; let dt = tb - ta; let tAir = ta + dt*jt;
    // clouds in this segment
    var Fs = 0.0; var Fm = 0.0; var Fa = 0.0; var Fg = 0.0; var Fd = 0.0; var FgS = 0.0; var FgM = 0.0; var FgA = 0.0; var FgR = 0.0; var FgT = 0.0; var TcAir = Tc;
    var pW = 0.0; var pP = vec3f(0.0); var pIce = false; var FsI = 0.0; var FsR = 0.0;
    let qa = volPos(ro + rd*ta); let qb = volPos(ro + rd*tb);
    let segLo = min(qa.y, qb.y); let segHi = max(qa.y, qb.y);
    // the air's extinction in this segment (mean over wavelengths, at its middle): each cloud sample is attenuated by the air
    // from the segment's start to the sample itself, not by a segment-wide average, which drew a seam across clouds wherever
    // a segment boundary crossed them
    var extS = 0.0;
    if (cloudOn) { let hq = length(ro + rd*(0.5*(ta + tb)) - C0) - Rg; let dR0 = densR(hq); let dM0 = densM(hq); let dO0 = densO(hq); let dF0 = densF(hq);
      for (var g = 0u; g < 6u; g++) { extS += dot(F.BR[g]*dR0 + (F.BMs[g] + F.BMa[g])*dM0 + F.BO[g]*dO0 + vec4f(dF0), vec4f(0.25)); } extS /= 6.0; }
    if (cloudOn && Tc > 0.0 && segHi > CU.band.x - 0.3 && segLo < CU.band.y + 0.1) {
      var airDone = false;
      var t = tCl;
      if (t < ta) { t = ta + clamp(ta*0.005, 0.02, 1.0)*rj; }
      loop {
        // practically opaque: what lies behind (the sun's disc above all, ~1e9 cd/m²) is cut off entirely rather than leaking
        // through as the last fraction of a percent
        if (Tc < 0.002) { Tc = 0.0; break; }
        if (t >= tb) { break; }
        if (!airDone && t >= tAir) { TcAir = Tc; airDone = true; }
        let p = ro + rd*t; let q = volPos(p);
        // past the fine-step budget (long grazing rays through distant cloud fields) the march carries on with coarse steps
        // through the macro density, so far cloud banks still block what is behind them
        let coarse = cloudSteps >= 640u;
        detailLod = 1.0 - smoothstep(0.008, 0.02, t*PI/fH); pixKm = t*PI/fH;   // (the ~25 m billows only where a pixel is finer than ~15 m)
        var ds = clamp(t*0.005, 0.02, 1.0);
        var sig = 0.0;
        if (coarse) { ds = max(ds, dt*0.125); sig = densMacro(q); }
        else {
          // empty air near the clouds: step by the distance to the nearest cloud surface
          let dh = distHint(q);
          if (dh > 1e8) { t += max(ds*4.0, 0.2); continue; }
          if (dh < -0.06) { t += max(ds, 0.7*(-dh) - 0.03); cloudSteps++; continue; }
          sig = densFull(q);
          cloudSteps++;
        }
        if (sig > 0.0) {
          // optical depth to the sun: the first ~0.36 km marched through the detailed cloud (the shadows of its own billows),
          // the next ~2 km through the full-resolution cloud shapes (crisp shadows cast by neighbouring turrets and clouds),
          // the rest from the light volume beyond that point
          var lt = lightJ(q);
          if (F.sunDir.w > 0.5 && t < 60.0 && !coarse) {
            // (steps growing from 15 m: the billows and domes of ~50–150 m shade each other, which is what makes them read;
            // sample positions jittered per pixel and pass: fixed ones would step as the cloud's surfaces cross them, drawing
            // contour bands; jittered, the steps average out)
            var tl = 0.0; var d0 = 0.0; var sf = 0.015;
            let rl = fract(rj*1.618 + 0.31);
            for (var j = 0; j < 7; j++) { tl += densFull(volPos(p + Ls*(d0 + rl*sf)))*sf; d0 += sf; sf *= 1.5; }
            var sd = 0.12;
            for (var j = 0; j < 6; j++) { if (tl > 25.0) { break; } tl += densMacro(volPos(p + Ls*(d0 + rl*sd)))*sd; d0 += sd; sd *= 1.4; }
            lt.x = tl + select(lightJ(volPos(p + Ls*d0)).x, 0.0, tl > 25.0);
          }
          // ---- light inside the cloud (all orders but the first from slab radiative transfer, δ-Eddington, g = 0.86).
          // At this point the cloud is treated as a layer seen along its lit axis: the cloud between the point and the light
          // (optical depth dA, measured) passes on a fraction, the cloud beyond it (dB, measured) reflects part of that back;
          // adding the two layers gives the diffuse light travelling on (Dn) and back toward the light (Up). The axis is the
          // vertical where the sunlight came in through the cloud's top, horizontal toward the sun where it came in through a
          // side. A finite cloud loses diffuse light out of its sides (Monte Carlo on a cube: the base gets ~0.2× the slab's
          // transmission at τ 20, ~0.1× at τ 50; the lit face ~0.5× the slab's reflection), more so the deeper the light has
          // gone and the narrower the cloud is across the axis. The viewer sees the stream heading toward them.
          let upl = normalize(p - C0);
          let vr = rawCloud(q.xz, q.y, u32(levelOf(q.xz).x));
          // (compact: cumulus, and the lumpy cells of stratocumulus and altocumulus, which are only one to three layer depths
          // across, so they are lit and shaded as separate cells (a lit side and a shadow side) rather than as a uniform sheet;
          // smooth sheets (stratus, altostratus) as a horizontal slab)
          let lay = vr.a >= 0.5;
          let isCu = vr.a < 0.62;
          let Rc = select(clamp(vr.a/0.5*2.4, 0.25, 2.4), clamp((vr.a - 0.5)/0.12*1.2, 0.1, 1.2), lay);
          let Wc = select(40.0, select(2.6*Rc, 2.9*Rc, lay), isCu);
          let Hc = select(0.6, select(2.0*Rc*mix(0.35, 0.65 + 1.6*CU.wind.w, clamp(Rc/1.5, 0.0, 1.0)), 0.8*Rc, lay), isCu);
          // first order: the droplets' full phase function (silver linings, the bright aureole of thin edges)
          let ice = vr.a > 0.8;
          let sunF = select(cs1, ci1, ice)*exp(-lt.x); let moonF = select(cm1, cim, ice)*exp(-lt.y);
          let dI = Tc*(1.0 - exp(-sig*ds))*exp(-extS*(t - ta));
          Fs += dI*sunF; Fm += dI*moonF;
          if (ice) { FsI += dI*exp(-lt.x); } else if (vr.a > 0.72 && vr.a < 0.78) { FsR += dI*exp(-lt.x); }   // (for halos and rainbows)
          if (ptOn) {
            // (one point per segment, drawn in proportion to how much it scatters toward the viewer; the walk starts there)
            pW += dI; if (rnd()*pW < dI) { pP = p; pIce = ice; }
          } else {
          // sky: down through the cloud above, back up from the cloud below
          let wv = clamp(0.5 + 0.5*dot(rd, upl), 0.0, 1.0);
          let Rau = rDiff(lt.z); let Rbd = rDiff(lt.w);
          let Dsk = (1.0 - Rau)/(1.0 - Rau*Rbd);
          Fa += dI*CU.ms.w*Dsk*(wv + Rbd*(1.0 - wv))/PI;
          // sun
          if (F.sunDir.w > 0.5) {
            var ya = lt.z + lt.w;
            if (t < 60.0 && !coarse) {   // optical depth from here away from the sun, through the cloud beyond (~2 km)
              ya = 0.0; var sa = 0.1; var da = 0.0;
              let ra = fract(rj*2.718 + 0.57);
              for (var j = 0; j < 6; j++) { ya += densMacro(volPos(p - Ls*(da + ra*sa)))*sa; da += sa; sa *= 1.5; }
            }
            let mu0 = clamp(dot(upl, Ls), 0.0, 1.0); let s0 = sqrt(max(1.0 - mu0*mu0, 0.0));
            let ex = exp(-lt.x);
            if (isCu) {
              // a compact cloud: one slab along the beam (depth toward the sun dA, beyond it dB, both measured, so every billow
              // and turret shades what lies behind it). Leakage out of the cloud across the beam grows with the beam's
              // chord through the cloud relative to the cloud's width across it.
              let dA = lt.x; let dB = ya;
              let Ra = rDiff(dA); let Rb = rDiff(dB);
              let Dn = (1.0 - rDir(dA, 1.0))/(1.0 - Ra*Rb); let Up = Rb*Dn;
              let along = 1.0/(mu0/Hc + s0/Wc); let across = 1.0/(s0/Hc + mu0/Wc);
              // (at least as for a cube: whatever the beam has crossed first, a turret or a billow, is no wider across the beam
              // than along it, so the light it diffuses spreads out of it rather than on toward this point; what comes back
              // from beyond (Up) is made of that same, reduced, light)
              let A = clamp(along/across, 1.0, 5.0);
              let fD = 1.0/(1.0 + 1.3*(1.0 - GM)*dA*A); let fU = 1.0/(1.0 + 0.5*min(A, 2.0));
              let ws = clamp(0.5 + 0.5*cS, 0.0, 1.0);   // the stream travelling back (toward the sun) is seen looking away from it
              // the stream travelling on (seen looking toward the sun): light that has crossed only a few optical depths still
              // travels mostly forward, and its spread widens with each scattering (Monte Carlo through a droplet cloud: of the
              // diffuse light through τ 1, 38% within 5° of the beam; τ 5, 9%; broad by τ ~15). As a lobe whose asymmetry falls
              // with depth (g ≈ 0.8 at the surface, 0.5 at τ 4, 0.2 at τ 20), normalised to carry the stream's flux: thin and
              // small clouds near the sun glow white, thick ones go grey. A forward-travelling stream also leaks less out of the
              // cloud's sides than a diffuse one
              let gt = 0.8/(1.0 + 0.15*dA);
              let fwd = 0.833*PI*phaseHG(cS, gt)/(0.25*(1.0 + gt)*(1.0 + gt));
              Fd += dI*(pow(fD, 1.0 - gt)*max(Dn - ex, 0.0)*fwd + fD*fU*Up*(1.0 - ws))/PI;
            } else {
              // a wide layer: a horizontal slab lit through its top at the sun's incidence (projected measured depths)
              let dAT = lt.x*mu0; let dBT = ya*mu0;
              let RaT = rDiff(dAT); let RbT = rDiff(dBT);
              let DnT = (1.0 - rDir(dAT, max(mu0, 0.05)))/(1.0 - RaT*RbT); let UpT = RbT*DnT;
              Fd += dI*mu0*(max(DnT - ex, 0.0)*wv + UpT*(1.0 - wv))/PI;
            }
          }
          // moon: the same through the vertical (its light is faint; the cheaper estimate is enough)
          if (F.moonDir.w > 0.5) {
            let mm = max(dot(upl, Lm), 0.05); let dA = lt.y*mm; let Ra = rDiff(dA);
            let Dn = (1.0 - rDir(dA, 1.0))/(1.0 - Ra*Rbd);
            Fm += dI*mm*(max(Dn - exp(-lt.y), 0.0)*wv + Rbd*Dn*(1.0 - wv))/PI;
          }
          // light from the ground below: what the ground beneath receives (sun and moon through the clouds' shadows, sky),
          // averaged over a patch about as wide as the height above it (read from a coarser level of the light volume);
          // up through the cloud below, back down from the cloud above
          let Ug = (1.0 - Rbd)/(1.0 - Rau*Rbd);
          let kg = dI*Ug*((1.0 - wv) + Rau*wv)/PI;
          // (blended between the two nearest levels: picking one by rounding switched the averaging patch at fixed altitudes,
          // ~1.4 and ~2.8 km, drawing a hard light/shadow line across every cloud at that height)
          let lgf = clamp(log2(max(q.y, 0.1)*CU.res.z/CU.vol.x) - 0.5, levelOf(q.xz).x, CU.vol.z - 1.0);
          let lg0 = floor(lgf); let gwt = lgf - lg0;
          var gl = rawLight(q.xz, 0.0, u32(lg0));
          if (gwt > 0.001) { gl = mix(gl, rawLight(q.xz, 0.0, u32(lg0) + 1u), gwt); }
          Fg += kg; FgS += kg*exp(-gl.x); FgM += kg*exp(-gl.y); FgA += kg/(1.0 + 0.105*gl.z); FgR += kg*rDiff(gl.z);
          if (F.townO.x > 0.0) { FgT += kg*townE(p, extS); }   // (cloud bases near towns: lit from below by their lights)
          }
          Tc *= exp(-sig*ds);
        }
        t += ds;
      }
      if (!airDone) { TcAir = Tc; }
      tCl = t;
      if (ptOn && pW > 0.0) {
        let wk = ptWalk(pP, rd, pIce);
        Fd += pW*wk.sun; Fm += pW*wk.moon; Fa += pW*CU.ms.w*wk.sky;
        Fg += pW*wk.g; FgS += pW*wk.gS; FgM += pW*wk.gM; FgA += pW*wk.gA; FgT += pW*wk.gT;
      }
    }
    // the light sources for this segment (spectral), at its middle
    let tm = 0.5*(ta + tb); let pm = ro + rd*tm; let rm = length(pm - C0); let hm = rm - Rg; let upm = (pm - C0)/rm;
    let muSm = dot(upm, Ls); let muMm = dot(upm, Lm);
    // the air at a jittered point of the segment, shadowed by the clouds toward the sun (crepuscular rays)
    let p = ro + rd*tAir; let r = length(p - C0); let h = r - Rg; let up = (p - C0)/r;
    let muS = dot(up, Ls); let muM = dot(up, Lm);
    var shS = 1.0; var shM = 1.0; var shA = 1.0;
    if (cloudSh) { let la = lightJ(volPos(p)); shS = exp(-la.x); shM = exp(-la.y); shA = 1.0/(1.0 + 0.18*la.z); }
    let dM = densM(h); let dF = densF(h); let dR = densR(h); let dO = densO(h);
    // the towns' light scattered by the air (their glow over the horizon): each town a Lambertian disc on the ground, lighting
    // this point at its distance and angle, through the air between (mean extinction), scattered toward the camera
    var tA = vec3f(0.0);
    if (F.townO.x > 0.0) { for (var k = 0u; k < u32(F.townO.x); k++) { let tw = F.Town[k]; let tp = C0 + normalize(vec3f(tw.x, Rg, tw.y))*Rg;
      let v = p - tp; let dd = length(v); let u = v/dd; let cz = max(dot(u, normalize(tp - C0)), 0.0);
      let E = tw.w*3.0*PI*tw.z*tw.z*cz/(dd*dd + tw.z*tw.z)*exp(-extS*dd); let c = -dot(u, rd);
      tA += E*vec3f(phaseR(c), phaseCS(c, F.atm2.x), phaseFog(c)); } }
    for (var g = 0u; g < 6u; g++) {
      let sR = F.BR[g]*dR; let sM = F.BMs[g]*dM; let ext = sR + sM + F.BMa[g]*dM + F.BO[g]*dO + vec4f(dF); let sT = sR + sM + vec4f(dF);
      var S = vec4f(0.0);
      if (F.sunDir.w > 0.5) { S += PS.mask.x*F.SunE[g]*((sR*pRs + sM*pMs + dF*pFs)*transmittance(g, r, muS)*shS + sT*msLUT(g, h, muS)*shA); }
      if (F.moonDir.w > 0.5) { S += PS.mask.z*F.MoonE[g]*((sR*pRm + sM*pMm + dF*pFm)*transmittance(g, r, muM)*shM + sT*msLUT(g, h, muM)*shA); }
      if (F.townO.x > 0.0) { S += PS.mask.w*F.TownS[g]*(sR*tA.x + sM*tA.y + dF*tA.z); }
      let att = exp(-ext*dt);
      if (hazeM != 2u) { L[g] += T[g]*TcAir*(S - S*att)/max(ext, vec4f(1e-9)); }
      if (Fs + Fm + Fa + Fg + Fd + FsI + FsR > 0.0) {
        var Ec = vec4f(0.0);
        if (F.sunDir.w > 0.5) { let Te = F.SunE[g]*transmittance(g, rm, muSm); Ec += PS.mask.x*Te*(Fs + Fd);
          if (FsI > 0.0 && F.optic.x + F.optic.y > 0.0) { Ec += PS.mask.x*Te*FsI*haloSpec(g, thS, rd, Ls); }
          if (FsR > 0.0 && F.optic.z > 0.0) { Ec += PS.mask.x*Te*FsR*bowSpec(g, thS); } }
        if (F.moonDir.w > 0.5) { Ec += PS.mask.z*F.MoonE[g]*transmittance(g, rm, muMm)*Fm; }
        Ec += PS.mask.y*ambE(g, hm)*Fa;
        if (Fg > 0.0) {
          var Eg = PS.mask.y*ambE(g, 0.0)*FgA;
          if (F.sunDir.w > 0.5) { Eg += PS.mask.x*F.SunE[g]*transmittance(g, Rg, Ls.y)*max(Ls.y, 0.0)*FgS; }
          if (F.moonDir.w > 0.5) { Eg += PS.mask.z*F.MoonE[g]*transmittance(g, Rg, Lm.y)*max(Lm.y, 0.0)*FgM; }
          // (light bouncing between the ground and the cloud deck above it: ×1/(1 − ρ_ground·ρ_cloud), ~2× over snow)
          Ec += F.Alb[g]*Eg/(1.0 - F.Alb[g]*FgR/Fg);
          Ec += PS.mask.w*F.TownS[g]*FgT;
        }
        L[g] += T[g]*Ec*sqrt(att*exp(vec4f(extS*dt)));   // (the per-wavelength remainder of the attenuation, about the segment's middle)
      }
      T[g] *= att;
    }
    if (Tc <= 0.0) { break; }
  }
  // what lies behind, through the air and the clouds
  var xyz = vec3f(0.0);
  var gs = vec4f(1.0, 1.0, 1.0, 0.0);   // ground point: cloud shadow (sun, moon), diffuse transmission, two-stream extra
  if (hitG && cloudOn) { let pg = ro + rd*gN; let lg = lightAt(volPos(pg)); gs = vec4f(exp(-lg.x), exp(-lg.y), 1.0/(1.0 + 0.105*lg.z), lg.z); }
  for (var g = 0u; g < 6u; g++) {
    var bg = vec4f(0.0);
    if (hitG) {
      let hG = gR - Rg;
      var Ed = PS.mask.y*ambE(g, hG)*gs.z*gUp;
      if (F.sunDir.w > 0.5) { let m0 = max(ground.z, 0.0); let Es = F.SunE[g]*transmittance(g, gR, ground.x)*m0*select(0.0, 1.0, ground.x > -0.02);
        // two-stream: what the clouds take out of the beam mostly reaches the ground as diffuse light
        var tt = gs.x; if (gs.w > 0.0 && m0 > 0.0) { let mm = min(m0, 1.0); tt = max((0.5 + 0.75*mm + (0.5 - 0.75*mm)*gs.x)/(1.0 + 0.105*gs.w), gs.x); }
        Ed += PS.mask.x*Es*tt; }
      if (F.moonDir.w > 0.5) { Ed += PS.mask.z*F.MoonE[g]*transmittance(g, gR, ground.y)*max(ground.w, 0.0)*gs.y; }
      // (trees: foliage, whatever the ground; lit from behind, light comes through the leaves — the glowing edge of a tree line
      // against a low sun)
      let alb = select(F.Alb[g], F.LeafS[g], onTree)*gAlb;
      bg = alb*Ed/PI/(1.0 - alb*select(0.0, rDiff(gs.w), cloudOn && hitG));
      if (onTree && F.sunDir.w > 0.5 && ground.z < 0.0) { bg += PS.mask.x*F.LeafS[g]*0.8*F.SunE[g]*transmittance(g, gR, ground.x)*select(0.0, 1.0, ground.x > -0.02)*(-ground.z)*gs.x/PI; }
      if (F.townO.x > 0.0) { bg += PS.mask.w*F.TownS[g]*gTown; }
    } else if (gN <= 0.0) {
      bg = F.Air[g]*vr;
      bg += mwL*starSpec(u32(F.galY.w), g);
      for (var k = 0u; k < st.n; k++) { bg += st.w[k]*starSpec(st.t[k], g); }
      bg *= PS.mask.w;
      if (sunN > 0u) { var acc = vec4f(0.0); for (var k = 0u; k < sunN; k++) { acc += pow(vec4f(sunSm[k]), F.SunA[g]); } if ((u32(PS.opt.w) & 4u) == 0u) { bg += PS.mask.x*F.SunK[g]*acc/16.0; } }   // (bit 4: the sun's disc left out, for a sun split into a separate light)
      bg += PS.mask.z*F.MoonK[g]*moonAcc;
    }
    if (hazeD > 0.0) { bg = vec4f(0.0); }
    let Lg = L[g] + T[g]*Tc*bg;
    xyz += vec3f(dot(Lg, F.CMFx[g]), dot(Lg, F.CMFy[g]), dot(Lg, F.CMFz[g]));
  }
  // (the air's transmission to that distance, by band: long, middle, short wavelengths in the three slots, read as R, G, B)
  if (hazeM == 2u) { xyz = vec3f(dot(T[4], vec4f(0.25)), 0.5*dot(T[2] + T[3], vec4f(0.25)), dot(T[1], vec4f(0.25))); }
  let idx = (py - PS.pad)*W + pxX;   // (pad: the first row the buffer holds; exports render in bands)
  accum[idx] += vec4f(select(vec3f(0.0), xyz, all(xyz == xyz)), 1.0);
  // (exports: the clouds' opacity and the ground's (and horizon's) holdout, as two values per pixel)
  if ((u32(PS.opt.w) & 1u) != 0u) { alphaAcc[2u*idx] += 1.0 - Tc; alphaAcc[2u*idx + 1u] += select(0.0, 1.0, hitG); }
}
