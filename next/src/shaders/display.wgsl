// ---------- display: the accumulated panorama, exposed and tone mapped (AgX), as a panorama or a pinhole camera ----------
struct Disp {
  canvas: vec2f, pano: vec2f,      // canvas size px; panorama size px
  rect: vec4f,                     // panorama placement in the canvas (x, y, w, h)
  view: vec4f,                     // x mode (0 panorama, 1 look around, 2 luminance), y yaw, z pitch, w vertical fov
  ex: vec4f,                       // x exposure (multiplies cd/m²), y azimuth offset
  ld: vec4f,                       // look-dev references: x on, y ball radius px
}
@group(0) @binding(0) var<uniform> D: Disp;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> accPrev: array<vec4f>;   // the last finished image, shown where the new one has not reached
@group(0) @binding(3) var<storage, read> sh: array<vec4f, 9>;       // the panorama's lighting in spherical harmonics (lookdev.wgsl)

struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO; o.pos = vec4f(p*2.0 - 1.0, 0.0, 1.0); return o;
}
fn agxContrast(x: vec3f) -> vec3f { let x2 = x*x; let x4 = x2*x2; return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
fn agx(v0: vec3f) -> vec3f {
  let M = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let Mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let mn = -12.47393; let mx = 4.026069;
  var v = M*v0; v = clamp(log2(max(v, vec3f(1e-10))), vec3f(mn), vec3f(mx)); v = (v - mn)/(mx - mn);
  return clamp(Mi*agxContrast(v), vec3f(0.0), vec3f(1.0));
}
fn turbo(x: f32) -> vec3f {
  let kR = vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234); let kR2 = vec2f(-152.94239396, 59.28637943);
  let kG = vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333); let kG2 = vec2f(4.27729857, 2.82956604);
  let kB = vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771); let kB2 = vec2f(-89.90310912, 27.34824973);
  let v4 = vec4f(1.0, x, x*x, x*x*x); let v2 = v4.zw*v4.z;
  return clamp(vec3f(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), vec3f(0.0), vec3f(1.0));
}
fn texel(x: i32, y: i32) -> vec3f {
  let W = i32(D.pano.x); let H = i32(D.pano.y);
  let xx = ((x % W) + W) % W; let yy = clamp(y, 0, H - 1);
  var a = accum[u32(yy*W + xx)]; if (a.w <= 0.0) { a = accPrev[u32(yy*W + xx)]; } return a.xyz/max(a.w, 1e-6);
}
fn samplePano(uv: vec2f) -> vec3f {   // bilinear, wrapping in azimuth
  let p = uv*D.pano - 0.5; let i = floor(p); let f = p - i; let x = i32(i.x); let y = i32(i.y);
  return mix(mix(texel(x, y), texel(x + 1, y), f.x), mix(texel(x, y + 1), texel(x + 1, y + 1), f.x), f.y);
}
// ---------- look-dev references, lit by the sky as it stands: a chrome ball (a mirror, ~60% reflective), an 18% grey ball and
// a colour chart (the 24 standard patches, facing the camera) ----------
const CHART = array<vec3f, 24>(vec3f(0.171, 0.084, 0.058), vec3f(0.539, 0.305, 0.223), vec3f(0.122, 0.195, 0.337), vec3f(0.095, 0.150, 0.056), vec3f(0.235, 0.216, 0.440), vec3f(0.136, 0.509, 0.402), vec3f(0.672, 0.209, 0.025), vec3f(0.080, 0.105, 0.381), vec3f(0.533, 0.102, 0.125), vec3f(0.112, 0.045, 0.150), vec3f(0.337, 0.503, 0.051), vec3f(0.745, 0.366, 0.027), vec3f(0.040, 0.047, 0.305), vec3f(0.061, 0.296, 0.067), vec3f(0.429, 0.037, 0.045), vec3f(0.799, 0.571, 0.014), vec3f(0.497, 0.093, 0.301), vec3f(0.002, 0.235, 0.356), vec3f(0.896, 0.896, 0.888), vec3f(0.578, 0.578, 0.578), vec3f(0.352, 0.352, 0.352), vec3f(0.195, 0.195, 0.191), vec3f(0.091, 0.091, 0.091), vec3f(0.034, 0.034, 0.034));
// irradiance on a surface facing n, from the harmonics (Ramamoorthi & Hanrahan's convolution with the cosine lobe)
fn irradiance(d: vec3f) -> vec3f {
  let A0 = PI; let A1 = 2.0*PI/3.0; let A2 = PI/4.0;
  return A0*0.282095*sh[0].xyz + A1*0.488603*(sh[1].xyz*d.y + sh[2].xyz*d.z + sh[3].xyz*d.x)
       + A2*(1.092548*(sh[4].xyz*d.x*d.y + sh[5].xyz*d.y*d.z + sh[7].xyz*d.x*d.z) + 0.315392*sh[6].xyz*(3.0*d.z*d.z - 1.0) + 0.546274*sh[8].xyz*(d.x*d.x - d.y*d.y));
}
fn panoDir(d: vec3f) -> vec3f { let az = atan2(d.x, d.z) - D.ex.y; let el = asin(clamp(d.y, -1.0, 1.0)); return samplePano(vec2f(fract(az/(2.0*PI) + 0.5), 0.5 - el/PI)); }
// (XYZ of the look-dev element under the pixel, or w = 0 where there is none)
fn lookdev(fc: vec2f) -> vec4f {
  let R = D.ld.y; let m = 14.0; let base = D.canvas.y - m - R;
  let cy = cos(D.view.y); let sy = sin(D.view.y); let cp = cos(D.view.z); let sp = sin(D.view.z);
  let fwd = vec3f(sy*cp, sp, cy*cp); let right = normalize(vec3f(cy, 0.0, -sy)); let up = cross(fwd, right);
  for (var b = 0; b < 2; b++) {
    let c = vec2f(m + R + f32(b)*(2.0*R + 10.0), base); let s = (fc - c)/R; let r2 = dot(s, s);
    if (r2 <= 1.0) {
      let n = normalize(right*s.x - up*s.y - fwd*sqrt(1.0 - r2));
      if (b == 0) { return vec4f(0.6*panoDir(reflect(fwd, n)), 1.0); }
      return vec4f(0.18/PI*max(irradiance(n), vec3f(0.0)), 1.0);
    }
  }
  // the chart: 6 × 4 patches, facing the camera
  let ps = R*0.62; let x0 = m + 4.0*R + 24.0; let y0 = base - 2.0*ps - 3.0;
  let q = (fc - vec2f(x0, y0))/(ps + 2.0);
  if (q.x >= 0.0 && q.y >= 0.0 && q.x < 6.0 && q.y < 4.0) {
    if (fract(q.x)*(ps + 2.0) > ps || fract(q.y)*(ps + 2.0) > ps) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    let k = u32(q.y)*6u + u32(q.x);
    let X2R = mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
    let R2X = mat3x3f(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041);
    let e = max(X2R*irradiance(-fwd), vec3f(0.0));
    var chart = CHART;   // (a function-scope copy: indexed at run time)
    return vec4f(R2X*(chart[k]*e/PI), 1.0);
  }
  return vec4f(0.0);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let fc = v.pos.xy; var xyz: vec3f;
  let mode = i32(D.view.x);
  var ldv = vec4f(0.0); if (D.ld.x > 0.5) { ldv = lookdev(fc); }
  if (mode == 1) {
    // look around: pinhole camera (yaw from north, clockwise; pitch up)
    let ndc = vec2f(fc.x/D.canvas.x*2.0 - 1.0, 1.0 - fc.y/D.canvas.y*2.0); let tf = tan(D.view.w*0.5);
    let dc = normalize(vec3f(ndc.x*tf*D.canvas.x/D.canvas.y, ndc.y*tf, 1.0));
    let cy = cos(D.view.y); let sy = sin(D.view.y); let cp = cos(D.view.z); let sp = sin(D.view.z);
    let fwd = vec3f(sy*cp, sp, cy*cp); let right = normalize(vec3f(cy, 0.0, -sy)); let up = cross(fwd, right);
    let d = normalize(fwd*dc.z + right*dc.x + up*dc.y);
    let az = atan2(d.x, d.z) - D.ex.y; let el = asin(clamp(d.y, -1.0, 1.0));
    xyz = samplePano(vec2f(fract(az/(2.0*PI) + 0.5), 0.5 - el/PI));
  } else {
    let q = (fc - D.rect.xy)/D.rect.zw;
    if (any(q < vec2f(0.0)) || any(q > vec2f(1.0))) { if (ldv.w <= 0.0) { return vec4f(0.027, 0.035, 0.047, 1.0); } }
    else { xyz = texel(i32(q.x*D.pano.x), i32(q.y*D.pano.y)); }
  }
  if (ldv.w > 0.0) { xyz = ldv.xyz; }
  if (mode == 2) { let l = (log(max(xyz.y, 1e-7))/log(10.0) + 4.0)/13.0; return vec4f(turbo(clamp(l, 0.0, 1.0)), 1.0); }
  let X2R = mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  let lin = max(X2R*xyz, vec3f(0.0))*D.ex.x;
  return vec4f(agx(lin), 1.0);
}
// ---------- look-dev model: a dropped mesh, in front of the look-around camera, lit by the sky as it stands ----------
// Diffuse from the panorama's harmonics; specular by GGX importance samples of the panorama itself, with the split-sum
// environment BRDF (Karis's fit). No shadowing of the model by itself.
struct Mesh {
  rot: vec4f,       // x cos spin, y sin spin, z distance from the camera, w scale
  alb: vec4f,       // albedo (linear Rec.709), w roughness
  spec: vec4f,      // F0 (linear Rec.709), w samples
}
@group(0) @binding(4) var<uniform> MS: Mesh;
struct MVO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f }
fn camBasis() -> mat3x3f {
  let cy = cos(D.view.y); let sy = sin(D.view.y); let cp = cos(D.view.z); let sp = sin(D.view.z);
  let fwd = vec3f(sy*cp, sp, cy*cp); let right = normalize(vec3f(cy, 0.0, -sy)); let up = cross(fwd, right);
  return mat3x3f(right, up, fwd);
}
@vertex fn vsMesh(@location(0) p: vec3f, @location(1) n: vec3f) -> MVO {
  // the model turns about the world's vertical, then stands at the centre of the view, its own "front" toward the camera
  let B = camBasis(); let c = MS.rot.x; let s = MS.rot.y;
  let yawF = normalize(vec3f(B[2].x, 0.0, B[2].z) + vec3f(0.0, 0.0, 1e-6)); let yawR = vec3f(yawF.z, 0.0, -yawF.x);
  let ps = vec3f(c*p.x + s*p.z, p.y, -s*p.x + c*p.z); let ns = vec3f(c*n.x + s*n.z, n.y, -s*n.x + c*n.z);
  // (model space: +z toward the camera, +x to its right as seen, +y up)
  let wp = B[2]*MS.rot.z + (yawR*ps.x + vec3f(0.0, ps.y, 0.0) - yawF*ps.z)*MS.rot.w;
  let wn = yawR*ns.x + vec3f(0.0, ns.y, 0.0) - yawF*ns.z;
  let v = vec3f(dot(wp, B[0]), dot(wp, B[1]), dot(wp, B[2])); let tf = tan(D.view.w*0.5); let asp = D.canvas.x/D.canvas.y;
  var o: MVO; let nr = 0.01; let fr = 1000.0;
  o.pos = vec4f(v.x/(tf*asp), v.y/tf, (v.z - nr)/(fr - nr)*v.z, v.z); o.wp = wp; o.n = wn; return o;
}
fn hashF(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233)))*43758.5453); }
@fragment fn fsMesh(v: MVO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(v.n); let V = normalize(-v.wp); if (dot(n, V) < 0.0) { n = -n; }
  let X2R = mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  let a = max(MS.alb.w*MS.alb.w, 0.002); let NoV = max(dot(n, V), 1e-4);
  // GGX samples about the reflection (Hammersley, turned per pixel), weighted by N·L
  let t = normalize(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9)); let tx = normalize(cross(t, n)); let ty = cross(n, tx);
  let rot = hashF(v.pos.xy)*6.2831853; let N = u32(MS.spec.w);
  var acc = vec3f(0.0); var wsum = 0.0;
  for (var i = 0u; i < N; i++) {
    let u1 = (f32(i) + 0.5)/f32(N); let u2 = fract(f32(reverseBits(i))*2.3283064e-10 + rot/6.2831853);
    let ph = 6.2831853*u2; let ct = sqrt((1.0 - u1)/(1.0 + (a*a - 1.0)*u1)); let st = sqrt(1.0 - ct*ct);
    let H = normalize(tx*(st*cos(ph)) + ty*(st*sin(ph)) + n*ct); let L = reflect(-V, H); let NoL = dot(n, L);
    if (NoL > 0.0) { acc += max(X2R*panoDir(L), vec3f(0.0))*NoL; wsum += NoL; }
  }
  let pre = acc/max(wsum, 1e-6);
  // (Karis's analytic fit of the environment BRDF)
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022); let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = c0*MS.alb.w + c1; let a004 = min(r.x*r.x, exp2(-9.28*NoV))*r.x + r.y; let AB = vec2f(-1.04, 1.04)*a004 + r.zw;
  let spec = pre*(MS.spec.xyz*AB.x + AB.y);
  let diff = MS.alb.xyz/PI*max(X2R*irradiance(n), vec3f(0.0))*(1.0 - (MS.spec.xyz*AB.x + AB.y));
  let lin = max(diff + spec, vec3f(0.0))*D.ex.x;
  if (i32(D.view.x) == 2) { let R2X = mat3x3f(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041);
    let y = (R2X*(lin/D.ex.x)).y; let l = (log(max(y, 1e-7))/log(10.0) + 4.0)/13.0; return vec4f(turbo(clamp(l, 0.0, 1.0)), 1.0); }
  return vec4f(agx(lin), 1.0);
}
const PI: f32 = 3.14159265358979;
