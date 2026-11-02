// ---------- the shot's shadow matte: the clouds' shadow on the ground around the camera, seen from straight above ----------
// For lighting a CG set under this sky: R the sun's transmission through the clouds (the crisp shadow, marched through the
// full-detail cloud), G the sky's light reaching the ground through the clouds (the soft dimming under a cloud field),
// B the optical depth toward the sun (for regrading the shadow's density). Image top is north (+z), right is east (+x).
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> CU: Cloud;
@group(0) @binding(2) var densTex: texture_3d<f32>;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var linSamp: sampler;
@group(0) @binding(5) var wrapSamp: sampler;
@group(0) @binding(6) var<storage, read_write> smOut: array<vec4f>;
@group(0) @binding(7) var<uniform> SM: vec4f;   // x width km, y texels across, z first row of this pass, w first row held in the buffer
@group(0) @binding(8) var detailTex: texture_3d<f32>;
@group(0) @binding(9) var lightTex: texture_3d<f32>;

// optical depth from a point on the ground toward L through the full-detail cloud: empty air skipped by the distance to the
// nearest cloud surface, fine steps inside, coarse ones through the macro density once the budget is spent
fn tauFine(p0: vec3f, L: vec3f, jit: f32) -> f32 {
  let ly = max(L.y, 0.02);
  var t = max(CU.band.x - 0.35, 0.0)/ly; let t1 = (CU.band.y + 0.15)/ly;
  var tau = 0.0; var n = 0u;
  t += 0.02*jit;
  loop {
    if (t >= t1 || tau > 40.0 || n > 2000u) { break; }
    let q = volPos(p0 + L*t); n++;
    if (q.y > CU.band.y + 0.15 || max(abs(q.x), abs(q.z)) > 0.5*levelE(u32(CU.vol.z) - 1u)) { break; }
    var ds = 0.02;
    if (n > 1400u) { ds = 0.25; tau += densMacro(q)*ds; t += ds; continue; }
    let dh = distHint(q);
    if (dh > 1e8) { t += 0.1; continue; }
    if (dh < -0.06) { t += max(ds, 0.7*(-dh) - 0.03); continue; }
    tau += densFull(q)*ds; t += ds;
  }
  return tau;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let N = u32(SM.y); let row = u32(SM.z) + id.y;
  if (id.x >= N || row >= N) { return; }
  let xz = vec2f((f32(id.x) + 0.5)/f32(N) - 0.5, 0.5 - (f32(row) + 0.5)/f32(N))*SM.x;
  let p0 = C0 + normalize(vec3f(xz.x, Rg, xz.y))*Rg;
  var o = vec4f(1.0, 1.0, 0.0, 1.0);
  if (CU.band.z > 0.5) {
    let Ls = F.sunDir.xyz;
    var tau = 0.0;
    if (F.sunDir.w > 0.5 && Ls.y > 0.0) {
      // (four jittered marches, averaged as transmission: the shadow edge keeps its true softness, not step noise)
      var tr = 0.0;
      for (var k = 0u; k < 4u; k++) { let j = fract(hash3(vec3u(id.x, row, k)).x + f32(k)*0.25); let tk = tauFine(p0, Ls, j); tr += exp(-tk); tau += tk; }
      o.x = tr*0.25; o.z = tau*0.25;
    }
    // the sky through the clouds: over the hemisphere (cosine-weighted directions), each through the macro cloud, as the
    // diffuse transmission of a slab of that depth (skylight is scattered on down through a cloud, not just blocked)
    var vis = 0.0; let up = normalize(p0 - C0);
    let e1 = normalize(cross(up, vec3f(0.0, 0.0, 1.0))); let e2 = cross(up, e1);
    let jj = hash3(vec3u(id.x, row, 91u));
    for (var k = 0u; k < 12u; k++) {
      let u1 = (f32(k) + jj.x)/12.0; let ph = 6.2831853*fract(f32(k)*0.618034 + jj.y);
      let mu = sqrt(1.0 - u1); let sn = sqrt(u1);
      let dir = up*mu + (e1*cos(ph) + e2*sin(ph))*sn;
      let t0 = max(CU.band.x - 0.35, 0.0)/max(mu, 0.05); let t1 = min((CU.band.y + 0.15)/max(mu, 0.05), 60.0);
      var tau = 0.0; let ds = max((t1 - t0)/40.0, 0.02);
      for (var j = 0; j < 40; j++) { tau += densMacro(volPos(p0 + dir*(t0 + (f32(j) + 0.5)*ds)))*ds; }
      vis += 1.0/(1.0 + 0.105*tau*mu);
    }
    o.y = vis/12.0;
  }
  smOut[(row - u32(SM.w))*N + id.x] = o;
}
