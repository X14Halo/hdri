// Spectral Sky Next — settings: defaults and the controls that edit them.
'use strict';
const DEFAULTS = {
  // sun and moon: set by hand, or from a place, date and time
  mode:'manual', sunAz:150, sunEl:35, moonAz:120, moonEl:-30, moonOverride:false, moonIllum:0.5, moonDistKm:384400, moonScale:1,
  date:'2026-06-21', time:'12:00', utc:0, lat:47.6, lon:-122.3,
  // air
  aerosol:'continental', aod:0.1, humidity:50, aerH:1.2, ozone:300, fogVis:50, fogH:0.15, diurnal:true, siteAlt:0,
  // ground
  surface:'grass', albedo:0.2, groundMode:'lit',
  // night sky
  stars:true, starMag:6.5, mw:1, airglow:1, includeSun:true,
  // camera
  camH:0.002, azOff:0,
  // wind (km/h at cloud level; clouds lean and line up with it)
  windX:15, windZ:6,
  // cumulus layer
  cuOn:true, cuCover:0.3, cuBase:1.3, cuDev:0.15, cuSize:1, cuOrg:0.5, cuStreets:0, cuShear:0.5, cuSeed:1, cuDens:1, cuErode:1, cuAmb:1, cuDrop:14,
  // stratocumulus / stratus deck
  scOn:false, scCover:0.6, scBase:0.9, scThick:0.5, scForm:0.35, scCell:1.4, scSeed:1, scDens:1,
  // altocumulus / altostratus
  acOn:false, acCover:0.45, acBase:4.0, acThick:0.35, acForm:0.8, acCell:0.6, acSeed:1, acDens:1,
  // cirrus / cirrostratus / cirrocumulus
  ciOn:false, ciCover:0.25, ciBase:9.0, ciThick:0.7, ciForm:0.5, ciCell:1.5, ciSeed:1, ciDens:1, ciShear:1, ciFall:1.2,
  // rendering
  previewRes:1024, atmSteps:32, volQ:1,
};
