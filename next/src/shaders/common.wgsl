// ---------- shared constants, frame uniforms and atmosphere functions ----------
// Spectrum: 24 bands (387.5 … 732.5 nm, 15 nm wide), stored as 6 vec4 groups.
const PI: f32 = 3.14159265358979;
const Rg: f32 = 6360.0;          // planet radius, km
const Rt: f32 = 6460.0;          // top of the atmosphere, km
const C0: vec3f = vec3f(0.0, -6360.0, 0.0);   // planet centre; the camera stands at (0, camH, 0)

struct Frame {
  BR: array<vec4f, 6>,    // Rayleigh scattering at sea level, 1/km
  BMs: array<vec4f, 6>,   // aerosol scattering at the ground
  BMa: array<vec4f, 6>,   // aerosol absorption
  BO: array<vec4f, 6>,    // ozone absorption at the layer peak
  Alb: array<vec4f, 6>,   // ground albedo
  SunE: array<vec4f, 6>,  // solar irradiance at the top of the atmosphere
  MoonE: array<vec4f, 6>, // lunar irradiance
  SunK: array<vec4f, 6>,  // solar disc radiance at its centre
  SunA: array<vec4f, 6>,  // limb darkening exponent
  MoonK: array<vec4f, 6>, // lunar disc radiance scale
  Air: array<vec4f, 6>,   // airglow radiance at the zenith
  CMFx: array<vec4f, 6>, CMFy: array<vec4f, 6>, CMFz: array<vec4f, 6>,
  Star: array<vec4f, 96>, // blackbody spectra (16 temperatures × 6 groups), 1 cd/m² per unit
  atm: vec4f,      // x HR (Rayleigh scale height), y HM (aerosol scale height), z fog extinction, w fog scale height
  atm2: vec4f,     // x aerosol asymmetry g, y camera height km, z azimuth offset rad, w sun angular radius rad
  fogPh: vec4f,    // fog droplet phase (gHG, gD, alpha, wD)
  sunDir: vec4f,   // xyz, w sun on
  moonDir: vec4f,  // xyz, w moon on
  moonLight: vec4f,// direction of sunlight at the Moon, w moon angular radius
  pole: vec4f,     // celestial pole, w sun disc squash (refraction)
  eqX: vec4f, eqY: vec4f, eqZ: vec4f,   // equatorial frame; w: night, stars on, faintest star magnitude
  galX: vec4f, galY: vec4f, galZ: vec4f,// galactic frame; w: Milky Way strength, its spectrum index, include sun disc
  opts: vec4f,     // x atmosphere steps, y sky only (no ground), z sun disc on, w unused
}

struct Pass { rowOff: u32, frame: u32, W: u32, H: u32 }

fn pcg3d(v0: vec3u) -> vec3u {
  var v = v0*1664525u + 1013904223u;
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
  return v;
}
fn hash3(v: vec3u) -> vec3f { return vec3f(pcg3d(v))*(1.0/4294967295.0); }

// ray/sphere around the planet centre from radius r, cos-zenith mu: (near, far), near < 0 … no hit gives (-1, -1)
fn sphereHit(r: f32, mu: f32, R: f32) -> vec2f {
  let b = -r*mu; let c = (r - R)*(r + R); let disc = b*b - c;
  if (disc < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(disc); let q = select(b - s, b + s, b >= 0.0);
  let t1 = q; let t2 = select(0.0, c/q, abs(q) > 1e-12);
  return vec2f(min(t1, t2), max(t1, t2));
}
fn distToTop(r: f32, mu: f32) -> f32 { return max(sphereHit(r, mu, Rt).y, 0.0); }
// ground hit distance along the ray, or -1
fn groundHit(r: f32, mu: f32) -> f32 { let h = sphereHit(r, mu, Rg); if (h.x > 0.0) { return h.x; } return -1.0; }

fn densR(h: f32) -> f32 { return exp(-h/F.atm.x); }
fn densM(h: f32) -> f32 { return exp(-h/F.atm.y); }
fn densO(h: f32) -> f32 { return max(0.0, 1.0 - abs(h - 25.0)/15.0); }
fn densF(h: f32) -> f32 { return F.atm.z*exp(-h/F.atm.w); }
fn extinctionAt(g: u32, h: f32) -> vec4f {
  return F.BR[g]*densR(h) + (F.BMs[g] + F.BMa[g])*densM(h) + F.BO[g]*densO(h) + vec4f(densF(h));
}
fn scatterAt(g: u32, h: f32) -> vec4f { return F.BR[g]*densR(h) + F.BMs[g]*densM(h) + vec4f(densF(h)); }

fn phaseR(c: f32) -> f32 { let gm = 0.01415; return 3.0/(16.0*PI*(1.0 + 2.0*gm))*((1.0 + 3.0*gm) + (1.0 - gm)*c*c); }
fn phaseCS(c0: f32, g: f32) -> f32 { let c = clamp(c0, -1.0, 1.0); let g2 = g*g;
  return 3.0/(8.0*PI)*(1.0 - g2)*(1.0 + c*c)/((2.0 + g2)*pow(max(1.0 + g2 - 2.0*g*c, 1e-6), 1.5)); }
fn phaseHG(c0: f32, g: f32) -> f32 { let c = clamp(c0, -1.0, 1.0); let g2 = g*g; return (1.0 - g2)/(4.0*PI*pow(max(1.0 + g2 - 2.0*g*c, 1e-7), 1.5)); }
fn phaseDraine(c0: f32, g: f32, a: f32) -> f32 { let c = clamp(c0, -1.0, 1.0); let g2 = g*g;
  return (1.0 - g2)*(1.0 + a*c*c)/(4.0*PI*(1.0 + a*(1.0 + 2.0*g2)/3.0)*pow(max(1.0 + g2 - 2.0*g*c, 1e-7), 1.5)); }
fn phaseFog(c: f32) -> f32 { return mix(phaseHG(c, F.fogPh.x), phaseDraine(c, F.fogPh.y, F.fogPh.z), F.fogPh.w); }

fn dirFromPixel(px: vec2f, W: f32, H: f32) -> vec3f {
  let az = (px.x/W - 0.5)*2.0*PI + F.atm2.z; let el = (0.5 - px.y/H)*PI;
  return normalize(vec3f(sin(az)*cos(el), sin(el), cos(az)*cos(el)));
}
fn toXYZ(L: array<vec4f, 6>) -> vec3f {
  var xyz = vec3f(0.0);
  for (var g = 0u; g < 6u; g++) { xyz += vec3f(dot(L[g], F.CMFx[g]), dot(L[g], F.CMFy[g]), dot(L[g], F.CMFz[g])); }
  return xyz;
}
