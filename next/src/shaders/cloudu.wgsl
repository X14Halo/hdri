// ---------- the cloud volume: lookups shared by the light pass and the renderer ----------
// Camera-centred levels (each twice as wide as the last) stacked along z in one 3D texture; all span altitude 0 … ZTOP km.
// Near levels (< SDF_LEVELS) store a signed distance to the cloud surface (km, ±0.5) so edges stay sharp below the voxel
// size and can be eroded by fine noise; far levels store coverage (the voxel-averaged fraction of cloud), which keeps small
// distant clouds' total extinction instead of losing them between voxels.
// texel: r distance/coverage, g core extinction (log), b height within the cloud (0 base … 1 top), a cloud style
struct Cloud {
  vol: vec4f,    // x E0 (km, width of level 0), y ZTOP, z number of levels, w levels holding distances
  res: vec4f,    // x voxels across, y voxels up, z light voxels across, w light voxels up
  band: vec4f,   // x lowest cloud base, y highest cloud top (km), z cloud on, w erosion strength
  cph: vec4f,    // cloud droplet phase (gHG, gD, alpha, wD)
  ms: vec4f,     // multiple scattering: x a, y b, z c, w ambient strength
}

fn levelE(l: u32) -> f32 { return CU.vol.x*exp2(f32(l)); }
// the finest level holding p (horizontal), and how far toward the next level's edge it is (0 … 1, for blending)
fn levelOf(xz: vec2f) -> vec2f {
  let m = max(abs(xz.x), abs(xz.y)); let nl = CU.vol.z;
  let l = clamp(ceil(log2(max(m/(0.42*CU.vol.x), 1e-6))), 0.0, nl - 1.0);
  let e = 0.42*levelE(u32(l)); let b = clamp((m - 0.85*e)/(0.15*e), 0.0, 1.0);
  return vec2f(l, select(b, 0.0, l >= nl - 1.0));
}
// altitude ↔ slice: the lower 6 km (all but the highest clouds) get three quarters of the slices, the rest the upper 10 km
const ZS: f32 = 6.0; const FZ: f32 = 0.75;
fn altToSlice(alt: f32, nz: f32) -> f32 { return select((FZ + (alt - ZS)/(CU.vol.y - ZS)*(1.0 - FZ))*nz, alt/ZS*FZ*nz, alt < ZS); }
fn sliceToAlt(z: f32, nz: f32) -> f32 { let f = z/nz; return select(ZS + (f - FZ)/(1.0 - FZ)*(CU.vol.y - ZS), f/FZ*ZS, f < FZ); }
fn volUVW(xz: vec2f, alt: f32, l: u32, nxz: f32, nz: f32) -> vec3f {
  let E = levelE(l); let u = xz/E + 0.5;
  let z = clamp(altToSlice(alt, nz), 0.5, nz - 0.5);
  return vec3f(u.x, u.y, (f32(l)*nz + z)/(nz*CU.vol.z));
}
