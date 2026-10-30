// ---------- lookups into the atmosphere tables (needs transTex, msTex, linSamp, amb bound by the including shader) ----------
fn transmittance(g: u32, r0: f32, mu: f32) -> vec4f {
  let r = max(r0, Rg + 1e-4);
  let H = sqrt(Rt*Rt - Rg*Rg); let rho = sqrt(max((r - Rg)*(r + Rg), 0.0));
  let d = distToTop(r, mu); let dmin = Rt - r; let dmax = rho + H;
  let xmu = clamp((d - dmin)/max(dmax - dmin, 1e-6), 0.0, 1.0); let xr = rho/H;
  let uv = vec2f(0.5/256.0 + xmu*(255.0/256.0), 0.5/64.0 + xr*(63.0/64.0));
  let T = textureSampleLevel(transTex, linSamp, uv, i32(g), 0.0);
  // the planet's shadow edge, softened over the solar disc
  let muH = -rho/r; let eps = 0.00465*sqrt(max(1.0 - muH*muH, 0.0)) + 1e-5;
  return T*smoothstep(muH - eps, muH + eps, mu);
}
fn msLUT(g: u32, h: f32, mus: f32) -> vec4f {
  var uv = vec2f(clamp(mus*0.5 + 0.5, 0.0, 1.0), sqrt(clamp(h/100.0, 0.0, 1.0)));
  uv = (0.5 + uv*31.0)/32.0;
  return textureSampleLevel(msTex, linSamp, uv, i32(g), 0.0);
}
// clear-sky irradiance on a level surface facing up (sky only, no direct sun or moon) at height h km
fn ambE(g: u32, h: f32) -> vec4f {
  let x = sqrt(clamp(h/20.0, 0.0, 1.0))*31.0; let i0 = u32(floor(x)); let i1 = min(i0 + 1u, 31u); let f = x - f32(i0);
  return mix(amb[i0*6u + g], amb[i1*6u + g], f);
}
