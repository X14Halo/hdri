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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let W = PS.W; let H = PS.H; let py = id.y + PS.rowOff; let pxX = id.x + PS.colOff;
  if (pxX >= PS.colEnd || py >= PS.rowEnd) { return; }
  let fW = f32(W); let fH = f32(H);
  let n = PS.frame;
  let jit = select(vec2f(fract(0.5 + f32(n)*0.7548776662) - 0.5, fract(0.5 + f32(n)*0.5698402910) - 0.5), vec2f(0.0), n == 0u);
  let px = vec2f(f32(pxX), f32(py)) + 0.5 + jit;
  let rd = dirFromPixel(px, fW, fH);
  let camH = F.atm2.y; let ro = vec3f(0.0, camH, 0.0); let r0 = Rg + camH; let mu = rd.y;
  let gN = groundHit(r0, mu); let hitG = gN > 0.0 && F.opts.y < 0.5;
  let tEnd = select(distToTop(r0, mu), gN, gN > 0.0);
  let Ls = F.sunDir.xyz; let Lm = F.moonDir.xyz; let cS = dot(rd, Ls); let cM = dot(rd, Lm);
  let pRs = phaseR(cS); let pMs = phaseCS(cS, F.atm2.x); let pFs = phaseFog(cS);
  let pRm = phaseR(cM); let pMm = phaseCS(cM, F.atm2.x); let pFm = phaseFog(cM);
  let ign = fract(hash3(vec3u(pxX, py, 977u)).x + f32(n)*0.61803398875);
  let jt = select(fract(0.5 + f32(n)*0.61803398875 + (ign - 0.5)*0.3), 0.5, n == 0u);
  let NS = u32(F.opts.x);

  // ---- what lies behind, as wavelength-independent factors: ground, sun disc, moon disc, stars, Milky Way
  var ground = vec4f(0.0, 0.0, 0.0, 0.0);   // x: μ_sun, y: μ_moon at the ground point (hitG)
  var sunSm: array<f32, 16>; var sunN = 0u;
  var moonAcc = 0.0; var inMoon = false; var mwL = 0.0; var st: Stars; st.n = 0u;
  let vr = 1.0/sqrt(max(1.0 - pow(Rg/(Rg + 95.0), 2.0)*(1.0 - mu*mu), 1e-4));   // airglow: van Rhijn brightening toward the horizon
  if (hitG) { let pg = ro + rd*gN; let up = normalize(pg - C0); ground = vec4f(dot(up, Ls), dot(up, Lm), 0.0, 0.0); }
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
  let cloudOn = CU.band.z > 0.5;
  let cs1 = phaseCloud(cS); let cm1 = phaseCloud(cM);
  // ice crystals (cirrus, 20–100 µm): a narrower diffraction peak and a broad body, asymmetry ≈ 0.8 (halos are separate)
  let ci1 = 0.5*phaseHG(cS, 0.995) + 0.5*phaseHG(cS, 0.6); let cim = 0.5*phaseHG(cM, 0.995) + 0.5*phaseHG(cM, 0.6);
  let iso = 1.0/(4.0*PI);
  var cloudSteps = 0u;
  let rj = fract(hash3(vec3u(pxX, py, 4211u)).x + f32(n)*0.7548776662);
  for (var i = 0u; i < NS; i++) {
    let f0 = f32(i)/f32(NS); let f1 = f32(i + 1u)/f32(NS); let ta = tEnd*f0*f0; let tb = tEnd*f1*f1; let dt = tb - ta; let tAir = ta + dt*jt;
    // clouds in this segment
    var Fs = 0.0; var Fm = 0.0; var Fa = 0.0; var Fg = 0.0; var Fd = 0.0; var FgS = 0.0; var FgM = 0.0; var FgA = 0.0; var FgR = 0.0; var TcAir = Tc;
    let qa = volPos(ro + rd*ta); let qb = volPos(ro + rd*tb);
    let segLo = min(qa.y, qb.y); let segHi = max(qa.y, qb.y);
    if (cloudOn && Tc > 0.0 && segHi > CU.band.x - 0.3 && segLo < CU.band.y + 0.1) {
      var t = ta; var airDone = false;
      let base = clamp(ta*0.005, 0.02, 1.0);
      t += base*rj;
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
        detailLod = 1.0 - smoothstep(0.008, 0.02, t*PI/fH);   // (the ~25 m billows only where a pixel is finer than ~15 m)
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
          var lt = lightAt(q);
          if (F.sunDir.w > 0.5 && t < 60.0 && !coarse) {
            // (steps growing from 15 m: the billows and domes of ~50–150 m shade each other, which is what makes them read;
            // sample positions jittered per pixel and pass: fixed ones would step as the cloud's surfaces cross them, drawing
            // contour bands; jittered, the steps average out)
            var tl = 0.0; var d0 = 0.0; var sf = 0.015;
            let rl = fract(rj*1.618 + 0.31);
            for (var j = 0; j < 7; j++) { tl += densFull(volPos(p + Ls*(d0 + rl*sf)))*sf; d0 += sf; sf *= 1.5; }
            var sd = 0.12;
            for (var j = 0; j < 6; j++) { if (tl > 25.0) { break; } tl += densMacro(volPos(p + Ls*(d0 + rl*sd)))*sd; d0 += sd; sd *= 1.4; }
            lt.x = tl + select(lightAt(volPos(p + Ls*d0)).x, 0.0, tl > 25.0);
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
          let isCu = vr.a < 0.5; let Rc = clamp(vr.a/0.5*2.4, 0.25, 2.4);
          let Wc = select(40.0, 2.6*Rc, isCu);
          let Hc = select(0.6, 2.0*Rc*mix(0.35, 0.65 + 1.6*CU.wind.w, clamp(Rc/1.5, 0.0, 1.0)), isCu);
          // first order: the droplets' full phase function (silver linings, the bright aureole of thin edges)
          let ice = vr.a > 0.8;
          let sunF = select(cs1, ci1, ice)*exp(-lt.x); let moonF = select(cm1, cim, ice)*exp(-lt.y);
          let dI = Tc*(1.0 - exp(-sig*ds));
          Fs += dI*sunF; Fm += dI*moonF;
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
              let ws = clamp(0.5 + 0.5*cS, 0.0, 1.0);   // the stream travelling on (away from the sun) is seen looking toward it
              // light that has crossed only a few optical depths still travels mostly forward (Monte Carlo: of the diffuse light
              // through τ 1, 38% is within 5° of the beam; τ 5, 9%; gone by τ ~10–15): a narrow forward lobe that fades with
              // depth, on top of the broad stream; this is what keeps thin clouds near the sun bright white
              let fp = exp(-dA/2.5);
              let fwd = (1.0 - fp)*ws + fp*PI*phaseHG(cS, 0.9);
              Fd += dI*fD*(max(Dn - ex, 0.0)*fwd + fU*Up*(1.0 - ws))/PI;
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
          let lgl = u32(clamp(round(log2(max(q.y, 0.1)*CU.res.z/CU.vol.x)), levelOf(q.xz).x, CU.vol.z - 1.0));
          let gl = rawLight(q.xz, 0.0, lgl);
          Fg += kg; FgS += kg*exp(-gl.x); FgM += kg*exp(-gl.y); FgA += kg/(1.0 + 0.105*gl.z); FgR += kg*rDiff(gl.z);
          Tc *= exp(-sig*ds);
        }
        t += ds;
      }
      if (!airDone) { TcAir = Tc; }
    }
    // the light sources for this segment (spectral), at its middle
    let tm = 0.5*(ta + tb); let pm = ro + rd*tm; let rm = length(pm - C0); let hm = rm - Rg; let upm = (pm - C0)/rm;
    let muSm = dot(upm, Ls); let muMm = dot(upm, Lm);
    // the air at a jittered point of the segment, shadowed by the clouds toward the sun (crepuscular rays)
    let p = ro + rd*tAir; let r = length(p - C0); let h = r - Rg; let up = (p - C0)/r;
    let muS = dot(up, Ls); let muM = dot(up, Lm);
    var shS = 1.0; var shM = 1.0; var shA = 1.0;
    if (cloudOn) { let la = lightAt(volPos(p)); shS = exp(-la.x); shM = exp(-la.y); shA = 1.0/(1.0 + 0.18*la.z); }
    let dM = densM(h); let dF = densF(h); let dR = densR(h); let dO = densO(h);
    for (var g = 0u; g < 6u; g++) {
      let sR = F.BR[g]*dR; let sM = F.BMs[g]*dM; let ext = sR + sM + F.BMa[g]*dM + F.BO[g]*dO + vec4f(dF); let sT = sR + sM + vec4f(dF);
      var S = vec4f(0.0);
      if (F.sunDir.w > 0.5) { S += F.SunE[g]*((sR*pRs + sM*pMs + dF*pFs)*transmittance(g, r, muS)*shS + sT*msLUT(g, h, muS)*shA); }
      if (F.moonDir.w > 0.5) { S += F.MoonE[g]*((sR*pRm + sM*pMm + dF*pFm)*transmittance(g, r, muM)*shM + sT*msLUT(g, h, muM)*shA); }
      let att = exp(-ext*dt);
      L[g] += T[g]*TcAir*(S - S*att)/max(ext, vec4f(1e-9));
      if (Fs + Fm + Fa + Fg + Fd > 0.0) {
        var Ec = vec4f(0.0);
        if (F.sunDir.w > 0.5) { let Te = F.SunE[g]*transmittance(g, rm, muSm); Ec += Te*(Fs + Fd); }
        if (F.moonDir.w > 0.5) { Ec += F.MoonE[g]*transmittance(g, rm, muMm)*Fm; }
        Ec += ambE(g, hm)*Fa;
        if (Fg > 0.0) {
          var Eg = ambE(g, 0.0)*FgA;
          if (F.sunDir.w > 0.5) { Eg += F.SunE[g]*transmittance(g, Rg, Ls.y)*max(Ls.y, 0.0)*FgS; }
          if (F.moonDir.w > 0.5) { Eg += F.MoonE[g]*transmittance(g, Rg, Lm.y)*max(Lm.y, 0.0)*FgM; }
          // (light bouncing between the ground and the cloud deck above it: ×1/(1 − ρ_ground·ρ_cloud), ~2× over snow)
          Ec += F.Alb[g]*Eg/(1.0 - F.Alb[g]*FgR/Fg);
        }
        L[g] += T[g]*sqrt(att)*Ec;
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
      var Ed = ambE(g, 0.0)*gs.z;
      if (F.sunDir.w > 0.5) { let m0 = max(ground.x, 0.0); let Es = F.SunE[g]*transmittance(g, Rg, ground.x)*m0;
        // two-stream: what the clouds take out of the beam mostly reaches the ground as diffuse light
        var tt = gs.x; if (gs.w > 0.0 && m0 > 0.0) { let mm = min(m0, 1.0); tt = max((0.5 + 0.75*mm + (0.5 - 0.75*mm)*gs.x)/(1.0 + 0.105*gs.w), gs.x); }
        Ed += Es*tt; }
      if (F.moonDir.w > 0.5) { Ed += F.MoonE[g]*transmittance(g, Rg, ground.y)*max(ground.y, 0.0)*gs.y; }
      bg = F.Alb[g]*Ed/PI/(1.0 - F.Alb[g]*select(0.0, rDiff(gs.w), cloudOn && hitG));
    } else if (gN <= 0.0) {
      bg = F.Air[g]*vr;
      if (sunN > 0u) { var acc = vec4f(0.0); for (var k = 0u; k < sunN; k++) { acc += pow(vec4f(sunSm[k]), F.SunA[g]); } bg += F.SunK[g]*acc/16.0; }
      bg += F.MoonK[g]*moonAcc;
      bg += mwL*starSpec(u32(F.galY.w), g);
      for (var k = 0u; k < st.n; k++) { bg += st.w[k]*starSpec(st.t[k], g); }
    }
    let Lg = L[g] + T[g]*Tc*bg;
    xyz += vec3f(dot(Lg, F.CMFx[g]), dot(Lg, F.CMFy[g]), dot(Lg, F.CMFz[g]));
  }
  let idx = (py - PS.pad)*W + pxX;   // (pad: the first row the buffer holds; exports render in bands)
  accum[idx] += vec4f(select(vec3f(0.0), xyz, all(xyz == xyz)), 1.0);
}
