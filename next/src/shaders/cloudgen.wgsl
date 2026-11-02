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
@group(0) @binding(11) var cuMapOut: texture_storage_2d_array<rgba16float, write>;   // the cumulus field, one map per level
@group(0) @binding(12) var cuMap: texture_2d_array<f32>;
@group(0) @binding(13) var clampSamp: sampler;

// the layered (field) cloud types. x cover, y base km, z thickness km, w form; second: x cell size km, y seed, z extinction /km,
// w wind direction (rad); thr: the coverage threshold of each layer, found so its cover matches the setting
// cumulus field: cu x cover, y base km, z depth of the convection km, w development; cu2 x field scale km, y seed, z extinction
// factor, w map margin km; cu3 x grouping, y streets, z roll spacing km, w the field's strong-core value; cu4 x shear (km per km
// of height), y size code of the surface detail
struct Layers { sc: vec4f, sc2: vec4f, ac: vec4f, ac2: vec4f, ci: vec4f, ci2: vec4f, wind: vec4f, thr: vec4f, cu: vec4f, cu2: vec4f, cu3: vec4f, cu4: vec4f }

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
  // a smooth ~1.3 km warp of space that changes with height: towers and sides wander and bulge (cauliflower outlines) while the
  // cloud stays one connected mass, rather than being a straight extrusion of its footprint
  let hy = clamp(y/max(H, 0.05), 0.0, 1.2);
  q0 += (vec2f(nz(vec3f(p.x/1.3, p.y*0.9, p.z/1.3) + vec3f(0.6, 0.2, 0.9)), nz(vec3f(p.x/1.3, p.y*0.9, p.z/1.3) + vec3f(0.17, 0.71, 0.37))) - 0.5)*min(R, 1.2)*(0.25 + 0.5*hy);
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
  return vec2f(d, clamp(base/8.0, 0.0, 1.0));   // (this cloud's base altitude, for the extinction profile with height above it)
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
  // cells of uneven size: the pattern drifts between larger and smaller cells from place to place, rather than one size
  // tiled evenly over the whole sky
  let fA = worley2(q, seed); let fB = worley2(q*1.7 + vec2f(17.3, 5.1), seed + 31u);
  let mixB = smoothstep(0.35, 0.65, n2(xz, 21.0, 0.44));
  let edge = mix(fA.y - fA.x, (fB.y - fB.x)*0.85, mixB);
  let closed = smoothstep(0.02, 0.4, edge);
  // open cells: the cloud sits on the rims as chains of lumps (the rims' convective cells), not as thin continuous rings
  let clump = 1.0 - smoothstep(0.1, 0.65, worley2(q*2.9 + vec2f(3.7, 9.1), seed + 7u).x);
  let open = (1.0 - smoothstep(0.0, 0.42, edge))*(0.45 + 0.55*clump);
  let cell = mix(mix(1.0, closed, smoothstep(0.0, 0.45, form)), open, smoothstep(0.55, 1.0, form));
  let det = fbm2s(xz, cs*0.45, 0.71);
  // grouping: thicker, more continuous areas and broken or clear ones (10–40 km), so the deck is not the same everywhere
  let meso = n2(xz, 38.0, 0.91) - 0.5 + 0.6*(n2(xz, 13.7, 0.29) - 0.5);
  return vec2f(0.7*cell + 0.3*det + 0.6*meso, cell);
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
  // (altocumulus comes in patches and sheets with clear sky between, at 20–60 km scales, not evenly over the whole sky)
  let meso = fbm2s(xz, 22.0, 0.83) - 0.5 + 0.8*(n2(xz, 13.0, 0.27) - 0.5);
  // (within a patch the cloudlets merge; toward its edges they shrink apart, with blue between, rather than the patch ending in
  // one hard outline)
  let c = mix(veil, 0.8*lump + 0.2*wave, form) + mix(1.0, 0.5, form)*meso;
  return vec2f(c, mix(veil, lump, form));
}
// ---------- cirrus: ice from generating cells high up, trailing fall streaks that hang back and curve as they sink into
// slower air (mares' tails); cirrostratus: a thin even veil; cirrocumulus: tiny ripples. (coverage field, fibre strength)
fn ciField(xz: vec2f) -> vec2f {
  let cs = LY.ci2.x; let seed = u32(LY.ci2.y); let form = LY.ci.w;
  let q = rot(xz, LY.ci2.w);
  let warp = (n2(xz, cs*5.0, 0.17) - 0.5)*cs*2.5 + (nz(RM2*vec3f(xz.x/(cs*17.0), 0.51, xz.y/(cs*13.0))) - 0.5)*cs*6.0;
  // fibres along the wind (sampled through slanted rotations of the noise volume: no repeating comb of parallel strands)
  let fib = nz(RM1*vec3f(q.x/(cs*9.0), 0.33, (q.y + warp)/(cs*0.55)));
  let fib2 = nz(RM2*vec3f(q.x/(cs*3.0), 0.77, (q.y + warp*0.6)/(cs*0.21)));
  let heads = 1.0 - smoothstep(0.1, 0.6, worley2(q/vec2f(cs*4.0, cs*1.2), seed + 9u).x);
  let veil = 0.8 + 0.2*fbm2s(xz, 9.0, 0.53);
  let cc = 1.0 - smoothstep(0.1, 0.7, worley2(q/(cs*0.12), seed + 13u).x);       // cirrocumulus grains
  let streak = 0.55*fib + 0.3*fib2 + 0.15*heads;
  var c = mix(veil, streak, smoothstep(0.0, 0.5, form));
  c = mix(c, 0.5*cc + 0.5*fib, smoothstep(0.6, 1.0, form));
  let meso = fbm2s(xz, 30.0, 0.29) - 0.5;
  return vec2f(c + 0.6*meso, fib);
}


// ---------- cumulus as one continuous field (the way real cumulus fields and good procedural skies work): where the boundary
// layer's thermals are strong enough, cloud forms. A non-repeating, domain-warped fBm stands for the strength of the
// convection; the cover sets the threshold (a measured quantile), and how far a place is above it sets how deep the cloud
// grows there. So the edges of every cloud are shallow and wispy, clouds merge into irregular complexes, sizes follow a
// power law by themselves, and towers rise only out of the strongest cores, inside the groups rather than alone in clear sky.
// gradient noise from hashed lattice points (no tiling anywhere in the 512 km domain), about −0.7 … 0.7
fn g2h(i: vec2f, s: u32) -> vec2f { let u = vec2u(bitcast<u32>(i32(i.x)), bitcast<u32>(i32(i.y))); let h = hash3(vec3u(u, s)); let a = 6.2831853*h.x; return vec2f(cos(a), sin(a)); }
fn gnoise2(p: vec2f, s: u32) -> f32 {
  let i = floor(p); let f = p - i; let u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  let a = dot(g2h(i, s), f); let b = dot(g2h(i + vec2f(1.0, 0.0), s), f - vec2f(1.0, 0.0));
  let c = dot(g2h(i + vec2f(0.0, 1.0), s), f - vec2f(0.0, 1.0)); let d = dot(g2h(i + vec2f(1.0, 1.0), s), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn cuMeso(xz: vec2f, s: u32) -> f32 { return gnoise2(xz/26.0 + vec2f(3.1, 7.7), s + 40u) + 0.5*gnoise2(xz/11.3 + vec2f(1.9, 4.3), s + 41u); }
// returns (the field, its broad part: the first two octaves and the grouping, i.e. the strength of the thermal a cloud sits on)
fn cuField(xz: vec2f) -> vec2f {
  let L = LY.cu2.x; let s = u32(LY.cu2.y)*97u + 11u;
  var p = xz/L;
  // two warps: the big one bends the groups into irregular, merging complexes; the smaller one makes outlines wander
  p += 0.65*vec2f(gnoise2(p*0.31 + vec2f(5.2, 1.3), s + 1u), gnoise2(p*0.31 + vec2f(1.7, 9.2), s + 2u));
  p += 0.3*vec2f(gnoise2(p*1.13 + vec2f(2.9, 6.1), s + 3u), gnoise2(p*1.13 + vec2f(8.3, 0.7), s + 4u));
  // fBm: each octave turned and scaled by an irrational step, so no direction or size is preferred and nothing repeats; the
  // fine octaves strong enough that outlines are fractal (lobed and notched at every scale, as measured cumulus perimeters are)
  var f = 0.0; var a = 1.0; var na = 0.0; var q = p;
  var fl = 0.0;
  for (var i = 0u; i < 6u; i++) { f += a*gnoise2(q, s + 10u + i); na += a; q = rot(q, 0.6435)*2.137 + vec2f(3.17, 7.93); a *= 0.58; if (i == 1u) { fl = f; } }
  f /= na; fl /= na;
  var o = 0.0;
  // grouping: mesoscale moisture (20–50 km; it shifts how many clouds form, a little, without fusing them into one mass), with
  // the camera's own neighbourhood kept average (the cover setting describes the
  // sky you are under); streets: rolls lined up with the wind, ~2–3 boundary-layer depths apart, wandering
  let org = LY.cu3.x;
  if (org > 0.0) { o += 0.2*org*(cuMeso(xz, s) - cuMeso(vec2f(0.0), s)*exp(-dot(xz, xz)/1800.0)); }
  if (LY.cu3.y > 0.0) { let c = dot(xz, vec2f(-LY.wind.y, LY.wind.x));
    o += 0.1*LY.cu3.y*cos(6.2831853*c/LY.cu3.z + 2.2*gnoise2(xz/9.0, s + 50u)); }
  return vec2f(f + o, fl + o);
}
// the map of the field for level l (its texels span the level plus a margin for the lean and wander of the towers)
fn cuMapHW(l: u32) -> f32 { return 0.5*levelE(l) + LY.cu2.w; }
const CUMAP: f32 = 640.0;
fn cuMapF(xz: vec2f, l: u32) -> vec2f { let uv = xz/(2.0*cuMapHW(l)) + 0.5; return textureSampleLevel(cuMap, clampSamp, uv, i32(l), 0.0).rg; }
@compute @workgroup_size(8, 8, 1)
fn cuMapMain(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= CUMAP || f32(id.y) >= CUMAP) { return; }
  let hw = cuMapHW(GP.x); let xz = ((vec2f(id.xy) + 0.5)/CUMAP*2.0 - 1.0)*hw;
  textureStore(cuMapOut, vec2u(id.xy), GP.x, vec4f(cuField(xz), 0.0, 0.0));
}
// the cloud at p from the field: a flat base at the condensation level; above it the cloud reaches a height that grows with
// the field's excess over the threshold: steep-sided at its margin (the edge of an updraft), deeper toward strong cores, up to
// the top of the convection. Columns lean downwind with the shear and wander with height.
// Returns (signed distance km, excess, size: 0 a fragment off a weak thermal … 1 part of a big one)
fn cuFieldEval(p: vec3f, l: u32) -> vec3f {
  let base = LY.cu.y; let Hm = LY.cu.z; let y0 = p.y - base;
  if (y0 < -0.45 || y0 > Hm + 0.35) { return vec3f(-1.0, 0.0, 0.0); }
  let L = LY.cu2.x; let hy = clamp(y0/max(Hm, 0.3), 0.0, 1.0);
  var xz = p.xz - LY.wind.xy*LY.cu4.x*max(y0, 0.0);
  let wq = vec3f(xz.x/(1.37*L), p.y/(0.83*L), xz.y/(1.37*L));
  xz += (vec2f(nz(wq + vec3f(0.61, 0.23, 0.87)), nz(wq + vec3f(0.17, 0.71, 0.37))) - 0.5)*L*(0.12 + 0.3*hy);
  // (and a finer, faster-changing wander: the sides bulge and tuck in every couple of hundred metres of height, so no part of
  // a cloud is a straight vertical extrusion of its outline — seen from below, extruded columns read as streaks radiating
  // from overhead)
  let wq2 = RM1*vec3f(xz.x/(0.47*L), p.y/(0.21*L), xz.y/(0.47*L));
  xz += (vec2f(nz(wq2 + vec3f(0.33, 0.91, 0.12)), nz(wq2 + vec3f(0.78, 0.05, 0.64))) - 0.5)*L*(0.07 + 0.08*hy);
  // (the slope over ~a tenth of the field scale, not one texel: the finest octaves make the local slope steep and noisy, and
  // dividing by it put wide stretches of clear air just "outside" a surface, where the surface detail then grew a haze)
  let hw = cuMapHW(l); let h = max(2.0*hw/CUMAP, 0.1*L);
  let M = cuMapF(xz, l); let F = M.x;
  let g = vec2f(cuMapF(xz + vec2f(h, 0.0), l).x - cuMapF(xz - vec2f(h, 0.0), l).x, cuMapF(xz + vec2f(0.0, h), l).x - cuMapF(xz - vec2f(0.0, h), l).x)/(2.0*h);
  let thr = LY.thr.w; let sp = max(LY.cu3.w - thr, 1e-3); let e = (F - thr)/sp;
  // how big a thermal this cloud sits on: from the broad part of the field. Clouds made only by its fine octaves are
  // fragments (small, shallow, diluted); those on a broad strong thermal are deep, with walls
  let sf = smoothstep(-0.2, 0.25, (M.y - thr)/sp);
  // column depth: a steep wall at the margin (the edge of an updraft: a cumulus is about as deep at its edge as a little way
  // in, not a thin skirt), up to a share of the convection's depth, then domed higher toward the strong cores, steeply so with
  // development: fair-weather fields are many flat-based mounds of similar depth, deep convection a few towers in its cores
  let eS = 0.04; let k = mix(0.5, 1.7, LY.cu.w); let wall = mix(0.4, 0.12, LY.cu.w)*mix(0.3, 1.0, sf);
  // the base: level (the condensation level), undulating a few tens of metres, and curving up into the sides over the outer
  // part of the cloud (seen from below, a dark flat middle and rounded, lighter margins rather than a cut-off sheet)
  let bn = (nz(vec3f(p.x/0.43, 0.29, p.z/0.43)) - 0.5)*0.05 + (nz(vec3f(p.x/0.13, 0.67, p.z/0.13)) - 0.5)*0.02;
  let y = y0 - bn - 0.18*Hm*wall*(1.0 - smoothstep(0.0, 5.0*eS, max(e, 0.0)));
  // (outside the footprint: the horizontal distance to its edge, but above the height its wall reaches, at least a share of
  // the height above that: a plain extrusion of the footprint's edge put "near the surface" curtains of clear air up to the
  // top of the convection, which the surface detail then filled with a haze)
  if (e <= 0.0) { let Tw = Hm*wall; return vec3f(min(min((F - thr)/max(length(g), 0.02), -0.35*(y - Tw)), y), e, sf); }
  let em = min(e, 1.0); let edge = sqrt(min(e/eS, 1.0)); let pk = pow(max(em, 1e-4), k); let core = wall + (1.0 - wall)*pk;
  // (turrets and dips: the column's depth varies by ±20% over a few hundred metres, so the cloud above a base is not uniformly
  // thick and the base seen from below shades into darker and lighter patches)
  let tn = nz(RM2*vec3f(xz.x/(0.55*L), 0.37, xz.y/(0.55*L)));
  let T = Hm*edge*core*(0.8 + 0.4*tn);
  let dT = (0.8 + 0.4*tn)*Hm*(select(0.0, 0.5*edge/max(e, 1e-4), e < eS)*core + select(0.0, edge*(1.0 - wall)*k*pk/max(em, 1e-4), e < 1.0));
  let gT = min(dT/sp*length(g), 60.0);
  // (the distance to the local tangent plane; above the cloud, at least a share of the height above it, for the same reason)
  return vec3f(min(y, select((T - y)/sqrt(1.0 + gT*gT), min((T - y)/sqrt(1.0 + gT*gT), -0.35*(y - T)), y > T)), e, sf);
}

struct Hit { d: f32, sig: f32, v: f32, r: f32 }
fn evalAt(p: vec3f) -> Hit {
  var best = Hit(-1.0, 0.0, 0.0, 0.0);
  // the layers (alpha codes the style for the renderer: < 0.5 cumulus by size, 0.5–0.62 lumpy water layers by lump size,
  // 0.7 smooth water sheets, 0.9 ice)
  if (LY.sc.x > 0.0 && p.y > LY.sc.y - 0.35 && p.y < LY.sc.y + 1.4*LY.sc.z + 0.3) {
    // cells are domes: thickest in the middle, thinning to their edges (thin bright rims, dark cores seen from below), merging
    // into a continuous deck where the cover is high
    // (the cell pattern wanders a little with height, so the cells' sides billow instead of being straight extrusions)
    let hy = p.y*1.7; let wob = vec2f(n2(p.xz, 0.8, 0.31 + hy) - 0.5, n2(p.xz, 0.8, 0.77 + hy) - 0.5)*0.35;
    // (some cells grow thicker and wetter than others: a deck seen from below is a mosaic of darker and lighter cells)
    let vth = n2(p.xz, LY.sc2.x*2.3, 0.83);
    let f = scField(p.xz + wob); let th = LY.sc.z*(0.6 + 0.8*vth); let m = smoothstep(LY.thr.x - 0.03, LY.thr.x + 0.28, f.x);
    // (a deck under an inversion: the top nearly flat, ±20–50 m, a little lower at the thin cell rims; the base undulating
    // ±50–150 m and rising toward the gaps)
    // (cells are pillows: full depth in their middles, thinning to their rims mostly by the base rising, so the deck reads
    // as flattened cells packed side by side rather than as separate puffs)
    let top = LY.sc.y + th*(0.85 + 0.15*m) + th*0.08*(n2(p.xz, 1.7, 0.41) - 0.5);
    let bot = LY.sc.y + th*0.5*(1.0 - m) + 0.2*(n2(p.xz, 4.3, 0.19) - 0.5) + 0.06*(n2(p.xz, 1.1, 0.67) - 0.5);
    // (pillow cross-section: the sides bulge at mid-height and curve in to the top and the base)
    let hf = clamp((p.y - bot)/max(top - bot, 0.03), 0.0, 1.0);
    let dv = min(p.y - bot, top - p.y); let dh = (f.x - LY.thr.x)*LY.sc2.x*0.35 + th*(0.22*sin(3.14159*hf) - 0.1);
    let d = min(dv, dh);
    // lumpy (cumuliform) except for stratus: the size code drives the renderer's billows in proportion to the deck
    // (softer lumps than cumulus: the cells are only 1–2 layer depths across)
    let st = select(0.7, 0.5 + 0.12*clamp(LY.sc2.x*0.35/1.2, 0.02, 1.0), LY.sc.w > 0.15);
    if (d > best.d) { best = Hit(d, LY.sc2.z*(0.7 + 0.6*vth), clamp(LY.sc.y/8.0, 0.0, 1.0), st); }   // (the deck's nominal base: adiabatic profile above it; a constant, so
    // its 8-bit storage cannot draw contours)
  }
  if (LY.ac.x > 0.0 && p.y > LY.ac.y - 0.3 && p.y < LY.ac.y + LY.ac.z + 0.3) {
    let f = acField(p.xz); let th = LY.ac.z; let form = LY.ac.w;
    let top = LY.ac.y + th*mix(0.85 + 0.15*f.y, 0.35 + 0.65*f.y, form);
    let bot = LY.ac.y + th*mix(0.05*(1.0 - f.y), 0.35*(1.0 - f.y), form);
    let dv = min(p.y - bot, top - p.y); let dh = (f.x - LY.thr.y)*LY.ac2.x*0.3;
    let d = min(dv, dh);
    let st = select(0.7, 0.5 + 0.12*clamp(LY.ac2.x*0.45/1.2, 0.02, 1.0), form > 0.3);
    if (d > best.d) { best = Hit(d, LY.ac2.z, clamp(LY.ac.y/8.0, 0.0, 1.0), st); }
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
  if (LY.cu.x > 0.0) {
    let r = cuFieldEval(p, GP.x);
    if (r.x > best.d) {
      // stage and dilution: some parts of the field are dissolving (thinned by mixing: lower extinction, softer, more eaten
      // edges); and a thermal entrains surrounding air at a rate ∝ 1/its size, so small, shallow clouds and the thin margins
      // of big ones hold a smaller share of their adiabatic water (mixed fraction ~D/(D + 0.25 km); σ ∝ LWC^(2/3))
      // (varying in 3D, not by column: a column-wise pattern seen from below streaks out from overhead)
      let sx = p.xz/(3.7*LY.cu2.x);
      let st = smoothstep(0.32, 0.58, nz(RM2*vec3f(sx.x, p.y/(1.9*LY.cu2.x), sx.y)) + 0.25*r.y);
      // (by the size of the thermal the cloud sits on, not by closeness to its edge: the margins of a big cloud are its mixing
      // shell, handled by the renderer, and diluting them too made every outline a translucent smear)
      let De = mix(0.12, 1.2, r.z)*(1.0 + LY.cu.w);
      let Rcf = LY.cu4.y; let dil = pow(De/(De + 0.25), 0.6667)/pow(Rcf/(Rcf + 0.25), 0.6667);
      best = Hit(r.x, LY.cu2.z*mix(0.45, 1.0, st)*min(dil, 1.0), clamp(LY.cu.y/8.0, 0.0, 1.0), 0.5*clamp(Rcf/2.4, 0.0, 1.0));
    }
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
      // (the fraction of the voxel the renderer's near-field density would fill: the same fine-detail erosion, on average,
      // and the same soft ramp for ice, so the cloud field keeps its look across the change from distances to coverage)
      var inside = 0.0;
      if (h.r > 0.8) { inside = smoothstep(0.0, 0.12, h.d + 0.06); }
      else if (h.r < 0.63) {
        let Rc = clamp(select((h.r - 0.5)/0.12*1.2, h.r/0.5*2.4, h.r < 0.5), 0.05, 2.4);
        let Ae = 0.5*min(0.3*pow(Rc, 0.8), 0.45)*select(1.0, 0.45, h.r >= 0.5);
        inside = smoothstep(-0.03, 0.03, h.d - Ae + 0.03);
      } else { inside = smoothstep(0.0, 0.035, h.d); }
      cov += inside; sg = max(sg, h.sig); vv += h.v*inside; if (inside > 0.0) { st = max(st, h.r); }   // (the style is a code, not an amount: never scaled)
    }
    // (extinction code, base and style stored premultiplied by the coverage: filtering against empty neighbours then dilutes
    // the coverage only, and the renderer divides back; the codes themselves never get blended toward zero)
    if (cov > 0.0) { let c = cov/8.0; o = vec4f(c, encodeSig(sg)*c, vv/cov*c, st*c); }
  }
  textureStore(densOut, vec3u(id.x, id.y, l*NZ + k), o);
}

// the coverage field of one layer (GP.x: 0 low deck, 1 mid, 2 high, 3 cumulus) on a 256² grid over the central 64 km, for calibration
@compute @workgroup_size(8, 8, 1)
fn fieldMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) { return; }
  let xz = (vec2f(id.xy) + 0.5)/256.0*64.0 - 32.0;
  var c = 0.0;
  if (GP.x == 0u) { c = scField(xz).x; } else if (GP.x == 1u) { c = acField(xz).x; } else if (GP.x == 2u) { c = ciField(xz).x; } else { c = cuField(xz).x; }
  fieldOut[id.y*256u + id.x] = c;
}
