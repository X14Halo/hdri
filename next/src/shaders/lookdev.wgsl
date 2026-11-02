// ---------- look-dev: the panorama's lighting projected onto spherical harmonics (order 2), for the grey ball and the chart ----------
// (diffuse lighting needs only the low orders: irradiance from 9 coefficients is within a few percent of the full integral)
struct Disp { canvas: vec2f, pano: vec2f, rect: vec4f, view: vec4f, ex: vec4f, ld: vec4f, sunD: vec4f, sunE: vec4f }
@group(0) @binding(0) var<uniform> D: Disp;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> accPrev: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> shOut: array<vec4f, 9>;
const PI: f32 = 3.14159265358979;
var<workgroup> part: array<array<vec3f, 9>, 64>;
fn texel(x: i32, y: i32) -> vec3f {
  let W = i32(D.pano.x); let H = i32(D.pano.y);
  let xx = ((x % W) + W) % W; let yy = clamp(y, 0, H - 1);
  var a = accum[u32(yy*W + xx)]; if (a.w <= 0.0) { a = accPrev[u32(yy*W + xx)]; } return a.xyz/max(a.w, 1e-6);
}
fn shBasis(d: vec3f) -> array<f32, 9> {
  return array<f32, 9>(0.282095, 0.488603*d.y, 0.488603*d.z, 0.488603*d.x, 1.092548*d.x*d.y, 1.092548*d.y*d.z, 0.315392*(3.0*d.z*d.z - 1.0), 1.092548*d.x*d.z, 0.546274*(d.x*d.x - d.y*d.y));
}
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3u) {
  var acc: array<vec3f, 9>;
  for (var i = 0u; i < 9u; i++) { acc[i] = vec3f(0.0); }
  let NU = 192u; let NV = 96u;
  for (var s = lid.x; s < NU*NV; s += 64u) {
    let u = (f32(s % NU) + 0.5)/f32(NU); let v = (f32(s / NU) + 0.5)/f32(NV);
    let az = (u - 0.5)*2.0*PI + D.ex.y; let el = (0.5 - v)*PI;
    let d = vec3f(cos(el)*sin(az), sin(el), cos(el)*cos(az));
    var L = texel(i32(u*D.pano.x), i32(v*D.pano.y));
    if (D.sunD.w > 0.5 && dot(d, D.sunD.xyz) > D.sunE.w) { L = vec3f(0.0); }   // (the disc: added as a light instead)
    let dw = (2.0*PI/f32(NU))*(PI/f32(NV))*cos(el);
    let b = shBasis(d);
    for (var i = 0u; i < 9u; i++) { acc[i] += L*b[i]*dw; }
  }
  for (var i = 0u; i < 9u; i++) { part[lid.x][i] = acc[i]; }
  workgroupBarrier();
  if (lid.x == 0u) {
    for (var i = 0u; i < 9u; i++) { var t = vec3f(0.0); for (var k = 0u; k < 64u; k++) { t += part[k][i]; } shOut[i] = vec4f(t, 0.0); }
  }
}
