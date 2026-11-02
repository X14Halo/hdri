// ---------- the cloud volume, sampled onto a regular grid for other software (Houdini, Blender) ----------
// Grid in the light-rig frame (Y up, +Z toward the panorama's centre, −X to its right; the camera's ground point at the
// origin), extinction in 1/km as half floats, two voxels per word, x fastest, then y (height), then z.
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> CU: Cloud;
@group(0) @binding(2) var densTex: texture_3d<f32>;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var linSamp: sampler;
@group(0) @binding(5) var wrapSamp: sampler;
@group(0) @binding(6) var<storage, read_write> vOut: array<u32>;
struct VxU { a: vec4f, b: vec4f }   // a: x half-width km, voxel km, first height km, first z slice; b: nx, ny, cos, sin (of the north offset)
@group(0) @binding(7) var<uniform> VX: VxU;
@group(0) @binding(8) var detailTex: texture_3d<f32>;

fn voxel(ix: u32, iy: u32, iz: u32) -> f32 {
  // (four points per voxel, rotated grid: a box filter over the voxel, so detail finer than it averages instead of aliasing)
  var s = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let o = vec3f(f32(k & 1u), f32((k >> 1u) & 1u), f32(((k + 1u) >> 1u) & 1u))*0.5 + 0.25;
    let X = (f32(ix) + o.x)*VX.a.y - VX.a.x; let Y = VX.a.z + (f32(iy) + o.y)*VX.a.y; let Z = (f32(iz) + o.z)*VX.a.y - VX.a.x;
    let q = vec3f(-X*VX.b.z + Z*VX.b.w, Y, Z*VX.b.z + X*VX.b.w);
    s += densFull(q);
  }
  return s*0.25;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let nx = u32(VX.b.x); let ny = u32(VX.b.y); let hx = nx/2u;
  if (id.x >= hx || id.y >= ny) { return; }
  let iz = u32(VX.a.w);
  if (CU.band.z < 0.5) { vOut[id.y*hx + id.x] = 0u; return; }
  let v = vec2f(voxel(2u*id.x, id.y, iz), voxel(2u*id.x + 1u, id.y, iz));
  vOut[id.y*hx + id.x] = pack2x16float(min(v, vec2f(65000.0)));
}
