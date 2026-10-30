// ---------- the light volume: optical depth from each point to the sun, the moon, the sky above and the ground below ----------
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> CU: Cloud;
@group(0) @binding(2) var densTex: texture_3d<f32>;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var linSamp: sampler;
@group(0) @binding(5) var wrapSamp: sampler;
@group(0) @binding(6) var lightOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var<uniform> GP: vec4u;   // x level

// optical depth along a straight line from p (world) toward L, through the cloud band (macro density, no erosion)
fn tauToward(p0: vec3f, L: vec3f) -> f32 {
  var tau = 0.0; var t = 0.0; let top = CU.band.y + 0.1;
  for (var i = 0; i < 96; i++) {
    let p = p0 + L*t; let q = volPos(p);
    if (q.y > top || q.y < -0.05 || max(abs(q.x), abs(q.z)) > 0.5*levelE(u32(CU.vol.z) - 1u)) { break; }
    let lb = levelOf(q.xz); let vs = levelE(u32(lb.x))/CU.res.x;   // step about one voxel of the level it is in
    let ds = clamp(vs*0.9, 0.04, 2.0)*select(1.0, 1.0 + 0.02*f32(i), i > 48);
    tau += densMacro(volPos(p0 + L*(t + 0.5*ds)))*ds; t += ds;
  }
  return tau;
}
fn tauVertical(q0: vec3f, dir: f32) -> f32 {
  var tau = 0.0; let dz = 0.06;
  var y = q0.y;
  let y1 = select(0.0, CU.band.y + 0.1, dir > 0.0);
  let n = min(i32(ceil(abs(y1 - y)/dz)), 160);
  let ds = abs(y1 - y)/max(f32(n), 1.0);
  for (var i = 0; i < n; i++) { let yy = y + dir*(f32(i) + 0.5)*ds; tau += densMacro(vec3f(q0.x, yy, q0.z))*ds; }
  return tau;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let NX = u32(CU.res.z); let NZ = u32(CU.res.w); let l = GP.x;
  if (id.x >= NX || id.y >= NX || id.z >= NZ) { return; }
  let E = levelE(l);
  let q = vec3f((f32(id.x) + 0.5)/f32(NX)*E - 0.5*E, sliceToAlt(f32(id.z) + 0.5, f32(NZ)), (f32(id.y) + 0.5)/f32(NX)*E - 0.5*E);
  var o = vec4f(0.0);
  if (q.y < CU.band.y + 0.1) {
    // world position of the voxel: x/z on the tangent plane, altitude along the local vertical
    let up = normalize(vec3f(q.x, Rg, q.z)); let p = C0 + up*(Rg + q.y);
    if (F.sunDir.w > 0.5 && F.sunDir.y > -0.2) { o.x = tauToward(p, F.sunDir.xyz); }
    if (F.moonDir.w > 0.5) { o.y = tauToward(p, F.moonDir.xyz); }
    o.z = tauVertical(q, 1.0);
    if (q.y > CU.band.x - 0.3) { o.w = tauVertical(q, -1.0); }
  }
  textureStore(lightOut, vec3u(id.x, id.y, l*NZ + id.z), o);
}
