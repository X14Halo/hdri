// ---------- display: the accumulated panorama, exposed and tone mapped (AgX), as a panorama or a pinhole camera ----------
struct Disp {
  canvas: vec2f, pano: vec2f,      // canvas size px; panorama size px
  rect: vec4f,                     // panorama placement in the canvas (x, y, w, h)
  view: vec4f,                     // x mode (0 panorama, 1 look around, 2 luminance), y yaw, z pitch, w vertical fov
  ex: vec4f,                       // x exposure (multiplies cd/m²), y azimuth offset
}
@group(0) @binding(0) var<uniform> D: Disp;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;

struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO; o.pos = vec4f(p*2.0 - 1.0, 0.0, 1.0); return o;
}
fn agxContrast(x: vec3f) -> vec3f { let x2 = x*x; let x4 = x2*x2; return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
fn agx(v0: vec3f) -> vec3f {
  let M = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let Mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let mn = -12.47393; let mx = 4.026069;
  var v = M*v0; v = clamp(log2(max(v, vec3f(1e-10))), vec3f(mn), vec3f(mx)); v = (v - mn)/(mx - mn);
  return clamp(Mi*agxContrast(v), vec3f(0.0), vec3f(1.0));
}
fn turbo(x: f32) -> vec3f {
  let kR = vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234); let kR2 = vec2f(-152.94239396, 59.28637943);
  let kG = vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333); let kG2 = vec2f(4.27729857, 2.82956604);
  let kB = vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771); let kB2 = vec2f(-89.90310912, 27.34824973);
  let v4 = vec4f(1.0, x, x*x, x*x*x); let v2 = v4.zw*v4.z;
  return clamp(vec3f(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), vec3f(0.0), vec3f(1.0));
}
fn texel(x: i32, y: i32) -> vec3f {
  let W = i32(D.pano.x); let H = i32(D.pano.y);
  let xx = ((x % W) + W) % W; let yy = clamp(y, 0, H - 1);
  let a = accum[u32(yy*W + xx)]; return a.xyz/max(a.w, 1e-6);
}
fn samplePano(uv: vec2f) -> vec3f {   // bilinear, wrapping in azimuth
  let p = uv*D.pano - 0.5; let i = floor(p); let f = p - i; let x = i32(i.x); let y = i32(i.y);
  return mix(mix(texel(x, y), texel(x + 1, y), f.x), mix(texel(x, y + 1), texel(x + 1, y + 1), f.x), f.y);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let fc = v.pos.xy; var xyz: vec3f;
  let mode = i32(D.view.x);
  if (mode == 1) {
    // look around: pinhole camera (yaw from north, clockwise; pitch up)
    let ndc = vec2f(fc.x/D.canvas.x*2.0 - 1.0, 1.0 - fc.y/D.canvas.y*2.0); let tf = tan(D.view.w*0.5);
    let dc = normalize(vec3f(ndc.x*tf*D.canvas.x/D.canvas.y, ndc.y*tf, 1.0));
    let cy = cos(D.view.y); let sy = sin(D.view.y); let cp = cos(D.view.z); let sp = sin(D.view.z);
    let fwd = vec3f(sy*cp, sp, cy*cp); let right = normalize(vec3f(cy, 0.0, -sy)); let up = cross(fwd, right);
    let d = normalize(fwd*dc.z + right*dc.x + up*dc.y);
    let az = atan2(d.x, d.z) - D.ex.y; let el = asin(clamp(d.y, -1.0, 1.0));
    xyz = samplePano(vec2f(fract(az/(2.0*PI) + 0.5), 0.5 - el/PI));
  } else {
    let q = (fc - D.rect.xy)/D.rect.zw;
    if (any(q < vec2f(0.0)) || any(q > vec2f(1.0))) { return vec4f(0.027, 0.035, 0.047, 1.0); }
    xyz = texel(i32(q.x*D.pano.x), i32(q.y*D.pano.y));
  }
  if (mode == 2) { let l = (log(max(xyz.y, 1e-7))/log(10.0) + 4.0)/13.0; return vec4f(turbo(clamp(l, 0.0, 1.0)), 1.0); }
  let X2R = mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  let lin = max(X2R*xyz, vec3f(0.0))*D.ex.x;
  return vec4f(agx(lin), 1.0);
}
const PI: f32 = 3.14159265358979;
