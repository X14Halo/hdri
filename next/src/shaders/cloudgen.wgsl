// ---------- building the cloud volume: every enabled layer evaluated at each voxel ----------
@group(0) @binding(0) var<uniform> CU: Cloud;
@group(0) @binding(1) var densOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read> cuRec: array<vec4f>;     // 3 per cloud: (x, z, R, base) (H, seed, shear x, shear z) (sigma, dev, -, -)
@group(0) @binding(3) var<storage, read> cuStart: array<u32>;     // grid cell → first index (cells of GRID km over DOMAIN km)
@group(0) @binding(4) var<storage, read> cuIdx: array<u32>;
@group(0) @binding(5) var<uniform> GP: vec4u;                     // x level, y first voxel row (altitude), z rows, w number of clouds
@group(0) @binding(6) var<uniform> LY: Layers;
@group(0) @binding(7) var noiseTex: texture_3d<f32>;
@group(0) @binding(8) var wrapSamp: sampler;
@group(0) @binding(9) var<uniform> F: Frame;                      // (declared for common.wgsl; unused here)
@group(0) @binding(10) var<storage, read_write> fieldOut: array<f32>;   // (coverage field samples, for calibrating cover)

// the layered (field) cloud types. x cover, y base km, z thickness km, w form; second: x cell size km, y seed, z extinction /km,
// w wind direction (rad); thr: the coverage threshold of each layer, found so its cover matches the setting
struct Layers { sc: vec4f, sc2: vec4f, ac: vec4f, ac2: vec4f, ci: vec4f, ci2: vec4f, wind: vec4f, thr: vec4f }

// (levelE comes from cloudu.wgsl)
const GRID: f32 = 2.0; const DOMAIN: f32 = 512.0; const NC: u32 = 256u;

fn smax(a: f32, b: f32, k: f32) -> f32 { let h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0); return mix(a, b, h) + k*h*(1.0 - h); }

// one cumulus: turrets (bubbles of rising air) stacked over a flat base, leaning downwind with the shear.
// returns (signed distance km, height within the cloud 0…1); distance < -0.5 when far outside
fn cuEval(p: vec3f, k: u32) -> vec2f {
  let a = cuRec[3u*k]; let b = cuRec[3u*k + 1u];
  let base = a.w; let H = b.x; let R = a.z; let y = p.y - base;
  if (y < -0.4 || y > H*1.35 + 0.1) { return vec2f(-1.0, 0.0); }
  let c2 = cuRec[3u*k + 2u]; let el = max(c2.z, 1.0);
  var q0 = p.xz - a.xy - b.zw*max(y, 0.0);
  if (dot(q0, q0) > (R*1.45*el + 0.3)*(R*1.45*el + 0.3)) { return vec2f(-1.0, 0.0); }
  let seed = u32(b.y); let dev = c2.y;
  // into the cloud's own frame: stretched along its long axis, outline made irregular by a gentle warp
  let ca = cos(c2.w); let sa = sin(c2.w); q0 = vec2f(ca*q0.x + sa*q0.y, -sa*q0.x + ca*q0.y); q0.x /= el;
  let hw = hash3(vec3u(seed, 91u, 3u));
  let wq = q0/R;
  q0 += R*0.3*vec2f(sin(wq.y*2.3 + 6.28*hw.x) + 0.5*sin(wq.x*4.1 + wq.y*1.7 + 6.28*hw.y), sin(wq.x*2.1 + 6.28*hw.z) + 0.5*sin(wq.y*3.7 - wq.x*1.3 + 6.28*hw.x));
  // body: a half-ellipsoid on the base (R across, H up); turrets: bubbles of rising air bulging from its upper surface,
  // smaller and more numerous on tall clouds (cauliflower), a few broad lumps on flat fair-weather ones
  let tall = clamp(H/(2.0*R), 0.0, 3.0);
  // (sides near vertical, top domed: h(r) = H·√(1 − (r/R)^2.5))
  // (continuous across the rim: a jump in the distance field would show as straight voxel-aligned edges)
  let rr = length(q0)/R; let ht = H*sqrt(max(1.0 - pow(min(rr, 1.0), 2.5), 0.0));
  var d = min((1.0 - rr)*R*0.8, (ht - y)*0.8);
  let nb = 9u + u32(6.0*clamp(tall, 0.0, 1.0)) + u32(5.0*dev);
  for (var i = 0u; i < nb; i++) {
    let h = hash3(vec3u(seed, i, 7u)); let h2 = hash3(vec3u(seed, i, 19u));
    // a point on the upper surface of the body: azimuth, and elevation weighted toward the top
    let az = 6.2831853*h.x; let el = mix(0.25, 1.45, pow(h.y, 0.7));
    let dir = vec3f(cos(az)*cos(el), sin(el), sin(az)*cos(el));
    let rb = min(R, H*1.3)*(0.2 + 0.24*h2.x)*(1.0 - 0.25*sin(el));
    // on the dome, but not bulging out past the base: a cloud is widest at or near its base
    let cr = min(cos(el)*(0.55 + 0.4*h.z), max(1.0 - 1.1*rb/R, 0.0)); let ch = H*sqrt(max(1.0 - pow(cr, 2.5), 0.0));
    let c = vec3f(cos(az)*cr*R, max(ch*(0.82 + 0.1*h2.z), rb*0.7), sin(az)*cr*R);
    let e = (vec3f(q0.x, y, q0.y) - c)/vec3f(rb, rb*(0.85 + 0.3*h2.y), rb);
    d = smax(d, (1.0 - length(e))*rb, 0.02 + 0.03*rb);
  }
  // the flat base (the condensation level), gently uneven
  let bn = (hash3(vec3u(u32(floor(q0.x*4.0) + 4096.0), u32(floor(q0.y*4.0) + 4096.0), seed)).x - 0.5)*0.0;
  d = min(d, y + bn);
  return vec2f(d, clamp(y/max(H, 1e-3), 0.0, 1.0));
}

// ---------- noise for the layer fields: the tileable noise volume read at incommensurate scales (nothing repeats) ----------
fn nz(p: vec3f) -> f32 { return textureSampleLevel(noiseTex, wrapSamp, p, 0.0).a; }
fn nzb(p: vec3f) -> f32 { return textureSampleLevel(noiseTex, wrapSamp, p, 0.0).r; }
fn n2(xz: vec2f, km: f32, s: f32) -> f32 { return nz(vec3f(xz.x/km, s, xz.y/km)); }
fn fbm2s(xz: vec2f, km: f32, s: f32) -> f32 { return 0.6*n2(xz, km, s) + 0.4*n2(xz, km*0.377, s + 0.31); }
// cellular noise in 2D: (distance to nearest cell point, to second nearest)
fn worley2(p: vec2f, seed: u32) -> vec2f {
  let i = floor(p); let f = p - i; var d1 = 9.0; var d2 = 9.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let o = vec2f(f32(x), f32(y)); let c = vec2u(vec2i(i + o) + vec2i(65536));
    let r = o + hash3(vec3u(c, seed)).xy - f; let d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; } } }
  return sqrt(vec2f(d1, d2));
}
fn rot(xz: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c*xz.x + s*xz.y, -s*xz.x + c*xz.y); }

// ---------- stratocumulus / stratus: a deck of convective cells. Closed cells: cloud fills them, thin gaps between;
// open cells: cloud on the rims; stratus: a featureless sheet. Returns (coverage field, how central in its cell)
fn scField(xz: vec2f) -> vec2f {
  let cs = LY.sc2.x; let seed = u32(LY.sc2.y); let form = LY.sc.w;
  let w = vec2f(n2(xz, cs*3.1, 0.13) - 0.5, n2(xz, cs*3.1, 0.57) - 0.5)*cs*1.1;
  let q = rot(xz + w, LY.sc2.w)/vec2f(cs*1.35, cs);           // (a little stretched along the wind)
  let f = worley2(q, seed); let edge = f.y - f.x;
  let closed = smoothstep(0.02, 0.4, edge); let open = 1.0 - smoothstep(0.0, 0.3, edge);
  let cell = mix(mix(1.0, closed, smoothstep(0.0, 0.45, form)), open, smoothstep(0.55, 1.0, form));
  let det = fbm2s(xz, cs*0.45, 0.71);
  let meso = n2(xz, 38.0, 0.91) - 0.5;
  return vec2f(0.7*cell + 0.3*det + 0.45*meso, cell);
}
// ---------- altocumulus / altostratus: a sheet of cloudlets in rows across the wind (billows of the shear), in patches;
// altostratus: a thick grey veil with soft undulations. Returns (coverage field, lump height)
fn acField(xz: vec2f) -> vec2f {
  let cs = LY.ac2.x; let seed = u32(LY.ac2.y); let form = LY.ac.w;
  let w = vec2f(n2(xz, cs*4.3, 0.21) - 0.5, n2(xz, cs*4.3, 0.63) - 0.5)*cs*1.6;
  let q = rot(xz + w, LY.ac2.w)/vec2f(cs*0.8, cs*1.25);       // rows lie across the wind
  let f = worley2(q, seed + 5u);
  let lump = 1.0 - smoothstep(0.05, 0.75, f.x);
  let wave = 0.5 + 0.5*sin(6.2831853*q.x*0.9 + 4.0*n2(xz, cs*6.0, 0.37));
  let veil = 0.75 + 0.25*fbm2s(xz, 6.0, 0.45);
  let meso = fbm2s(xz, 22.0, 0.83) - 0.5;
  let c = mix(veil, 0.75*lump + 0.25*wave, form) + 0.7*meso;
  return vec2f(c, mix(veil, lump, form));
}
// ---------- cirrus: ice from generating cells high up, trailing fall streaks that hang back and curve as they sink into
// slower air (mares' tails); cirrostratus: a thin even veil; cirrocumulus: tiny ripples. (coverage field, fibre strength)
fn ciField(xz: vec2f) -> vec2f {
  let cs = LY.ci2.x; let seed = u32(LY.ci2.y); let form = LY.ci.w;
  let q = rot(xz, LY.ci2.w);
  let warp = (n2(xz, cs*5.0, 0.17) - 0.5)*cs*2.5;
  let fib = nz(vec3f(q.x/(cs*9.0), 0.33, (q.y + warp)/(cs*0.55)));            // fibres along the wind
  let fib2 = nz(vec3f(q.x/(cs*3.0), 0.77, (q.y + warp*0.6)/(cs*0.21)));
  let heads = 1.0 - smoothstep(0.1, 0.6, worley2(q/vec2f(cs*2.2, cs*1.4), seed + 9u).x);
  let veil = 0.8 + 0.2*fbm2s(xz, 9.0, 0.53);
  let cc = 1.0 - smoothstep(0.1, 0.7, worley2(q/(cs*0.12), seed + 13u).x);       // cirrocumulus grains
  let streak = 0.45*fib + 0.25*fib2 + 0.3*heads;
  var c = mix(veil, streak, smoothstep(0.0, 0.5, form));
  c = mix(c, 0.5*cc + 0.5*fib, smoothstep(0.6, 1.0, form));
  let meso = fbm2s(xz, 30.0, 0.29) - 0.5;
  return vec2f(c + 0.6*meso, fib);
}

struct Hit { d: f32, sig: f32, v: f32, r: f32 }
fn evalAt(p: vec3f) -> Hit {
  var best = Hit(-1.0, 0.0, 0.0, 0.0);
  // the layers (alpha codes the style for the renderer's fine detail: < 0.5 cumulus by size, 0.65 water sheets, 0.9 ice)
  if (LY.sc.x > 0.0 && p.y > LY.sc.y - 0.35 && p.y < LY.sc.y + LY.sc.z + 0.3) {
    // cells are domes: thickest in the middle, thinning to their edges (thin bright rims, dark cores seen from below), merging
    // into a continuous deck where the cover is high
    let f = scField(p.xz); let th = LY.sc.z; let m = smoothstep(LY.thr.x - 0.03, LY.thr.x + 0.28, f.x);
    let top = LY.sc.y + th*(0.2 + 0.8*m) + th*0.18*(n2(p.xz, 1.7, 0.41) - 0.5);
    let bot = LY.sc.y + th*0.22*(1.0 - m) + 0.05*(n2(p.xz, 2.3, 0.19) - 0.5);
    let dv = min(p.y - bot, top - p.y); let dh = (f.x - LY.thr.x)*LY.sc2.x*0.35;
    let d = min(dv, dh);
    // lumpy (cumuliform) except for stratus: the size code drives the renderer's billows in proportion to the deck
    let st = select(0.65, 0.5*clamp(th*0.9/2.4, 0.04, 0.5), LY.sc.w > 0.15);
    if (d > best.d) { best = Hit(d, LY.sc2.z, clamp((p.y - bot)/max(top - bot, 0.05), 0.0, 1.0), st); }
  }
  if (LY.ac.x > 0.0 && p.y > LY.ac.y - 0.3 && p.y < LY.ac.y + LY.ac.z + 0.3) {
    let f = acField(p.xz); let th = LY.ac.z; let form = LY.ac.w;
    let top = LY.ac.y + th*mix(0.85 + 0.15*f.y, 0.35 + 0.65*f.y, form);
    let bot = LY.ac.y + th*mix(0.05*(1.0 - f.y), 0.35*(1.0 - f.y), form);
    let dv = min(p.y - bot, top - p.y); let dh = (f.x - LY.thr.y)*LY.ac2.x*0.3;
    let d = min(dv, dh);
    let st = select(0.65, 0.5*clamp(LY.ac2.x*0.45/2.4, 0.03, 0.5), form > 0.3);
    if (d > best.d) { best = Hit(d, LY.ac2.z, clamp((p.y - bot)/max(top - bot, 0.05), 0.0, 1.0), st); }
  }
  if (LY.ci.x > 0.0 && p.y > LY.ci.y - LY.wind.w - 0.2 && p.y < LY.ci.y + LY.ci.z + 0.2) {
    // below the generating level the ice falls in streaks; a streak at depth dz traces back to a head displaced downwind
    let topI = LY.ci.y + LY.ci.z; let dz = max(topI - p.y, 0.0);
    let back = LY.wind.xy*LY.wind.z*pow(dz, 1.3);
    let f = ciField(p.xz + back);
    let inLayer = 1.0 - smoothstep(LY.ci.z*0.6, LY.ci.z, dz);
    let tail = exp(-max(dz - LY.ci.z*0.6, 0.0)/max(LY.wind.w*0.45, 0.05))*smoothstep(0.0, 0.3, LY.ci.w);
    let prof = max(inLayer, tail*f.y);
    let dv = min(p.y - (LY.ci.y - LY.wind.w*select(0.0, 1.0, LY.ci.w > 0.2)), topI - p.y);
    let dh = (f.x*prof - LY.thr.z)*LY.ci2.x*0.25;
    let d = min(dv, dh);
    if (d > best.d) { best = Hit(d, LY.ci2.z*(0.4 + 0.6*prof), clamp(1.0 - dz/(LY.ci.z + LY.wind.w), 0.0, 1.0), 0.9); }
  }
  if (GP.w > 0u) {
    let c = vec2i(floor((p.xz + 0.5*DOMAIN)/GRID));
    if (c.x >= 0 && c.y >= 0 && c.x < i32(NC) && c.y < i32(NC)) {
      let cell = u32(c.y)*NC + u32(c.x); let s0 = cuStart[cell]; let s1 = cuStart[cell + 1u];
      for (var j = s0; j < s1; j++) { let k = cuIdx[j]; let r = cuEval(p, k);
        if (r.x > best.d) { best = Hit(r.x, cuRec[3u*k + 2u].x, r.y, 0.5*clamp(cuRec[3u*k].z/2.4, 0.0, 1.0)); } }
    }
  }
  return best;
}
fn encodeSig(s: f32) -> f32 { return select(clamp(log2(s/0.05)/13.0, 1.0/255.0, 1.0), 0.0, s <= 0.0); }

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let NX = u32(CU.res.x); let NZ = u32(CU.res.y); let l = GP.x;
  if (id.x >= NX || id.y >= NX || id.z >= GP.z) { return; }
  let k = GP.y + id.z; if (k >= NZ) { return; }
  let E = levelE(l); let vx = E/f32(NX); let alt = sliceToAlt(f32(k) + 0.5, f32(NZ)); let vz = sliceToAlt(f32(k) + 1.0, f32(NZ)) - sliceToAlt(f32(k), f32(NZ));
  let p = vec3f((f32(id.x) + 0.5)/f32(NX)*E - 0.5*E, alt, (f32(id.y) + 0.5)/f32(NX)*E - 0.5*E);
  var o = vec4f(0.0);
  if (f32(l) < CU.vol.w) {
    let h = evalAt(p);
    if (h.d > -0.5) { o = vec4f(clamp(h.d, -0.5, 0.5) + 0.5, encodeSig(h.sig), h.v, h.r); }
  } else {
    // coverage: the fraction of 8 points spread through the voxel that are inside a cloud
    var cov = 0.0; var sg = 0.0; var vv = 0.0; var st = 0.0;
    for (var s = 0u; s < 8u; s++) {
      let jt = (vec3f(f32(s & 1u), f32((s >> 1u) & 1u), f32((s >> 2u) & 1u)) - 0.5)*0.5 + (hash3(vec3u(id.x, id.y, k*8u + s)) - 0.5)*0.4;
      let h = evalAt(p + jt*vec3f(vx, vz, vx));
      let inside = smoothstep(-0.03, 0.03, h.d); cov += inside; sg = max(sg, h.sig); vv += h.v*inside; st = max(st, h.r*inside);
    }
    if (cov > 0.0) { o = vec4f(cov/8.0, encodeSig(sg), vv/cov, st); }
  }
  textureStore(densOut, vec3u(id.x, id.y, l*NZ + k), o);
}

// the coverage field of one layer (GP.x: 0 low deck, 1 mid, 2 high) on a 256² grid over the central 64 km, for calibration
@compute @workgroup_size(8, 8, 1)
fn fieldMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) { return; }
  let xz = (vec2f(id.xy) + 0.5)/256.0*64.0 - 32.0;
  var c = 0.0;
  if (GP.x == 0u) { c = scField(xz).x; } else if (GP.x == 1u) { c = acField(xz).x; } else { c = ciField(xz).x; }
  fieldOut[id.y*256u + id.x] = c;
}
