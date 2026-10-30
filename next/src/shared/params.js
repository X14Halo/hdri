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
  // rendering
  previewRes:1024, atmSteps:32,
};
