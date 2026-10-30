// ---------- atmosphere tables: transmittance, multiple scattering (Hillaire 2020), sky irradiance vs height ----------
// three entry points; each pipeline binds only what its entry point uses
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var transTex: texture_2d_array<f32>;
@group(0) @binding(3) var msTex: texture_2d_array<f32>;
@group(0) @binding(4) var linSamp: sampler;
@group(0) @binding(5) var msOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var<storage, read_write> ambOut: array<vec4f>;
@group(0) @binding(7) var<storage, read> amb: array<vec4f>;   // (unused here; atmo.wgsl names it)

@compute @workgroup_size(8, 8, 1)
fn transLUT(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 64u) { return; }
  let g = id.z;
  let xmu = f32(id.x)/255.0; let xr = f32(id.y)/63.0;
  let H = sqrt(Rt*Rt - Rg*Rg); let rho = H*xr; let r = sqrt(rho*rho + Rg*Rg);
  let dmin = Rt - r; let dmax = rho + H; let d = dmin + xmu*(dmax - dmin);
  let mu = select(clamp((H*H - rho*rho - d*d)/(2.0*r*d), -1.0, 1.0), 1.0, d <= 0.0);
  var tau = vec4f(0.0); let N = 80; let dt = d/f32(N);
  for (var i = 0; i < N; i++) {
    let t = (f32(i) + 0.5)*dt; let h = sqrt(max(r*r + t*t + 2.0*r*mu*t, 0.0)) - Rg;
    tau += extinctionAt(g, max(h, 0.0))*dt;
  }
  textureStore(transOut, vec2u(id.xy), g, exp(-tau));
}

@compute @workgroup_size(8, 8, 1)
fn msLUTpass(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 32u || id.y >= 32u) { return; }
  let g = id.z;
  let uv = vec2f(id.xy)/31.0; let mus = uv.x*2.0 - 1.0; let h = max(uv.y*uv.y*100.0, 0.005); let r = Rg + h;
  let sd = vec3f(sqrt(max(1.0 - mus*mus, 0.0)), mus, 0.0); let pos = vec3f(0.0, r, 0.0);
  var L2 = vec4f(0.0); var fms = vec4f(0.0);
  for (var i = 0; i < 8; i++) { for (var j = 0; j < 8; j++) {
    let u = (f32(i) + 0.5)/8.0; let v = (f32(j) + 0.5)/8.0; let ct = 1.0 - 2.0*v; let st = sqrt(max(1.0 - ct*ct, 0.0)); let ph = 2.0*PI*u;
    let rd = vec3f(st*cos(ph), ct, st*sin(ph)); let mu = ct;
    let gN = groundHit(r, mu); let hitG = gN > 0.0;
    let tmax = select(distToTop(r, mu), gN, hitG);
    let N = 24; let dt = tmax/f32(N); var T = vec4f(1.0);
    for (var k = 0; k < N; k++) {
      let t = (f32(k) + 0.5)*dt; let p = pos + rd*t; let rr = length(p); let hh = rr - Rg; let up = p/rr;
      let sT = extinctionAt(g, hh); let sS = scatterAt(g, hh); let Ts = transmittance(g, rr, dot(up, sd));
      let att = exp(-sT*dt); let S = sS*Ts*(0.25/PI);
      L2 += T*(S - S*att)/max(sT, vec4f(1e-9)); fms += T*(sS - sS*att)/max(sT, vec4f(1e-9)); T *= att;
    }
    if (hitG) { let p = pos + rd*gN; let up = normalize(p); let m = dot(up, sd); L2 += T*transmittance(g, Rg, m)*max(m, 0.0)*F.Alb[g]/PI; }
  } }
  L2 /= 64.0; fms /= 64.0;
  textureStore(msOut, vec2u(id.xy), g, L2/max(vec4f(1.0) - fms, vec4f(1e-3)));
}

// sky irradiance on a level surface at 32 heights (0 … 20 km, square-root spaced), cosine-weighted directions
@compute @workgroup_size(32, 1, 1)
fn ambPass(@builtin(global_invocation_id) id: vec3u) {
  let hi = id.x; let g = id.y;
  let x = f32(hi)/31.0; let h = x*x*20.0; let r = Rg + h; let pos = vec3f(0.0, r, 0.0);
  let Ls = F.sunDir.xyz; let Lm = F.moonDir.xyz;
  var E = vec4f(0.0);
  for (var i = 0; i < 8; i++) { for (var j = 0; j < 16; j++) {
    let u1 = (f32(i) + 0.5)/8.0; let u2 = (f32(j) + 0.5)/16.0; let rr = sqrt(u1); let ph = 2.0*PI*u2;
    let rd = vec3f(rr*cos(ph), sqrt(1.0 - u1), rr*sin(ph)); let tmax = distToTop(r, rd.y);
    let cS = dot(rd, Ls); let cM = dot(rd, Lm);
    let pRs = phaseR(cS); let pMs = phaseCS(cS, F.atm2.x); let pFs = phaseFog(cS);
    let pRm = phaseR(cM); let pMm = phaseCS(cM, F.atm2.x); let pFm = phaseFog(cM);
    let N = 16; var T = vec4f(1.0); var L = vec4f(0.0);
    for (var k = 0; k < N; k++) {
      let f0 = f32(k)/f32(N); let f1 = f32(k + 1)/f32(N); let ta = tmax*f0*f0; let tb = tmax*f1*f1; let dt = tb - ta;
      let p = pos + rd*(ta + 0.5*dt); let rp = length(p); let hp = rp - Rg; let up = p/rp;
      let dF = densF(hp); let sR = F.BR[g]*densR(hp); let sM = F.BMs[g]*densM(hp); let ext = extinctionAt(g, hp); let sT = sR + sM + vec4f(dF);
      let muS = dot(up, Ls); let muM = dot(up, Lm); var S = vec4f(0.0);
      if (F.sunDir.w > 0.5) { S += F.SunE[g]*((sR*pRs + sM*pMs + dF*pFs)*transmittance(g, rp, muS) + sT*msLUT(g, hp, muS)); }
      if (F.moonDir.w > 0.5) { S += F.MoonE[g]*((sR*pRm + sM*pMm + dF*pFm)*transmittance(g, rp, muM) + sT*msLUT(g, hp, muM)); }
      let att = exp(-ext*dt); L += T*(S - S*att)/max(ext, vec4f(1e-9)); T *= att;
    }
    E += L;
  } }
  ambOut[hi*6u + g] = E*(PI/128.0);
}
