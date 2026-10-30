// ---------- metering: illuminance on the ground (for auto exposure) ----------
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transTex: texture_2d_array<f32>;
@group(0) @binding(2) var msTex: texture_2d_array<f32>;
@group(0) @binding(3) var linSamp: sampler;
@group(0) @binding(4) var<storage, read> amb: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> meterOut: array<f32>;

@compute @workgroup_size(1)
fn main() {
  let h = F.atm2.y; let r = Rg + h;
  var Ed = 0.0; var Esky = 0.0;
  for (var g = 0u; g < 6u; g++) {
    let a = ambE(g, h); Esky += dot(a, F.CMFy[g]);
    var dir = vec4f(0.0);
    if (F.sunDir.w > 0.5) { dir += F.SunE[g]*transmittance(g, r, F.sunDir.y)*max(F.sunDir.y, 0.0); }
    if (F.moonDir.w > 0.5) { dir += F.MoonE[g]*transmittance(g, r, F.moonDir.y)*max(F.moonDir.y, 0.0); }
    Ed += dot(dir, F.CMFy[g]);
  }
  meterOut[0] = Ed + Esky; meterOut[1] = Ed; meterOut[2] = Esky; meterOut[3] = 0.0;
}
