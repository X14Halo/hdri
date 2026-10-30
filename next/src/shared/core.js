// Spectral Sky Next — shared core: constants, spectral tables, vectors, ephemerides.
// Loaded by both the UI thread and the render worker.
// Units: lengths km, extinction 1/km, spectral irradiance W·m⁻²·nm⁻¹, radiance W·m⁻²·sr⁻¹·nm⁻¹; output CIE XYZ, Y in cd/m².
'use strict';
const NL = 24, NG = 6, DL = 15;
const LAM = Array.from({length:NL}, (_,i) => 387.5 + DL*i);
const f32 = a => new Float32Array(a);
const clamp = (x,a,b) => Math.min(b, Math.max(a, x));
const D2R = Math.PI/180, R2D = 180/Math.PI;

/* ---------- spectral tables ---------- */
function lerpT(t, x){ if (x<=t[0][0]) return t[0][1]; const n=t.length; if (x>=t[n-1][0]) return t[n-1][1];
  for (let i=1;i<n;i++) if (x<=t[i][0]){ const a=t[i-1], b=t[i]; return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]); } }
const binAvg = (fn,l) => { let s=0; for (let k=-7;k<=7;k++) s+=fn(l+k); return s/15; };
// Extraterrestrial solar spectral irradiance at 1 AU (W m^-2 nm^-1), smoothed ASTM E-490
const SOLAR=[[380,1.10],[390,1.09],[400,1.69],[410,1.70],[420,1.75],[430,1.60],[440,1.83],[450,2.05],[460,2.07],[470,2.03],[480,2.07],[490,1.95],[500,1.95],[510,1.89],[520,1.85],[530,1.92],[540,1.86],[550,1.88],[560,1.83],[570,1.83],[580,1.84],[590,1.77],[600,1.75],[610,1.71],[620,1.66],[630,1.62],[640,1.60],[650,1.53],[660,1.52],[670,1.51],[680,1.47],[690,1.43],[700,1.41],[710,1.38],[720,1.35],[730,1.32],[740,1.28],[750,1.26],[760,1.23]];
// O3 absorption cross-section, 293 K (cm^2) — Chappuis band
const O3XS=[[380,0.2e-23],[400,1.0e-23],[425,6.0e-23],[450,2.7e-22],[475,6.5e-22],[500,1.4e-21],[525,2.5e-21],[550,3.3e-21],[575,4.6e-21],[600,5.1e-21],[625,4.2e-21],[650,2.6e-21],[675,1.4e-21],[700,0.8e-21],[725,0.55e-21],[750,0.4e-21],[780,0.3e-21]];
// CIE 1931 2° colour matching functions (Wyman–Sloan–Shirley multi-lobe fit)
const gl_ = (x,m,s1,s2) => { const t=(x-m)/(x<m?s1:s2); return Math.exp(-0.5*t*t); };
const xbar = l => 1.056*gl_(l,599.8,37.9,31.0)+0.362*gl_(l,442.0,16.0,26.7)-0.065*gl_(l,501.1,20.4,26.2);
const ybar = l => 0.821*gl_(l,568.8,46.9,40.5)+0.286*gl_(l,530.9,16.3,31.1);
const zbar = l => 1.217*gl_(l,437.0,11.8,36.0)+0.681*gl_(l,459.0,26.0,13.8);
const CMFX = LAM.map(l=>binAvg(xbar,l)*DL*683), CMFY = LAM.map(l=>binAvg(ybar,l)*DL*683), CMFZ = LAM.map(l=>binAvg(zbar,l)*DL*683);
const SOLAR_BIN = LAM.map(l=>binAvg(x=>lerpT(SOLAR,x),l));
// Spectral ground reflectance (directional-hemispherical, treated as Lambertian)
const SURFACES = {
  grey:{name:'Neutral (set albedo)', t:null},
  grass:{name:'Green grass', t:[[400,.04],[450,.05],[500,.07],[550,.12],[600,.08],[650,.06],[680,.05],[700,.15],[720,.35],[740,.45]]},
  drygrass:{name:'Dry grass / savanna', t:[[400,.07],[500,.10],[550,.14],[600,.20],[650,.24],[700,.28],[740,.32]]},
  sand:{name:'Desert sand', t:[[400,.15],[450,.20],[500,.27],[550,.33],[600,.39],[650,.43],[700,.46],[740,.48]]},
  soil:{name:'Bare soil', t:[[400,.06],[500,.09],[600,.13],[700,.17],[740,.19]]},
  snow:{name:'Fresh snow', t:[[400,.96],[550,.95],[700,.92],[740,.90]]},
  asphalt:{name:'Asphalt', t:[[400,.05],[740,.09]]},
  concrete:{name:'Concrete', t:[[400,.22],[550,.30],[740,.35]]},
  water:{name:'Water (diffuse approx.)', t:[[400,.08],[550,.05],[740,.03]]},
};
const AEROSOLS = {
  continental:{name:'Continental', alpha:1.3, ssa:()=>0.93, g:0.70, hyg:0.35},
  maritime:{name:'Maritime', alpha:0.45, ssa:()=>0.985, g:0.76, hyg:0.45},
  urban:{name:'Urban / industrial', alpha:1.45, ssa:()=>0.82, g:0.66, hyg:0.30},
  desert:{name:'Desert dust', alpha:0.25, ssa:l=>0.80+0.17*clamp((l-400)/300,0,1), g:0.73, hyg:0.05},
  smoke:{name:'Wildfire smoke', alpha:1.85, ssa:l=>0.86+0.06*clamp((l-400)/300,0,1), g:0.62, hyg:0.15},
  clean:{name:'Clean / polar', alpha:1.4, ssa:()=>0.97, g:0.70, hyg:0.30},
};
const ICE_N=[[400,1.3185],[450,1.3150],[500,1.3126],[550,1.3110],[600,1.3096],[650,1.3086],[700,1.3075],[750,1.3065]];
// Rayleigh: Peck–Reeder refractivity, Bates/Bodhaine King factor, Ns at 15°C/1013.25 hPa
function rayleighKm(lnm){ const l=lnm*1e-3, s2=1/(l*l);
  const n1=(8060.51+2480990/(132.274-s2)+17455.7/(39.32957-s2))*1e-8, n=1+n1;
  const FN2=1.034+3.17e-4*s2, FO2=1.096+1.385e-3*s2+1.448e-4*s2*s2, co2=0.042;
  const F=(78.084*FN2+20.946*FO2+0.934+co2*1.15)/(78.084+20.946+0.934+co2);
  const Ns=2.546899e25, lm=lnm*1e-9, n2=n*n;
  const sigma=24*Math.PI**3*(n2-1)**2/(lm**4*Ns*Ns*(n2+2)**2)*F;
  return sigma*Ns*1000; }
const BETA_R = LAM.map(rayleighKm);
function planck(lnm,T){ const l=lnm*1e-9; return 1/(l**5*(Math.exp(1.4387769e-2/(l*T))-1)); }
const STAR_T = Array.from({length:16},(_,k)=>2500*Math.pow(10,k/15));
const STAR_SPEC = (()=>{ const a=new Float32Array(16*NG*4); for (let k=0;k<16;k++){ const b=LAM.map(l=>planck(l,STAR_T[k])); let Y=0; for(let i=0;i<NL;i++) Y+=b[i]*CMFY[i]; for (let i=0;i<NL;i++){ const g=i>>2, c=i&3; a[(k*NG+g)*4+c]=b[i]/Y; } } return a; })();   // [temperature k][band group g] vec4, 1 cd/m² per unit
// Jendersie & d'Eon (2023) approximate Mie phase for water droplets of diameter d (µm)
function dropletPhase(d){ d=clamp(d,5,50); return { gHG:Math.exp(-0.0990567/(d-1.67154)), gD:Math.exp(-2.20679/(d+3.91029)-0.428934), a:Math.exp(3.62489-8.29288/(d+5.52825)), wD:Math.exp(-0.599085/(d-0.641583)-0.665888) }; }
// Moon albedo map. Maria as overlapping discs at their selenographic positions [lon°E, lat°N, radius°, darkness]
const MARIA=[[-15.6,32.8,17,.46],[-27,40,8,.44],[17.5,28.0,10.5,.42],[31.4,8.5,12.5,.48],[24,4,7,.46],[59.1,17.0,8.5,.47],[51.3,-7.8,11,.44],[56,-2,6,.44],
 [35.5,-15.2,5.5,.45],[-16.6,-21.3,11,.40],[-23,-10,6,.40],[-38.6,-24.4,6.5,.44],[-30.9,7.5,8,.38],[3.6,13.3,4,.42],[1.7,2.4,3,.38],[-8.8,10.9,3.5,.40],
 [-30,56,5,.38],[-15,57,5,.38],[0,56,5,.38],[15,57,5,.38],[30,58,5,.36],[-45,55,4,.36],
 [-57,18,13,.44],[-50,5,10,.44],[-62,32,9,.42],[-45,-3,8,.42],[-68,8,9,.42],[-40,22,8,.44],[-72,22,7,.40],[-55,-10,6,.38],
 [-31.5,44.1,4,.40],[86,13,4,.35],[87,1,4,.35],[-68.6,-5.2,1.8,.50],[-9.3,51.6,1.6,.50]];
// bright young craters [lon, lat, radius°, brightness] and their ray systems [lon, lat, length°, strength]
const CRATERS=[[-11.2,-43.3,1.4,.75],[-20.1,9.6,1.6,.55],[-38.0,8.1,0.9,.5],[-47.4,23.7,0.8,.95],[46.8,16.1,0.7,.6],[16.0,16.3,0.5,.5],[-35,-26,0.6,.35],[59,-40,0.9,.4]];
const RAYS=[[-11.2,-43.3,40,.30],[-20.1,9.6,15,.22],[-38.0,8.1,9,.2],[-47.4,23.7,5,.2],[46.8,16.1,10,.18]];
const glv4 = a => `vec4[${a.length}](${a.map(m=>`vec4(${m.map(v=>v.toFixed(2)).join(',')})`).join(',')})`;
function sphDir(lon,lat){ lon*=D2R; lat*=D2R; return [Math.cos(lat)*Math.sin(lon), Math.sin(lat), Math.cos(lat)*Math.cos(lon)]; }
const MARIA_C = MARIA.map(m=>sphDir(m[0],m[1]));
const smooth = (a,b,x)=>{ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const CRATERS_C = CRATERS.map(m=>sphDir(m[0],m[1]));
function moonAlbedoJS(n){ let dark=0, br=0; for (let i=0;i<CRATERS.length;i++){ const c=CRATERS_C[i]; const ang=Math.acos(clamp(n[0]*c[0]+n[1]*c[1]+n[2]*c[2],-1,1))*R2D; br += CRATERS[i][3]*(1-smooth(CRATERS[i][2]*0.6, CRATERS[i][2]*1.3, ang)); }
  for (let i=0;i<MARIA.length;i++){ const c=MARIA_C[i]; const ang=Math.acos(clamp(n[0]*c[0]+n[1]*c[1]+n[2]*c[2],-1,1))*R2D; dark=Math.max(dark, MARIA[i][3]*(1-smooth(MARIA[i][2]*0.7,MARIA[i][2]*1.15,ang))); } return 1-dark+br; }
/* ---------- vectors ---------- */
const V = { add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]], sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]], mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s], dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]], len:a=>Math.hypot(a[0],a[1],a[2]), norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l];} };
// world frame: x = east, y = up, z = north; azimuth clockwise from north
const dirAzEl = (az,el) => [Math.sin(az*D2R)*Math.cos(el*D2R), Math.sin(el*D2R), Math.cos(az*D2R)*Math.cos(el*D2R)];
const azElOf = d => [((Math.atan2(d[0],d[2])*R2D)+360)%360, Math.asin(clamp(d[1],-1,1))*R2D];
/* ---------- ephemerides (NOAA solar, Meeus ch.47 lunar) ---------- */
function refract(h){ if (h < -1.5) return h; return h + 1.02/Math.tan((h+10.3/(h+5.11))*D2R)/60; }
function horiz(raDeg, decDeg, lstDeg, latDeg){ const H=(lstDeg-raDeg)*D2R, d=decDeg*D2R, p=latDeg*D2R;
  const el=Math.asin(Math.sin(p)*Math.sin(d)+Math.cos(p)*Math.cos(d)*Math.cos(H));
  const az=Math.atan2(-Math.cos(d)*Math.sin(H), Math.sin(d)*Math.cos(p)-Math.cos(d)*Math.sin(p)*Math.cos(H));
  return [((az*R2D)+360)%360, el*R2D]; }
function ephemeris(utcMs, lat, lon){
  const jd = utcMs/86400000 + 2440587.5, T=(jd-2451545)/36525;
  const L0=(280.46646+T*(36000.76983+T*0.0003032))%360, M=357.52911+T*(35999.05029-0.0001537*T), e=0.016708634-T*(0.000042037+0.0000001267*T);
  const Mr=M*D2R, C=Math.sin(Mr)*(1.914602-T*(0.004817+0.000014*T))+Math.sin(2*Mr)*(0.019993-0.000101*T)+Math.sin(3*Mr)*0.000289;
  const om=(125.04-1934.136*T)*D2R, lam=(L0+C-0.00569-0.00478*Math.sin(om))*D2R;
  const eps0=23+(26+(21.448-T*(46.815+T*(0.00059-T*0.001813)))/60)/60, eps=(eps0+0.00256*Math.cos(om))*D2R;
  const ra=Math.atan2(Math.cos(eps)*Math.sin(lam),Math.cos(lam))*R2D, dec=Math.asin(Math.sin(eps)*Math.sin(lam))*R2D;
  const nu=Mr+C*D2R, au=1.000001018*(1-e*e)/(1+e*Math.cos(nu));
  const gmst=(280.46061837+360.98564736629*(jd-2451545)+0.000387933*T*T-T*T*T/38710000)%360, lst=((gmst+lon)%360+360)%360;
  let [saz, sel] = horiz(ra, dec, lst, lat); sel = refract(sel);
  // Moon
  const Lp=218.3164477+481267.88123421*T, Dm=(297.8501921+445267.1114034*T)*D2R, Ms=(357.5291092+35999.0502909*T)*D2R, Mp=(134.9633964+477198.8675055*T)*D2R, F=(93.2720950+483202.0175233*T)*D2R;
  const ml=(Lp+6.288774*Math.sin(Mp)+1.274027*Math.sin(2*Dm-Mp)+0.658314*Math.sin(2*Dm)+0.213618*Math.sin(2*Mp)-0.185116*Math.sin(Ms)-0.114332*Math.sin(2*F))*D2R;
  const mb=(5.128122*Math.sin(F)+0.280602*Math.sin(Mp+F)+0.277693*Math.sin(Mp-F)+0.173237*Math.sin(2*Dm-F))*D2R;
  const dist=385000.56-20905.355*Math.cos(Mp)-3699.111*Math.cos(2*Dm-Mp)-2955.968*Math.cos(2*Dm)-569.925*Math.cos(2*Mp);
  const mra=Math.atan2(Math.sin(ml)*Math.cos(eps)-Math.tan(mb)*Math.sin(eps),Math.cos(ml))*R2D, mdec=Math.asin(Math.sin(mb)*Math.cos(eps)+Math.cos(mb)*Math.sin(eps)*Math.sin(ml))*R2D;
  let [maz, mel] = horiz(mra, mdec, lst, lat); mel -= Math.asin(6378.14/dist)*R2D*Math.cos(mel*D2R); mel = refract(mel);
  return {saz, sel, maz, mel, dist, au, lst, subsolar:[dec, ((ra - gmst)%360 + 540)%360 - 180]};
}
function lstOnly(utcMs, lon){ const jd=utcMs/86400000+2440587.5, T=(jd-2451545)/36525; const g=(280.46061837+360.98564736629*(jd-2451545)+0.000387933*T*T)%360; return ((g+lon)%360+360)%360; }
const GALACTIC = (()=>{ const eq=(ra,dec)=>[Math.cos(dec*D2R)*Math.cos(ra*D2R), Math.cos(dec*D2R)*Math.sin(ra*D2R), Math.sin(dec*D2R)];
  const z = eq(192.85948,27.12825), gc = eq(266.405,-28.936); const x = V.norm(V.sub(gc, V.mul(z, V.dot(gc,z)))); return {x, y:V.cross(z,x), z}; })();
const bennett = h => 1.02/Math.tan((h + 10.3/(h + 5.11))*D2R)/60;   // refraction (deg) at true altitude h
function sunSquash(el){ if (el < -1.2 || el > 20) return 1; return clamp(1 + (bennett(el+0.15) - bennett(el-0.15))/0.3, 0.6, 1); }
function moonDiskMean(md, ml, pole){
  const zM = V.mul(md,-1); const yM = V.norm(V.sub(pole, V.mul(zM, V.dot(pole,zM)))); const xM = V.cross(yM, md);
  const l = [V.dot(ml,xM), V.dot(ml,yM), V.dot(ml,zM)]; let s=0, n=0; const N=40;
  for (let j=0;j<N;j++) for (let i=0;i<N;i++){ const x=(i+0.5)/N*2-1, y=(j+0.5)/N*2-1, rr=x*x+y*y; if (rr>=1) continue; const z=Math.sqrt(1-rr); n++;
    const m0 = x*l[0]+y*l[1]+z*l[2]; if (m0>0) s += moonAlbedoJS([x,y,z])*m0/(m0+z); }
  return Math.max(s/n, 1e-6); }
const X2R = (X,Y,Z) => [3.2404542*X - 1.5371385*Y - 0.4985314*Z, -0.9692660*X + 1.8760108*Y + 0.0415560*Z, 0.0556434*X - 0.2040259*Y + 1.0572252*Z];
