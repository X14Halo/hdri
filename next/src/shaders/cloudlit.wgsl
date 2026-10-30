// ---------- cloud light lookups (needs lightTex) ----------
fn rawLight(xz: vec2f, alt: f32, l: u32) -> vec4f { return textureSampleLevel(lightTex, linSamp, volUVW(xz, alt, l, CU.res.z, CU.res.w), 0.0); }
// optical depths at q: x toward the sun, y toward the moon, z straight up to the cloud tops, w straight down to the ground
fn lightAt(q: vec3f) -> vec4f {
  if (CU.band.z < 0.5 || q.y > CU.band.y + 0.1) { return vec4f(0.0); }
  let lb = levelOf(q.xz); let l = u32(lb.x);
  var s = rawLight(q.xz, max(q.y, 0.0), l); if (lb.y > 0.0) { s = mix(s, rawLight(q.xz, max(q.y, 0.0), l + 1u), lb.y); } return s;
}
