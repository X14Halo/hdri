// ---------- tileable 3D detail noise (128³): r billows (Perlin–Worley), g/b cellular fBm at 2× and 4×, a Perlin fBm ----------
@group(0) @binding(0) var noiseOut: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(9) var<uniform> F: Frame;   // (declared for common.wgsl; unused here)
fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (v - a)/(b - a)*(d - c); }
fn gnoiseP(p: vec3f, per: vec3f, seed: u32) -> f32 {
  let i = floor(p); let f = p - i; let u = f*f*f*(f*(f*6.0 - 15.0) + 10.0); var v: array<f32, 8>;
  for (var k = 0u; k < 8u; k++) { let o = vec3f(f32(k & 1u), f32((k >> 1u) & 1u), f32((k >> 2u) & 1u)); let c = (i + o) - per*floor((i + o)/per);
    let gr = hash3(vec3u(c) + vec3u(seed, seed*3u + 1u, seed*7u + 2u))*2.0 - 1.0; v[k] = dot(normalize(gr + 1e-5), f - o); }
  return mix(mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y), mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y), u.z);
}
fn worleyP(p: vec3f, per: vec3f, seed: u32) -> f32 {
  let i = floor(p); let f = p - i; var d = 1e9;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let o = vec3f(f32(x), f32(y), f32(z)); let c = (i + o) - per*floor((i + o)/per);
    let r = o + hash3(vec3u(c) + vec3u(seed*11u + 5u, seed*13u + 3u, seed*17u + 9u)) - f; d = min(d, dot(r, r)); } } }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
fn perlinFbm(p: vec3f, f0: f32, oct: u32, seed: u32) -> f32 { var s = 0.0; var a = 1.0; var n = 0.0; var f = f0;
  for (var i = 0u; i < oct; i++) { s += gnoiseP(p*f, vec3f(f), seed + i)*a; n += a; a *= 0.5; f *= 2.0; } return s/n; }
fn worleyFbm(p: vec3f, f: f32, seed: u32) -> f32 { return worleyP(p*f, vec3f(f), seed)*0.625 + worleyP(p*f*2.0, vec3f(f*2.0), seed + 1u)*0.25 + worleyP(p*f*4.0, vec3f(f*4.0), seed + 2u)*0.125; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let N = 128u; if (any(id >= vec3u(N))) { return; }
  let p = (vec3f(id) + 0.5)/f32(N);
  var pf = perlinFbm(p, 4.0, 5u, 3u)*0.5 + 0.5; pf = clamp(remap(pf, 0.15, 0.85, 0.0, 1.0), 0.0, 1.0);
  let w1 = worleyFbm(p, 4.0, 20u);
  let billow = clamp(remap(pf, 0.0, 1.0, w1, 1.0), 0.0, 1.0);
  textureStore(noiseOut, id, vec4f(billow, worleyFbm(p, 8.0, 30u), worleyFbm(p, 16.0, 40u), clamp(0.5 + 1.3*perlinFbm(p, 4.0, 4u, 75u), 0.0, 1.0)));
}
