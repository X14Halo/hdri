// ---------- metering: illuminance on the ground at the camera, under the clouds (for auto exposure) ----------
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transTex: texture_2d_array<f32>;
@group(0) @binding(2) var msTex: texture_2d_array<f32>;
@group(0) @binding(3) var linSamp: sampler;
@group(0) @binding(4) var<storage, read> amb: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> meterOut: array<f32>;
@group(0) @binding(6) var<uniform> CU: Cloud;
@group(0) @binding(7) var lightTex: texture_3d<f32>;

@compute @workgroup_size(1)
fn main() {
  let h = F.atm2.y; let r = Rg + h;
  // the clouds over the camera: direct beam through them, and what they pass on diffusely (two-stream, as on the ground)
  var lg = vec4f(0.0);
  if (CU.band.z > 0.5) {
    // (averaged over a few hundred metres: the meter should not jump as a small cloud's shadow passes)
    for (var i = 0; i < 9; i++) { let o = vec2f(f32(i % 3) - 1.0, f32(i/3) - 1.0)*0.25; lg += lightAt(vec3f(o.x, 0.0, o.y)); }
    lg /= 9.0;
  }
  let shS = exp(-lg.x); let shM = exp(-lg.y); let dif = 1.0/(1.0 + 0.105*lg.z);
  var Ed = 0.0; var Esky = 0.0;
  for (var g = 0u; g < 6u; g++) {
    let a = ambE(g, h)*dif; Esky += dot(a, F.CMFy[g]);
    var dir = vec4f(0.0);
    if (F.sunDir.w > 0.5) { let m0 = max(F.sunDir.y, 0.0); var tt = shS;
      if (lg.z > 0.0 && m0 > 0.0) { let mm = min(m0, 1.0); tt = max((0.5 + 0.75*mm + (0.5 - 0.75*mm)*shS)/(1.0 + 0.105*lg.z), shS); }
      dir += F.SunE[g]*transmittance(g, r, F.sunDir.y)*m0*tt; }
    if (F.moonDir.w > 0.5) { dir += F.MoonE[g]*transmittance(g, r, F.moonDir.y)*max(F.moonDir.y, 0.0)*shM; }
    Ed += dot(dir, F.CMFy[g]);
  }
  meterOut[0] = Ed + Esky; meterOut[1] = Ed; meterOut[2] = Esky; meterOut[3] = 0.0;
}
