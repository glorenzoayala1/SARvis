"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";

// Map colour: blue = positive, red = negative, neutral grey at zero. Coherence uses one hue.
const POS = [59, 130, 214], NEG = [217, 83, 74], MID = [120, 120, 116];
// Chart series colours (fixed by entity): NISAR blue, Sentinel-1 orange, GPS light grey.
const C = { nisar: "#3987e5", s1: "#d95926", gps: "#c3c2b7", asc: "#199e70", desc: "#9085e9" };
// One colour per radar band, checked for colour-blind separation on the dark panel. L and C keep the colours NISAR and Sentinel-1 use everywhere else.
const BANDS = [
  { key: "P", cm: 69.7, approx: true, color: "#d55181", who: "UAVSAR aircraft radar", note: "420 to 440 MHz. NASA ABoVE flights over Alaska and western Canada, 2017. Used for forests and soil." },
  { key: "L", cm: 24.2, color: C.nisar, who: "NISAR", note: "The main record here. Repeats every 12 days." },
  { key: "C", cm: 5.55, color: C.s1, who: "Sentinel-1", note: "The comparison record, where it covers the site." },
  { key: "X", cm: 3, approx: true, color: "#1ba3a3", who: "Sandia test radars", note: "8 to 12 GHz. Sample aircraft images at 4-inch detail; locations not published." },
  { key: "Ka", cm: 1, approx: true, color: "#c98500", who: "Sandia test radars", note: "26.5 to 40 GHz. Sample aircraft images at 4-inch detail; locations not published." },
];
const NAME = { nisar: "NISAR (L-band)", s1: "Sentinel-1 (C-band)", gps: "GPS", asc: "Ascending passes", desc: "Descending passes" };
const IMPACT = [213, 81, 129];
// Colour ramps: each side keeps one hue and deepens with size, so big changes read as darker, not just "more red".
const RAMP = {
  neg: [[0, [242, 196, 176]], [0.45, [226, 85, 63]], [1, [122, 22, 28]]],
  pos: [[0, [190, 214, 246]], [0.45, [57, 135, 229]], [1, [18, 58, 118]]],
  impact: [[0, [246, 200, 216]], [0.5, [213, 81, 129]], [1, [110, 24, 66]]],
  coh: [[0, [20, 24, 32]], [1, [150, 200, 255]]],
};
const ramp = (stops, v) => { for (let k = 1; k < stops.length; k++) if (v <= stops[k][0]) { const [a, ca] = stops[k - 1], [b, cb] = stops[k]; return mix(ca, cb, (v - a) / (b - a)); } return stops[stops.length - 1][1]; };
const css = (stops) => stops.map(([t, c]) => `rgb(${c}) ${Math.round(t * 100)}%`).join(", ");
const niceStep = (x) => { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
// Draw a value grid (NaN = no reading) onto a canvas at S times the resolution, blending between pixel centres.
// For display only: fill pinholes (a missing pixel with at least 5 of its 8 neighbours present) and blend each pixel a little
// with its neighbours, so a field-by-field patchwork reads as a surface. Values you tap are still the unsmoothed data.
function soften(vals, nx, ny) {
  let a = vals;
  for (let pass = 0; pass < 2; pass++) { const b = new Float32Array(a.length);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { let sum = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= nx || y >= ny) continue; const v = a[y * nx + x]; if (v === v) { sum += v; n++; } }
      const v = a[j * nx + i];
      b[j * nx + i] = v === v ? (n ? 0.5 * v + 0.5 * (sum / n) : v) : n >= 5 ? sum / n : NaN; }
    a = b; }
  return a;
}
function drawField(c, vals, nx, ny, color, contour, smooth = true) {
  const S = !smooth ? 1 : nx * ny > 90000 ? 2 : 3, W = nx * S, H = ny * S;
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H), out = img.data, up = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const fy = (Y + 0.5) / S - 0.5, j0 = Math.floor(fy), wy = fy - j0;
    for (let X = 0; X < W; X++) {
      const fx = (X + 0.5) / S - 0.5, i0 = Math.floor(fx), wx = fx - i0;
      let sum = 0, wsum = 0;
      for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const v = vals[j * nx + i]; if (v !== v) continue;
        const w = (di ? wx : 1 - wx) * (dj ? wy : 1 - wy); sum += v * w; wsum += w;
      }
      up[Y * W + X] = wsum >= 0.5 ? sum / wsum : NaN;
    }
  }
  for (let q = 0; q < W * H; q++) {
    const v = up[q]; if (v !== v) continue;
    let [r, gg, b, a] = color(v);
    if (contour && a > 0) {            // darken where the value crosses a contour level
      const band = Math.floor(v / contour), X = q % W;
      const vr = X + 1 < W ? up[q + 1] : NaN, vd = q + W < W * H ? up[q + W] : NaN;
      if ((vr === vr && Math.floor(vr / contour) !== band) || (vd === vd && Math.floor(vd / contour) !== band)) { r *= 0.68; gg *= 0.68; b *= 0.68; a = Math.min(255, a + 25); }
    }
    out[q * 4] = r; out[q * 4 + 1] = gg; out[q * 4 + 2] = b; out[q * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const fmtDate = (s) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "");
const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 864e5;
const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const boxLine = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

export default function Page() {
  const top = useRef(undefined), roads = useRef([]), blds = useRef([]);
  const mapDiv = useRef(null), map = useRef(null), canvas = useRef(null), marks = useRef([]);
  const cache = useRef({});
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [layerKey, setLayerKey] = useState(null);
  const [grid, setGrid] = useState(null);
  const [other, setOther] = useState(null);     // same measurement from the other sensor
  const [tRaw, setT] = useState(0);
  const [pick, setPick] = useState(null);       // {i, j, lon, lat, station?}
  const [playing, setPlaying] = useState(false);
  const [fr, setFr] = useState(0);                 // how far playback is between the current date and the next, 0 to 1
  const [mode, setMode] = useState("total");    // "total" = change since first date, "speed" = cm per 30 days between dates
  const [ready, setReady] = useState(false);    // map style loaded (isStyleLoaded() flips false while tiles load, so track it ourselves)
  const cardRef = useRef(null);

  useEffect(() => {
    fetch("data/index.json").then((r) => r.json()).then(async (ids) => {
      const ms = await Promise.all(ids.map((id) => fetch(`data/${id}/meta.json`).then((r) => r.json()).catch(() => ({ id }))));
      const h = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
      want.current = h;
      setSites(ms.map((m, k) => ({ id: ids[k], short: m.short, emoji: m.emoji, lon: ((m.focus_box || m.bbox)[0] + (m.focus_box || m.bbox)[2]) / 2, lat: ((m.focus_box || m.bbox)[1] + (m.focus_box || m.bbox)[3]) / 2 }))); setSiteId(ids.includes(h.site) ? h.site : ids[0]);
      if (h.mode === "speed") setMode("speed");
    });
  }, []);
  const [sig, setSig] = useState(null);         // per-pass signal quality arrays {asc, desc}
  const [tour, setTour] = useState(null);       // {i, auto} while the guided tour runs
  const [copied, setCopied] = useState(false);
  const DEFAULTS = { base: "sat", view3d: true, orbit: true, contours: true, labels: true, smooth: true, boxes: true, stations: true, inches: false, speed: "normal", tall: "medium", clouds: true, strength: 0.62 };
  const [opt, setOpt] = useState(DEFAULTS);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => { try { const o = JSON.parse(window.localStorage.getItem("sarvis-options") || "null"); if (o) setOpt({ ...DEFAULTS, ...o, view3d: true }); } catch {} }, []);
  const set = (patch) => setOpt((o) => { const n = { ...o, ...patch }; try { window.localStorage.setItem("sarvis-options", JSON.stringify(n)); } catch {} return n; });
  const base = opt.base, setBase = (b) => set({ base: b });
  const uf = opt.inches ? 1 / 2.54 : 1, un = opt.inches ? "in" : "cm";      // data stay in cm; only the display converts
  const [notesOpen, setNotesOpen] = useState(false);
  const [sheet, setSheet] = useState("peek");   // footer height: peek, half or full
  const [dragH, setDragH] = useState(null);
  const [landTick, setLandTick] = useState(0);
  const optRef = useRef(null); optRef.current = opt;
  const starsEl = useRef(null);
  const readoutFor = useRef("");
  const [siteMenu, setSiteMenu] = useState(false);
  // every sentence in the Findings tab is worked out from the data by pipeline/findings.py
  const [found, setFound] = useState(null);
  useEffect(() => { fetch("data/findings.json").then((r) => (r.ok ? r.json() : null)).then(setFound).catch(() => {}); }, []);
  const [tab, setTab] = useState("view");
  const sheetEl = useRef(null), bodyEl = useRef(null);
  useEffect(() => { if (bodyEl.current) bodyEl.current.scrollTop = 0; }, [tab, pick?.i, pick?.j, siteId]);
  const want = useRef(null);                    // state requested by the page link (#site=...&layer=...), applied as data loads
  const firstFit = useRef(true);

  useEffect(() => {
    if (!siteId) return;
    setMeta(null); setCtx(null); setGrid(null); setOther(null); setPick(null); cache.current = {};
    fetch(`data/${siteId}/meta.json`).then((r) => r.json()).then((m) => {
      const linked = want.current?.site === m.id && m.layers.find((l) => l.key === want.current.layer);
      setMeta(m); setSig(null); setLayerKey((linked || m.layers.find((l) => l.key === m.default_layer) || m.layers.find((l) => l.key === "up") || m.layers[0]).key);
      if (m.signal_series) Promise.all(Object.entries(m.signal_series).map(([k, v]) => fetch(`data/${m.id}/${v.file}`).then((r) => r.arrayBuffer()).then((b) => [k, new Uint8Array(b)])))
        .then((e) => setSig({ id: m.id, ...Object.fromEntries(e) }));
    });
    fetch(`data/${siteId}/context.json`).then((r) => (r.ok ? r.json() : {})).then(setCtx).catch(() => setCtx({}));
  }, [siteId]);

  const layer = meta?.layers.find((l) => l.key === layerKey);
  // the selected date, kept inside the current layer's range (the two radars have different numbers of dates)
  const t = layer && !layer.static ? Math.min(tRaw, layer.dates.length - 1) : tRaw;
  const otherLayer = layer && !layer.static ? meta.layers.find((l) => l.kind === layer.kind && l.sensor !== layer.sensor && !l.static) : null;

  const load = (m, l) => {
    const k = `${m.id}/${l.file}`;
    if (!cache.current[k]) cache.current[k] = fetch(`data/${k}`).then((r) => r.arrayBuffer()).then((b) => { const g = l.static ? new Uint8Array(b) : new Int16Array(b); g._key = l.key; return g; });
    return cache.current[k];
  };
  useEffect(() => {
    if (!meta || !layer) return;
    let live = true; setGrid(null); setOther(null);
    load(meta, layer).then((g) => {
      if (!live) return;
      const w = want.current; let t0 = layer.static ? 0 : layer.dates.length - 1;
      if (w && w.site === meta.id && w.layer === layer.key) {            // finish applying the page link, once
        if (!layer.static && w.t && layer.dates.includes(w.t)) t0 = layer.dates.indexOf(w.t);
        if (w.lat && w.lon) { const p = toPixel(+w.lon, +w.lat); if (p) setPick(p); }
      }
      want.current = null;
      setGrid(g); setT(t0);
    });
    if (otherLayer) load(meta, otherLayer).then((g) => live && setOther(g));
    return () => { live = false; };
  }, [meta, layerKey]);

  useEffect(() => {
    if (map.current) return;
    map.current = new maplibregl.Map({
      container: mapDiv.current,
      style: "https://tiles.openfreemap.org/styles/dark",      // free vector map, no key (OpenFreeMap / OpenStreetMap)
      center: [-118.37, 33.75], zoom: 11, attributionControl: false, dragRotate: false, maxPitch: 84, minZoom: 1.3, canvasContextAttributes: { antialias: true },
    });
    map.current.touchZoomRotate.disableRotation();
    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.current.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    const m = map.current;
    if (typeof window !== "undefined") window.__sarvisMap = m;      // handy for debugging in the console
    const setup = () => {
      // Zoom all the way out and the map becomes the Earth in space, with that day's real cloud from NASA's VIIRS satellite image.
      try {
        m.setProjection({ type: ["interpolate", ["linear"], ["zoom"], 5.5, "vertical-perspective", GLOBE_ABOVE, "mercator"] });
        m.setSky({ "sky-color": "#3d7bd6", "horizon-color": "#dfeaf5", "fog-color": "#dfeaf5", "sky-horizon-blend": 0.65, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.7, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] });
        if (!m.getSource("earth")) {
          m.addSource("earth", { type: "raster", tileSize: 256, maxzoom: 8, attribution: "NASA GIBS / VIIRS",
            tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${EARTH_DAY}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`] });
          m.addLayer({ id: "earth", type: "raster", source: "earth", maxzoom: 7.5, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 5, 1, 7.5, 0], "raster-fade-duration": 0 } });
        }
      } catch (e) { console.warn("globe view unavailable", e); }
      if (m.getSource("sat")) return;
      top.current = m.getStyle().layers.find((l) => l.type === "symbol")?.id;      // keep place names above everything we add
      m.addSource("sat", { type: "raster", tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 16, attribution: "Imagery: USGS The National Map" });
      m.addLayer({ id: "base-sat", type: "raster", source: "sat", paint: { "raster-brightness-max": 0.96, "raster-saturation": 0.08, "raster-contrast": 0.1, "raster-opacity": 0, "raster-opacity-transition": { duration: 900, delay: 0 } } }, top.current);
      // Shaded relief worked out from the elevation data: sunlit and shadowed slopes give the land its shape.
      if (!m.getSource("relief")) { m.addSource("relief", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
        m.addLayer({ id: "relief", type: "hillshade", source: "relief", minzoom: 7, paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": "rgba(8,18,38,0.85)", "hillshade-highlight-color": "rgba(255,244,214,0.55)", "hillshade-accent-color": "rgba(8,18,38,0.4)", "hillshade-illumination-direction": 315 } }, top.current); }
      // Make place names readable over imagery and the radar layer, whatever the style's own colours are.
      m.getStyle().layers.filter((l) => l.type === "symbol").forEach((l) => {
        try {
          m.setPaintProperty(l.id, "text-color", "#ffffff"); m.setPaintProperty(l.id, "text-halo-color", "rgba(6,8,12,0.95)");
          m.setPaintProperty(l.id, "text-halo-width", 2.2); m.setPaintProperty(l.id, "text-halo-blur", 0.4); m.setPaintProperty(l.id, "text-opacity", 1);
          const big = (v) => (typeof v === "number" ? Math.round(v * 1.25 * 10) / 10 : v);          // 25% larger type, whatever form the style uses
          const sz = m.getLayoutProperty(l.id, "text-size");
          if (typeof sz === "number") m.setLayoutProperty(l.id, "text-size", big(sz));
          else if (sz && Array.isArray(sz.stops)) m.setLayoutProperty(l.id, "text-size", { ...sz, stops: sz.stops.map(([z, v]) => [z, big(v)]) });
          else if (Array.isArray(sz) && sz[0] === "interpolate") m.setLayoutProperty(l.id, "text-size", sz.map((v, k) => (k >= 4 && k % 2 === 0 ? big(v) : v)));
        } catch {}
      });
      roads.current = m.getStyle().layers.filter((l) => l.type === "line" && l["source-layer"] === "transportation").map((l) => l.id);
      roads.current.forEach((id) => { try { m.setPaintProperty(id, "line-color-transition", { duration: 900, delay: 0 }); } catch {} });
      // building footprints from the street map read as black blots over imagery; fade them out there
      blds.current = m.getStyle().layers.filter((l) => l["source-layer"] === "building").map((l) => l.id);
      document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");       // start collapsed; the (i) button opens it
      setReady(true);
    };
    m.on("load", setup);
    // Background tiles sometimes fail or get cancelled mid-flight; the map retries them, so keep the console quiet.
    m.on("error", (e) => { if (!/fetch|tile|AJAX|abort/i.test(e?.error?.message || "")) console.warn(e?.error || e); });
    // If the vector map never arrives (service down, offline venue Wi-Fi), fall back to plain OpenStreetMap tiles.
    setTimeout(() => {
      if (m.isStyleLoaded() || m.getSource("sat")) return;
      m.once("style.load", setup);
      m.setStyle({ version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
        layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.8, "raster-brightness-max": 0.6 } }] });
    }, 8000);
    canvas.current = document.createElement("canvas");
  }, []);

  const toPixel = (lon, lat) => {
    const [w, s, e, n] = meta.bbox;
    const i = Math.floor(((lon - w) / (e - w)) * meta.nx), j = Math.floor(((n - lat) / (n - s)) * meta.ny);
    return i >= 0 && i < meta.nx && j >= 0 && j < meta.ny ? { i, j, lon, lat } : null;
  };

  useEffect(() => {
    if (!meta || !map.current || !ready) return;
    const m = map.current, [w, s, e, n] = meta.bbox;
    const phone = window.innerWidth <= 800;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    m.fitBounds([[w, s], [e, n]], { padding: { top: 64, bottom: 196, left: phone ? 16 : 40, right: phone ? 16 : 40 }, duration: firstFit.current || calm ? 0 : 1600, essential: true });
    firstFit.current = false;
    if (phone) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");   // start collapsed; the (i) button still opens it
    const onClick = (ev) => { const p = toPixel(ev.lngLat.lng, ev.lngLat.lat); setSheet("peek"); if (p) setPick({ ...p, at: [ev.lngLat.lng, ev.lngLat.lat] }); };      // a press on the map slides the footer down and reads that spot
    m.on("click", onClick);
    const boxes = { type: "FeatureCollection", features: [["#f0efec", meta.tied_to ? null : meta.ref_box], ["#eda100", meta.focus_box]].filter((b) => b[1])      // no reference patch when the site is pinned to a GPS station instead
      .map(([color, b]) => ({ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates: boxLine(b) } })) };
    const draw = () => {
      if (m.getSource("boxes")) m.getSource("boxes").setData(boxes);
      else { m.addSource("boxes", { type: "geojson", data: boxes });
        m.addLayer({ id: "boxes", type: "line", source: "boxes", paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [2, 2] } }, top.current); }
    };
    draw();
    return () => m.off("click", onClick);
  }, [meta, ready]);

  // GPS / survey stations as clickable markers
  useEffect(() => {
    marks.current.forEach((k) => k.remove()); marks.current = [];
    if (!meta || !ctx?.gnss || !map.current || !opt.stations) return;
    ctx.gnss.stations.forEach((st) => {
      const el = document.createElement("button"); el.className = "station"; el.textContent = st.id; el.title = `${st.kind === "survey" ? "Survey point" : "GPS station"} ${st.id}`;
      el.onclick = (ev) => { ev.stopPropagation(); const p = toPixel(st.lon, st.lat); if (p) { setPick({ ...p, station: st.id }); setTab("spot"); setSheet((v) => (v === "peek" ? "half" : v)); } };
      marks.current.push(new maplibregl.Marker({ element: el }).setLngLat([st.lon, st.lat]).addTo(map.current));
    });
  }, [meta, ctx, opt.stations]);
  useEffect(() => { if (ready && map.current?.getLayer("boxes")) map.current.setLayoutProperty("boxes", "visibility", opt.boxes ? "visible" : "none"); }, [opt.boxes, ready, meta]);


  const speed = mode === "speed" && layer && !layer.static;
  // value shown at date index k for flat pixel index p: running total, or speed since the previous date
  const valueAt = (g, l, k, p) => {
    const n = meta.nx * meta.ny, q = g[k * n + p];
    if (q === meta.nodata) return null;
    if (!speed) return q * meta.scale;
    const k1 = Math.max(k, 1), a = g[(k1 - 1) * n + p], b = g[k1 * n + p];
    if (a === meta.nodata || b === meta.nodata) return null;
    return ((b - a) * meta.scale * 30) / (toDay(l.dates[k1]) - toDay(l.dates[k1 - 1]));
  };
  // the value shown right now: during playback it is part-way between this date and the next
  const vNow = (p) => { const a = valueAt(grid, layer, t, p); if (!fr || a === null || t >= layer.dates.length - 1) return a; const b = valueAt(grid, layer, t + 1, p); return b === null ? a : a + (b - a) * fr; };
  const lim = useMemo(() => {
    if (!layer || layer.static) return 1;
    if (!speed || !grid || grid._key !== layer.key) return Math.max(layer.p98, 0.5);
    const n = meta.nx * meta.ny, v = [];
    for (let k = 1; k < layer.dates.length; k++) for (let p = k % 7; p < n; p += 7) { const x = valueAt(grid, layer, k, p); if (x !== null) v.push(Math.abs(x)); }
    v.sort((a, b) => a - b);
    return Math.max(v[Math.floor(v.length * 0.98)] || 0.5, 0.5);
  }, [layer, grid, speed, meta]);
  const contourStep = niceStep((lim * uf) / 4) / uf;          // even steps in whichever unit is displayed
  const unit = speed ? `${un}/month` : un;
  const bars3d = !!layer && (!layer.static || layer.palette === "impact");

  useEffect(() => {
    if (!meta || !grid || !layer || !map.current || !ready || grid._key !== layer.key) return;
    const { nx, ny } = meta, c = canvas.current, N = nx * ny;
    if (!layer.static && (t + 1) * N > grid.length) return;
    const vals = new Float32Array(N);
    if (layer.static) for (let p = 0; p < N; p++) vals[p] = layer.palette === "impact" ? (grid[p] === layer.nodata ? NaN : grid[p] / layer.max) : grid[p] / 255;
    else for (let p = 0; p < N; p++) { const v = vNow(p); vals[p] = v === null ? NaN : v / lim; }
    const color = layer.static
      ? (layer.palette === "impact" ? (v) => { const q = Math.min(1, v / IMPACT_TOP); return [...ramp(RAMP.impact, q), Math.min(235, 255 * Math.max(0, q - 0.06) * 1.7)]; } : (v) => [...ramp(RAMP.coh, v), 215])
      : (v) => { const m = Math.min(1, Math.abs(v)); return [...ramp(v < 0 ? RAMP.neg : RAMP.pos, m), Math.min(232, 255 * Math.max(0, m - 0.1) * 2.3)]; };
    drawField(c, meta.soften && opt.smooth ? soften(vals, nx, ny) : vals, nx, ny, color, layer.static || !opt.contours ? 0 : contourStep / lim, opt.smooth);
    if (map.current.getLayer("sar")) { map.current.setPaintProperty("sar", "raster-resampling", opt.smooth ? "linear" : "nearest"); map.current.setPaintProperty("sar", "raster-opacity", opt.strength * riseK.current); }
    // A canvas source repaints straight from the canvas: no image decode, no aborted loads while scrubbing.
    const [w, s, e, n] = meta.bbox, coords = [[w, n], [e, n], [e, s], [w, s]], m = map.current;
    let src = m.getSource("sar");
    if (src && src._site !== meta.id) { m.removeLayer("sar"); m.removeSource("sar"); src = null; }      // canvas size changes with the site
    if (!src) {
      m.addSource("sar", { type: "canvas", canvas: c, coordinates: coords, animate: false });
      m.addLayer({ id: "sar", type: "raster", source: "sar", paint: { "raster-resampling": opt.smooth ? "linear" : "nearest", "raster-fade-duration": 0, "raster-opacity": opt.strength * riseK.current, "raster-opacity-transition": { duration: 300, delay: 0 } } }, m.getLayer("boxes") ? "boxes" : top.current);
      src = m.getSource("sar"); src._site = meta.id;
    }
    src.play(); src.pause(); m.triggerRepaint();
  }, [meta, grid, t, fr, layerKey, ready, mode, lim, opt.contours, opt.smooth, opt.view3d, opt.strength]);
  const colorCss = (v) => { const m = Math.min(1, Math.abs(v)); return `rgb(${ramp(v < 0 ? RAMP.neg : RAMP.pos, m)})`; };

  useEffect(() => {
    if (!ready || !map.current) return;
    map.current.setPaintProperty("base-sat", "raster-opacity", base === "sat" ? 1 : 0);        // cross-fades between the two backgrounds
    roads.current.forEach((id) => { try { map.current.setPaintProperty(id, "line-color", base === "sat" ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.12)"); } catch {} });
    blds.current.forEach((id) => { try { map.current.setLayoutProperty(id, "visibility", base === "sat" ? "none" : "visible"); } catch {} });
  }, [base, ready]);
  const pin = useRef(null);
  useEffect(() => {
    pin.current?.remove(); pin.current = null;
    if (pick && !pick.station && map.current) { const el = document.createElement("div"); el.className = "pin"; pin.current = new maplibregl.Marker({ element: el }).setLngLat([pick.lon, pick.lat]).addTo(map.current); }
  }, [pick]);

  useEffect(() => {
    if (!playing || !layer || layer.static) return;
    // Playback glides from one radar date to the next: the map and columns are blended between the two dates about 20 times a second.
    const D = { slow: 1700, normal: 950, fast: 480 }[opt.speed] || 950, calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm) { const id = setInterval(() => setT((v) => (v + 1) % layer.dates.length), D); return () => clearInterval(id); }
    let raf = 0, t0 = performance.now(), last = 0;
    const tick = (now) => { const f = (now - t0) / D;
      if (f >= 1) { t0 = now; last = now; setFr(0); setT((v) => (v + 1) % layer.dates.length); }
      else if (now - last > 48) { last = now; setFr(f); }
      raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); setFr(0); };
  }, [playing, layerKey, meta, opt.speed]);

  // one pixel (or 3x3 median at a station) through time
  const seriesAt = (g, l, p, win) => l.dates.map((d, k) => {
    const vals = [];
    for (let dj = -win; dj <= win; dj++) for (let di = -win; di <= win; di++) {
      const i = p.i + di, j = p.j + dj; if (i < 0 || j < 0 || i >= meta.nx || j >= meta.ny) continue;
      const x = valueAt(g, l, k, j * meta.nx + i); if (x !== null) vals.push(x);
    }
    vals.sort((a, b) => a - b);
    return { d, x: toDay(d), y: vals.length ? vals[Math.floor(vals.length / 2)] : null };
  });

  const sigChart = useMemo(() => {
    if (!pick || !layer?.static || !meta?.signal_series || !sig || sig.id !== meta.id) return null;
    const n = meta.nx * meta.ny, p = pick.j * meta.nx + pick.i;
    const lines = Object.entries(meta.signal_series).filter(([k]) => sig[k]).map(([k, v]) => ({ id: k, pts: v.dates.map((d, i) => ({ d, x: toDay(d), y: sig[k][i * n + p] / 250 })) }));
    return lines.length ? { lines } : null;
  }, [pick, layerKey, meta, sig]);
  const chart = useMemo(() => {
    if (!pick || !grid || !layer || layer.static || !meta || grid._key !== layer.key) return null;
    const win = pick.station ? 1 : 0, lines = [];
    const main = seriesAt(grid, layer, pick, win);
    lines.push({ id: layer.sensor, pts: main });
    if (otherLayer && other && other._key === otherLayer.key) lines.push({ id: otherLayer.sensor, pts: seriesAt(other, otherLayer, pick, win) });
    let stat = null;
    const st = !speed && pick.station && ctx?.gnss?.stations.find((s) => s.id === pick.station);
    if (st) {
      const los = layer.sensor === "s1" ? meta.los_s1 : meta.los, v = layer.kind.endsWith("_los") ? los?.[layer.kind.replace("_los", "")] : null;
      const proj = (k) => layer.kind === "up" ? st.u[k] : layer.kind === "east" ? st.e[k] : v ? v.e * st.e[k] + v.n * st.n[k] + v.u * st.u[k] : null;
      const x0 = main[0].x, raw = st.dates.map((d, k) => ({ d, x: toDay(d), y: proj(k) })).filter((p) => p.y !== null);
      const near = (x) => { const w = raw.filter((p) => Math.abs(p.x - x) <= 3).map((p) => p.y).sort((a, b) => a - b); return w.length ? w[Math.floor(w.length / 2)] : null; };
      const base = near(x0);
      if (base !== null) {
        lines.push({ id: "gps", pts: raw.filter((p) => p.x >= x0).map((p) => ({ ...p, y: p.y - base })), thin: true });
        const diffs = main.map((p) => { const g = near(p.x); return p.y !== null && g !== null ? p.y - (g - base) : null; }).filter((v) => v !== null);
        if (diffs.length > 2) stat = { rms: Math.sqrt(diffs.reduce((a, v) => a + v * v, 0) / diffs.length), n: diffs.length };
      }
    }
    return { lines, stat };
  }, [pick, grid, other, layerKey, meta, ctx, mode]);

  const span = useMemo(() => {
    if (!meta || !layer) return null;
    const ds = layer.static ? Object.values(meta.signal_series || {}).flatMap((v) => [...v.starts, ...v.dates]) : layer.dates;
    if (!ds.length) return null;
    const xs = ds.map(toDay); return [Math.min(...xs), Math.max(...xs)];
  }, [meta, layerKey]);
  const rain = useMemo(() => {
    if (!ctx?.rain || !layer || !span) return null;
    const [x0, x1] = span;
    return { x0, x1, pts: ctx.rain.dates.map((d, k) => ({ d, x: toDay(d), y: ctx.rain.mm[k] })).filter((p) => p.x >= x0 && p.x <= x1 && p.y !== null) };
  }, [ctx, layerKey, meta, span]);

  const wind = useMemo(() => {
    if (!ctx?.wind || !layer || !span) return null;
    const [x0, x1] = span;
    const pts = ctx.wind.dates.map((d, k) => ({ d, x: toDay(d), y: ctx.wind.max[k], mean: ctx.wind.speed[k], dir: ctx.wind.dir[k] })).filter((p) => p.x >= x0 && p.x <= x1 && p.y !== null);
    return { x0, x1, pts };
  }, [ctx, layerKey, meta, span]);
  const eventX = meta?.event ? toDay(meta.event.utc) - 1 : null;      // event.utc is the first UTC day after the event
  const nowX = layer && !layer.static ? toDay(layer.dates[t]) : eventX;
  const windNow = wind && nowX !== null && wind.pts.find((p) => p.x === nowX);
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  const wl = meta?.wavelength_cm;
  // The spot that changed most inside the focus box, for the headline finding and the tour.
  const hot = useMemo(() => {
    if (!meta || !grid || !layer || grid._key !== layer.key || !meta.focus_box) return null;
    if (layer.static && layer.palette !== "impact") return null;
    const [w, s, e, n] = meta.bbox, [fw, fs, fe, fn] = meta.focus_box, N = meta.nx * meta.ny;
    const i0 = Math.max(0, Math.floor(((fw - w) / (e - w)) * meta.nx)), i1 = Math.min(meta.nx - 1, Math.floor(((fe - w) / (e - w)) * meta.nx));
    const j0 = Math.max(0, Math.floor(((n - fn) / (n - s)) * meta.ny)), j1 = Math.min(meta.ny - 1, Math.floor(((n - fs) / (n - s)) * meta.ny));
    const off = layer.static ? 0 : (layer.dates.length - 1) * N;
    let best = null, valid = 0, over = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = grid[off + j * meta.nx + i];
      if (q === (layer.static ? layer.nodata : meta.nodata)) continue;
      const v = layer.static ? q / layer.max : q * meta.scale; valid++;
      if (layer.static && v > 0.3) over++;
      if (!best || Math.abs(v) > Math.abs(best.v)) best = { i, j, v };
    }
    if (!best) return null;
    return { ...best, lon: w + ((best.i + 0.5) / meta.nx) * (e - w), lat: n - ((best.j + 0.5) / meta.ny) * (n - s), share: valid ? over / valid : 0 };
  }, [meta, grid, layerKey]);

  // Keep the page link in step with what is on screen, so any view can be shared.
  useEffect(() => {
    if (!meta || !layer || want.current) return;
    const q = new URLSearchParams({ site: meta.id, layer: layer.key });
    if (!layer.static) q.set("t", layer.dates[t]);
    if (mode === "speed") q.set("mode", "speed");
    if (pick) { q.set("lat", pick.lat.toFixed(4)); q.set("lon", pick.lon.toFixed(4)); }
    window.history.replaceState(null, "", "#" + q.toString());
  }, [meta, layerKey, t, mode, pick]);
  const copyLink = async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } };

  // Guided tour: each step names the view it wants and what to point at; effects move the app there.
  const steps = useMemo(() => {
    if (!meta) return [];
    const hasS1 = meta.layers.some((l) => l.sensor === "s1" && l.kind === "up"), st = ctx?.gnss?.stations?.[0];
    const main = meta.default_layer && meta.layers.find((l) => l.key === meta.default_layer) ? meta.default_layer : "up";
    const cm = (v) => `${Math.abs(v * uf).toFixed(1)} ${un}`, lo = (o) => (o && Object.values(o).length ? Math.min(...Object.values(o)) : null);
    if (meta.event) return [
      { title: "Before and after the storm", layer: main, point: "box", label: "Coast around Destin",
        say: () => `Pink marks ground that looked different to the radar after ${meta.event.name} than in the calm weeks before it.` },
      { title: "The most changed spot", layer: main, pick: "hot", point: "hot", label: "Most changed", glow: "pickcard",
        say: (d) => d.hot ? `Here the radar lost ${Math.round(100 * d.hot.v)}% of its usual signal. In the chart, the lines stay level through the calm passes, then drop at the yellow storm line.` : "Finding the most changed spot…" },
      { title: "Line it up with the weather", layer: main, pick: "hot", point: "hot", label: "Same spot", glow: "weather",
        say: (d) => `The rain and wind charts carry the same yellow line. ${d.share !== null ? `Across the yellow box, ${Math.round(100 * d.share)}% of the ground changed by more than 30%. ` : ""}${found?.sites?.[meta.id]?.conclusion ? `${found.sites[meta.id].conclusion} ` : ""}Pink means changed, not destroyed: tides and wet soil count too.` },
    ];
    return [
      { title: "Watch it move", layer: "up", mode: "total", play: true, glow: "timebar", tab: "about",
        say: () => `${meta.story} Red is sinking, blue is rising.` },
      { title: "The fastest spot", layer: "up", mode: "total", pick: "hot", point: "hot", label: "Moved the most", glow: "pickcard",
        say: (d) => d.hot ? `This spot went ${d.hot.v < 0 ? "down" : "up"} ${cm(d.hot.v)} between ${fmtDate(d.layer.dates[0])} and ${fmtDate(d.layer.dates[d.layer.dates.length - 1])}. Each dot on the chart is one satellite pass.` : "Finding the fastest spot…" },
      { title: "Speed and rain", layer: "up", mode: "speed", pick: "hot", point: "hot", label: "Same spot, now speed", glow: "weather",
        say: () => `Now the chart shows speed in cm per month, with the rainfall bars below it. ${found?.sites?.[meta.id]?.conclusion || "Compare its peaks with the rain."}` },
      ...(hasS1 ? [{ title: "Old radar, new radar", layer: "s1_up", mode: "total", point: "box", label: "Blank = no reading", glow: "coverage",
        say: (d) => { const a = lo(d.cov?.nisar), c = lo(d.cov?.s1); return `This is Sentinel-1, whose 5.5 cm wavelength is a quarter of NISAR's.${a !== null && c !== null ? ` Over the same weeks it got a usable reading in the yellow box on ${Math.round(100 * c)}% of passes; NISAR managed ${Math.round(100 * a)}%.` : ""}`; } }] : []),
      ...(st ? [{ title: "Checked on the ground", layer: "up", mode: "total", station: st, point: "station", label: `GPS ${st.id}`, glow: "pickcard", notes: true,
        say: (d) => `A fixed GPS antenna measured the same ground.${meta.tied_to ? ` Here the radar is pinned to GPS station ${meta.tied_to}, so the two match at that station by design: it sets the zero, it is not a test.` : d.stat ? ` Radar and GPS differ by ${d.stat.rms.toFixed(2)} cm on average here.` : ""} One limit to know: north-south motion is mostly invisible to this radar.` }] : []),
    ];
  }, [meta, ctx, opt.inches]);
  const step = tour && steps[tour.i];
  const fitSite = (duration) => {
    if (!meta || !map.current) return;
    const [w, s, e, n] = meta.bbox, phone = window.innerWidth <= 800;
    map.current.fitBounds([[w, s], [e, n]], { padding: { top: 64, bottom: 196, left: phone ? 16 : 40, right: phone ? 16 : 40 }, duration, essential: true });
  };
  const tourMark = useRef(null), wasTouring = useRef(false);
  useEffect(() => {
    if (!step || !meta || !layer) return;
    if (layer.key !== step.layer && meta.layers.find((l) => l.key === step.layer)) { setPlaying(false); setLayerKey(step.layer); return; }
    if (step.mode && mode !== step.mode) { setMode(step.mode); return; }
    if (!grid || grid._key !== layer.key) return;
    setPlaying(!!step.play);
    setTab(step.tab || ({ pickcard: "spot", weather: "weather", coverage: "compare" })[step.glow] || "about"); setSheet((v) => (v === "peek" ? "half" : v));
    const last = layer.static ? 0 : layer.dates.length - 1;
    if (!layer.static) setT(step.play ? 0 : last);
    // a play tick can still land after this; settle on the last date once the animation timer is gone
    const settle = !step.play && !layer.static ? setTimeout(() => setT(last), 750) : null;
    setNotesOpen(!!step.notes);
    if (step.pick === "hot" && hot) setPick({ i: hot.i, j: hot.j, lon: hot.lon, lat: hot.lat });
    else if (step.station) { const p = toPixel(step.station.lon, step.station.lat); if (p) setPick({ ...p, station: step.station.id }); }
    else if (!step.pick) setPick(null);
    return () => clearTimeout(settle);
  }, [tour?.i, step, layerKey, grid, mode, hot === null]);

  // Tour pointers: a bouncing arrow on the map, a camera move, and a soft glow on the card being described.
  useEffect(() => {
    tourMark.current?.remove(); tourMark.current = null;
    document.querySelectorAll(".spot").forEach((el) => el.classList.remove("spot"));
    if (!step || !meta || !map.current || !ready) { if (wasTouring.current) { wasTouring.current = false; fitSite(900); } return; }
    wasTouring.current = true;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches, dur = calm ? 0 : 1300;
    let at = null;
    if (step.point === "hot" && hot) at = [hot.lon, hot.lat];
    else if (step.point === "station" && step.station) at = [step.station.lon, step.station.lat];
    else if (step.point === "box" && meta.focus_box) at = [(meta.focus_box[0] + meta.focus_box[2]) / 2, meta.focus_box[3]];
    if (at) {
      const el = document.createElement("div");          // MapLibre positions this element with a transform, so animate an inner one
      el.innerHTML = `<div class="tourmark"><span></span><svg viewBox="0 0 24 30" width="26" height="32" aria-hidden="true"><path d="M12 29 L2 15 H8.5 V1 H15.5 V15 H22 Z" fill="#eda100" stroke="#1a1a19" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`;
      el.querySelector("span").textContent = step.label || "";
      tourMark.current = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, step.point === "box" ? 0 : -14] }).setLngLat(at).addTo(map.current);
      if (step.point === "box") fitSite(dur);
      else { const z = map.current.cameraForBounds([[meta.bbox[0], meta.bbox[1]], [meta.bbox[2], meta.bbox[3]]])?.zoom ?? map.current.getZoom(); map.current.easeTo({ center: at, zoom: Math.min(z + 0.6, 15), duration: dur, padding: { bottom: 110, top: 30, left: 0, right: 0 }, essential: true }); }
    } else fitSite(dur);
    const t1 = step.glow && setTimeout(() => {
      const card = document.getElementById(step.glow); if (!card) return;
      card.classList.add("spot");
      if (step.glow !== "timebar") card.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "nearest" });
    }, 650);
    return () => clearTimeout(t1);
  }, [tour?.i, step, ready, hot?.i, hot?.j, layerKey]);
  useEffect(() => {
    if (!tour?.auto) return;
    const id = setTimeout(() => setTour((v) => (v && v.i < steps.length - 1 ? { ...v, i: v.i + 1 } : null)), 7000);
    return () => clearTimeout(id);
  }, [tour, steps.length]);
  useEffect(() => { setTour(null); }, [siteId]);

  // Slice: a straight cut through the selected spot, showing terrain height and the measured change along it.
  const [sliceDir, setSliceDir] = useState("ns");
  const [slice, setSlice] = useState(null);
  const sliceOk = pick && grid && layer && grid._key === layer.key && (!layer.static || layer.palette === "impact");
  useEffect(() => {
    setSlice(null);
    if (!sliceOk || !meta) return;
    let live = true;
    const [w, s, e, n] = meta.bbox, K = 140, pts = [];
    for (let k = 0; k < K; k++) { const f = k / (K - 1); pts.push(sliceDir === "ns" ? { lon: pick.lon, lat: n - f * (n - s) } : { lon: w + f * (e - w), lat: pick.lat }); }
    const kmPer = sliceDir === "ns" ? (n - s) * 110.54 : (e - w) * 111.32 * Math.cos((pick.lat * Math.PI) / 180);
    elevations(pts).then((h) => {
      if (!live) return;
      const rows = pts.map((q, k) => { const px = toPixel(q.lon, q.lat); let v = null;
        if (px) { const idx = px.j * meta.nx + px.i; v = layer.static ? (grid[idx] === layer.nodata ? null : grid[idx] / layer.max) : valueAt(grid, layer, t, idx); }
        return { km: (k / (K - 1)) * kmPer, h: h[k], v }; });
      const at = sliceDir === "ns" ? ((n - pick.lat) / (n - s)) * kmPer : ((pick.lon - w) / (e - w)) * kmPer;
      setSlice({ rows, at, ends: sliceDir === "ns" ? ["North", "South"] : ["West", "East"] });
    }).catch(() => live && setSlice({ error: true }));
    return () => { live = false; };
  }, [sliceOk, pick?.i, pick?.j, sliceDir, layerKey, t, mode, meta]);
  useEffect(() => {          // show the cut on the map
    const m = map.current; if (!m || !ready || !meta) return;
    const [w, s, e, n] = meta.bbox;
    const data = { type: "FeatureCollection", features: sliceOk ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: sliceDir === "ns" ? [[pick.lon, n], [pick.lon, s]] : [[w, pick.lat], [e, pick.lat]] } }] : [] };
    if (m.getSource("slice")) m.getSource("slice").setData(data);
    else { m.addSource("slice", { type: "geojson", data });
      m.addLayer({ id: "slice-c", type: "line", source: "slice", paint: { "line-color": "#0b0d10", "line-width": 4, "line-opacity": 0.7 } }, top.current);
      m.addLayer({ id: "slice", type: "line", source: "slice", paint: { "line-color": "#f0efec", "line-width": 1.6 } }, top.current); }
  }, [sliceOk, pick?.i, pick?.j, sliceDir, ready, meta]);

  // 3D view: the real terrain (stretched a little so slopes read), the radar colours draped over it, and a thin
  // column on each block of pixels. Column height is proportional to the measured change at one stated scale.
  const TERRAIN_X = 1.5;
const CLOUD_BASE_M = 1000;    // lowest cloud layer height above sea level, before the same vertical stretch as the land. Illustrative, not measured:
                              // the layer is raised when needed so it stays above the default 3D camera.
const KEYWORD = { down: "sank", up: "rose" };
const EARTH_DAY = "2026-10-13";   // the day of the whole-Earth satellite picture: the last radar date at Portuguese Bend
const GLOBE_ABOVE = 8;         // below this zoom the flat map bends into a globe (fully round by zoom 5.5)
const PEEK = 148;             // height of the footer when it is down, in pixels (matches .sheet --h in the stylesheet)
const IMPACT_TOP = 0.5;      // storm-change colour is full strength where the radar lost half its usual signal or more
const CLOUD_SPEEDUP = 12;      // clouds drift at 12 times that day's average wind speed, so the movement is visible
  const camAlt3d = useRef(0); const zoom3d = useRef(0); const [cam3d, setCam3d] = useState(0);
  const colsRef = useRef([]); const colMarks = useRef([]); const [colsVer, setColsVer] = useState(0);
  const mPerCm = useMemo(() => {
    if (!meta || !layer || layer.static) return 0;
    const widthM = (meta.bbox[2] - meta.bbox[0]) * 111320 * Math.cos((((meta.bbox[1] + meta.bbox[3]) / 2) * Math.PI) / 180);
    // the scale comes from the biggest change anywhere on the latest date, so the tallest column is about 3% of the site's width
    let peak = 0; const last = layer.dates.length - 1;
    if (grid && grid._key === layer.key) for (let i = 0; i < meta.nx * meta.ny; i++) { const v = valueAt(grid, layer, last, i); if (v !== null && Math.abs(v) > peak) peak = Math.abs(v); }
    return niceStep((0.03 * widthM) / Math.max(peak, lim)) * { low: 0.5, medium: 1, high: 2 }[opt.tall];
  }, [meta, layerKey, lim, opt.tall, grid, mode]);
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const on = opt.view3d && bars3d && meta && grid && layer && grid._key === layer.key;
    let fc = { type: "FeatureCollection", features: [] }, live = true;
    const push = () => { if (!live) return; if (m.getSource("bars")) m.getSource("bars").setData(fc);
      else { m.addSource("bars", { type: "geojson", data: fc });
        m.addLayer({ id: "bars", type: "fill-extrusion", source: "bars", paint: { "fill-extrusion-base": ["get", "b"], "fill-extrusion-height": ["*", ["get", "h"], riseK.current], "fill-extrusion-color": ["get", "c"], "fill-extrusion-opacity": 0.95, "fill-extrusion-vertical-gradient": true } }, top.current); } };
    if (!on) { colsRef.current = []; setColsVer((v) => v + 1); push(); return; }
    const [w, s, e, n] = meta.bbox, { nx, ny } = meta, B = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / 420)));       // about 420 blocks at most, so the land stays visible between columns
    const widthM = (e - w) * 111320 * Math.cos((((s + n) / 2) * Math.PI) / 180), impactTop = widthM * 0.018 * { low: 0.5, medium: 1, high: 2 }[opt.tall];
    const dx = (e - w) / nx, dy = (n - s) / ny, cols = [];
    for (let j = 0; j < ny; j += B) for (let i = 0; i < nx; i += B) {
      let sum = 0, cnt = 0;
      for (let jj = j; jj < Math.min(ny, j + B); jj++) for (let ii = i; ii < Math.min(nx, i + B); ii++) {
        const v = layer.static ? (grid[jj * nx + ii] === layer.nodata ? null : grid[jj * nx + ii] / layer.max) : vNow(jj * nx + ii);
        if (v !== null) { sum += v; cnt++; }
      }
      if (!cnt) continue;
      const v = sum / cnt, k = layer.static ? v : v / lim; if (Math.abs(k) < 0.15) continue;          // leave out near-zero noise
      const cx = w + (i + B / 2) * dx, cy = n - (j + B / 2) * dy, hw = B * dx * 0.06, hh = B * dy * 0.06;   // thin: about an eighth of the block
      cols.push({ lon: cx, lat: cy, hw, hh, v, h: layer.static ? Math.min(1, v / IMPACT_TOP) * impactTop : Math.abs(v) * mPerCm,
        c: `rgb(${ramp(layer.static ? RAMP.impact : k < 0 ? RAMP.neg : RAMP.pos, Math.min(1, Math.abs(k) / (layer.static ? IMPACT_TOP : 1)))})` });
    }
    // the map itself lifts each column onto the terrain, so heights here are measured from the ground
    fc.features = cols.map((q) => ({ type: "Feature", properties: { b: 0, h: q.h, c: q.c }, geometry: { type: "Polygon", coordinates: [[[q.lon - q.hw, q.lat + q.hh], [q.lon + q.hw, q.lat + q.hh], [q.lon + q.hw, q.lat - q.hh], [q.lon - q.hw, q.lat - q.hh], [q.lon - q.hw, q.lat + q.hh]]] } }));
    push();
    // text for the number shown beside each column once you zoom in (drawn by the effect below)
    cols.forEach((q) => { const x = layer.static ? Math.round(100 * q.v) : q.v * uf;
      q.t = layer.static ? `${x}%` : `${x > 0 ? "+" : "−"}${Math.abs(x) >= 10 ? Math.abs(x).toFixed(0) : Math.abs(x).toFixed(1)} ${un}`; });
    colsRef.current = cols; if (!fr) setColsVer((v) => v + 1);
    return () => { live = false; };
  }, [ready, opt.view3d, opt.tall, opt.inches, bars3d, meta, grid, layerKey, t, fr, mode, lim, mPerCm]);
  // Numbers beside the columns. They appear once you zoom in past the opening 3D view, biggest changes first,
  // and any that would sit on top of another are left out. Zoom further and more of them fit.
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const clear = () => { colMarks.current.forEach((k) => k.remove()); colMarks.current = []; };
    const draw = () => { clear();
      if (!opt.view3d || !opt.labels || !colsRef.current.length || !zoom3d.current || m.getZoom() < zoom3d.current + 0.5) return;
      const W = m.getContainer().clientWidth, H = m.getContainer().clientHeight, kept = [];
      for (const q of [...colsRef.current].sort((a, b) => Math.abs(b.v) - Math.abs(a.v))) {
        if (kept.length >= 40) break;
        const p = m.project([q.lon, q.lat]); if (p.x < 24 || p.y < 70 || p.x > W - 24 || p.y > H - 24) continue;
        if (kept.some((k) => Math.abs(k.x - p.x) < 62 && Math.abs(k.y - p.y) < 24)) continue;
        kept.push(p);
        const el = document.createElement("div"); el.className = "vlabel col"; el.textContent = q.t;
        colMarks.current.push(new maplibregl.Marker({ element: el, anchor: "top", offset: [0, 3] }).setLngLat([q.lon, q.lat]).addTo(m));
      } };
    draw(); m.on("moveend", draw);
    return () => { m.off("moveend", draw); clear(); };
  }, [ready, opt.view3d, opt.labels, colsVer, cam3d]);
  // Some places need their own background picture (at Destin the public aerial imagery is blacked out over a military base).
  useEffect(() => {
    const m = map.current; if (!m || !ready || !meta) return;
    const ids = (meta.backdrops || []).map((_, k) => `backdrop${k}`);
    (meta.backdrops || []).forEach((bd, k) => { const [w, s, e, n] = bd.bbox;
      m.addSource(ids[k], { type: "image", url: `data/${meta.id}/${bd.file}`, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      m.addLayer({ id: ids[k], type: "raster", source: ids[k], paint: { "raster-opacity": base === "sat" ? 1 : 0, "raster-opacity-transition": { duration: 900, delay: 0 }, "raster-fade-duration": 0, "raster-saturation": 0.08, "raster-contrast": 0.08 } }, m.getLayer("relief") ? "relief" : top.current); });
    return () => ids.forEach((id) => { if (m.getLayer(id)) m.removeLayer(id); if (m.getSource(id)) m.removeSource(id); });
  }, [ready, meta?.id, base]);
  // Arriving at a place: the colours and columns are held back while the camera travels, then the colour washes in and the columns rise.
  const riseK = useRef(1), riseRaf = useRef(0);
  const setRise = (m, k) => { riseK.current = k;
    if (m.getLayer("bars")) m.setPaintProperty("bars", "fill-extrusion-height", ["*", ["get", "h"], k]);
    if (m.getLayer("sar")) m.setPaintProperty("sar", "raster-opacity", optRef.current.strength * k, { validate: false }); };
  const arrive = (m) => { cancelAnimationFrame(riseRaf.current); setRise(m, 0);
    const start = () => { const t0 = performance.now(), step = (now) => { const f = Math.min(1, (now - t0) / 1700), k = 1 - (1 - f) ** 3; setRise(m, k); if (f < 1) riseRaf.current = requestAnimationFrame(step); }; riseRaf.current = requestAnimationFrame(step); };
    setTimeout(() => m.once("moveend", start), 60); };
  // A pin for each place, shown when you are zoomed out. Press one to fly down to it.
  const pins = useRef([]);
  useEffect(() => {
    const m = map.current; pins.current.forEach((k) => k.remove()); pins.current = [];
    if (!m || !ready) return;
    sites.forEach((st) => { const el = document.createElement("button"); el.className = "sitepin" + (st.id === siteId ? " here" : ""); el.innerHTML = "<i></i><span></span>"; el.lastChild.textContent = st.short || st.id;
      el.onclick = (e) => { e.stopPropagation(); setTour(null); setPick(null); setSheet("peek"); if (st.id === siteId) setLandTick((v) => v + 1); else setSiteId(st.id); };
      pins.current.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([st.lon, st.lat]).addTo(m)); });
  }, [ready, sites, siteId]);
  useEffect(() => {            // tilt into the terrain and move in close on the focus area; flatten on the way out
    const m = map.current; if (!m || !ready || !meta) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (opt.view3d) {
      if (!m.getSource("dem")) m.addSource("dem", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: "Terrain: Mapzen, AWS Open Data" });
      m.setTerrain({ source: "dem", exaggeration: TERRAIN_X });
      m.dragRotate.enable(); m.touchZoomRotate.enableRotation();
      const f = (meta.event ? null : meta.focus_box) || meta.bbox, cam = m.cameraForBounds([[f[0], f[1]], [f[2], f[3]]], { padding: { top: 90, bottom: 230, left: 30, right: 30 } });
      const z3 = Math.min((cam?.zoom ?? 12) + 0.35, 15.5), latc = (f[1] + f[3]) / 2;
      // how high the camera ends up in this view (metres): the cloud layer is kept above it, so you look along its underside
      camAlt3d.current = Math.cos((77 * Math.PI) / 180) * ((m.getContainer().clientHeight / 2) / Math.tan((36.87 / 2) * Math.PI / 180)) * ((40075016.686 * Math.cos((latc * Math.PI) / 180)) / (512 * 2 ** z3)) + 400;
      zoom3d.current = z3; setCam3d(camAlt3d.current);
      const far = m.getZoom() < 9, to = { center: cam?.center || [(f[0] + f[2]) / 2, (f[1] + f[3]) / 2], zoom: z3, pitch: 77, bearing: -18, essential: true };
      try { m.setMaxPitch(84); } catch (e) {}
      if (!calm) arrive(m);
      if (far && !calm) m.flyTo({ ...to, duration: 5200, curve: 1.3 }); else m.easeTo({ ...to, duration: calm ? 0 : 1800 });
    } else {
      m.dragRotate.disable(); m.touchZoomRotate.disableRotation(); m.setTerrain(null);
      const far = m.getZoom() < 9;
      if (far && !calm) { arrive(m); fitSite(4800); }
      else { m.easeTo({ pitch: 0, bearing: 0, duration: calm ? 0 : 900, essential: true }); setTimeout(() => fitSite(calm ? 0 : 900), calm ? 0 : 950); }
    }
  }, [opt.view3d, ready, meta?.id, landTick]);
  // Clouds in 3D: how many depends on NASA's daily cloud cover for the selected date. Sizes and heights are set
  // relative to the site (bases about 260 to 600 m up, a low marine-layer height that stays below the close camera, stretched like the land), so they sit in scale with the terrain.
  const cloudPct = useMemo(() => {
    if (!ctx?.cloud || !layer) return null;
    const d = layer.static ? (meta?.event ? null : null) : layer.dates[t], k = d ? ctx.cloud.dates.indexOf(d) : -1;
    return k >= 0 ? ctx.cloud.pct[k] : null;
  }, [ctx, layerKey, t, meta]);
  // Clouds in 3D are one continuous layer high over the site, drawn as a flat sheet with a cloud pattern.
  // How much of the sheet is cloud: NASA's daily cloud cover. Which way it drifts: NASA's daily wind direction, sped up.
  // From the close 3D camera you look along the underside of the layer towards the skyline.
  const cloudData = useRef({ on: false });
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let d = { on: false };
    if (opt.view3d && meta) {                        // sky and haze are always drawn in 3D; cloud only when it is switched on and NASA has a figure for the date
      const showCloud = opt.clouds && cloudPct !== null;
      const [w, s, e, n] = meta.bbox, lon0 = (w + e) / 2, lat0 = (s + n) / 2, day = layer.dates?.[t] || "0";
      const seed = [...day].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
      const k = ctx?.wind ? ctx.wind.dates.indexOf(day) : -1; let vx = 0, vy = 0;
      if (k >= 0 && !calm) { const to = ((ctx.wind.dir[k] + 180) * Math.PI) / 180, sp = (Math.max(1, ctx.wind.speed[k]) * CLOUD_SPEEDUP) / 1000;   // "dir" is where the wind comes from; km per second
        vx = Math.sin(to) * sp; vy = Math.cos(to) * sp; }
      d = { on: true, lon0, lat0, alt: Math.max(CLOUD_BASE_M * TERRAIN_X, camAlt3d.current * 1.3), cover: showCloud ? cloudPct / 100 : -1, ox: (seed % 977) * 1.7, oy: (seed % 619) * 2.3, vx, vy, t0: performance.now() };
    }
    cloudData.current = d;
    if (typeof window !== "undefined") { window.__sarvisClouds = d.on ? d.cover : null; window.__sarvisCloudD = d; }
    if (!m.getLayer("clouds")) m.addLayer({ id: "clouds", type: "custom", renderingMode: "2d",
      onAdd(_, gl) {
        const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
        const pr = gl.createProgram();
        gl.attachShader(pr, sh(gl.VERTEX_SHADER, `attribute vec3 a_pos; attribute vec2 a_km; uniform mat4 u_m; uniform float u_ground; varying vec2 v_km;
          uniform vec3 u_ctr;
          void main() { float wide = u_ground > 1.5 ? 20.0 : 1.0; v_km = a_km * wide;     /* only the far sky is stretched */
            vec3 q = vec3(u_ctr.xy + (a_pos.xy - u_ctr.xy) * wide, u_ground > 1.5 ? a_pos.z * 30.0 : (u_ground > 0.5 ? 0.0 : a_pos.z));
            vec4 p = u_m * vec4(q, 1.0); p.z = (u_ground > 1.5 ? 0.9999 : 0.9995) * p.w;
            gl_Position = p; }`));     // pinned to the far depth: land and columns stay in front
        gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `precision highp float; varying vec2 v_km; uniform vec2 u_off; uniform float u_cover; uniform float u_below; uniform float u_ground; uniform vec2 u_cam; uniform float u_reach;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
          float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
          void main() { vec2 rel = v_km - u_cam; float dist = length(rel);
            // Lay the pattern out by viewing angle, like a dome overhead, so clouds keep their shape towards the horizon instead of smearing into lines.
            float ang = atan(dist / max(u_reach, 0.05));                                  // 0 straight up, about 1.57 at the horizon
            vec2 p = rel / max(dist, 0.001) * ang * 9.0 + u_off * 0.04;
            p += 0.8 * vec2(fbm(p * 0.6 + 3.1), fbm(p * 0.6 + 11.7)) - 0.4;                 // bend the pattern so billows curl instead of lining up
            float n = fbm(p);
            float th = 0.62 - 0.36 * u_cover;                                             // more cover -> lower bar -> more of the sheet is cloud
            float d = smoothstep(th, th + 0.26, n), thick = smoothstep(th + 0.1, th + 0.5, n);
            float lit = fbm(p * 2.2 + 70.0);                                              // gentle light and shade inside the cloud
            vec3 col = mix(vec3(1.0, 0.99, 0.97), vec3(0.64, 0.69, 0.77), thick * (0.55 + 0.45 * lit));
            float a = d * (1.0 - smoothstep(1.47, 1.56, ang)) * mix(0.36, 0.94, u_below);       // seen from above it stays thin so the data is readable; it melts into the horizon
            gl_FragColor = vec4(col * a, a); }`));
        gl.linkProgram(pr);
        this.pr = pr; this.buf = gl.createBuffer(); this.vao = gl.createVertexArray ? gl.createVertexArray() : null;   // our own vertex state, so the map's layers are left untouched
        this.loc = { pos: gl.getAttribLocation(pr, "a_pos"), km: gl.getAttribLocation(pr, "a_km"), m: gl.getUniformLocation(pr, "u_m"), off: gl.getUniformLocation(pr, "u_off"), cover: gl.getUniformLocation(pr, "u_cover"), below: gl.getUniformLocation(pr, "u_below"), ground: gl.getUniformLocation(pr, "u_ground"), cam: gl.getUniformLocation(pr, "u_cam"), ctr: gl.getUniformLocation(pr, "u_ctr"), reach: gl.getUniformLocation(pr, "u_reach") };
      },
      render(gl, args) {
        const d = cloudData.current, L = this.loc, mm = map.current; if (!d.on || !mm) return;
        if (mm.getZoom() < GLOBE_ABOVE + 0.2) return;                   // zoomed out, the map is a globe and has its own sky
        const mx = args?.defaultProjectionData?.mainMatrix || args?.modelViewProjectionMatrix || args;
        const c = maplibregl.MercatorCoordinate.fromLngLat([d.lon0, d.lat0], d.alt), u = c.meterInMercatorCoordinateUnits() * 1000;
        // is the camera under the layer (look along its underside) or over it (look down through it)?
        const tr = mm.transform, ppm = (512 * 2 ** mm.getZoom()) / (40075016.686 * Math.cos((mm.getCenter().lat * Math.PI) / 180));      // screen pixels per metre at the map centre
        const camAlt = (Math.cos((mm.getPitch() * Math.PI) / 180) * tr.cameraToCenterDistance) / ppm + (tr.elevation || 0) * TERRAIN_X;
        const below = Math.min(1, Math.max(0, (d.alt - camAlt) / 150)), sec = (performance.now() - d.t0) / 1000;
        // where the camera stands, in km east and north of the site centre: haze thickens with distance from there
        const ctr = mm.getCenter(), br = (mm.getBearing() * Math.PI) / 180, back = (Math.sin((mm.getPitch() * Math.PI) / 180) * tr.cameraToCenterDistance) / ppm / 1000;
        const camE = (ctr.lng - d.lon0) * 111.32 * Math.cos((d.lat0 * Math.PI) / 180) - Math.sin(br) * back, camN = (ctr.lat - d.lat0) * 110.54 - Math.cos(br) * back;
        // The sheets are drawn as rings around the camera, small near it and growing outward to far past the skyline.
        // (One giant square lost the precision the haze distance and the cloud pattern need close to the camera.)
        const SEG = 40, radii = [0]; for (let r = 0.3; r < 3e6; r *= 1.6) radii.push(r);
        const arr = new Float32Array((radii.length - 1) * SEG * 6 * 5); let o = 0;
        const vert = (r, a) => { const x = camE + r * Math.cos(a), y = camN + r * Math.sin(a); arr[o++] = c.x + x * u; arr[o++] = c.y - y * u; arr[o++] = c.z; arr[o++] = x; arr[o++] = y; };
        for (let k = 0; k < radii.length - 1; k++) for (let q = 0; q < SEG; q++) { const a0 = (q / SEG) * 2 * Math.PI, a1 = ((q + 1) / SEG) * 2 * Math.PI;
          vert(radii[k], a0); vert(radii[k + 1], a0); vert(radii[k + 1], a1); vert(radii[k], a0); vert(radii[k + 1], a1); vert(radii[k], a1); }
        const nVert = o / 5;
        gl.useProgram(this.pr); if (this.vao) gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(L.pos); gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(L.km); gl.vertexAttribPointer(L.km, 2, gl.FLOAT, false, 20, 12);
        gl.uniformMatrix4fv(L.m, false, mx); gl.uniform2f(L.off, d.ox - d.vx * sec, d.oy - d.vy * sec); gl.uniform1f(L.cover, d.cover); gl.uniform1f(L.below, below); gl.uniform2f(L.cam, camE, camN); gl.uniform3f(L.ctr, c.x + camE * u, c.y - camN * u, c.z); gl.uniform1f(L.reach, Math.max(0.15, Math.abs(d.alt - camAlt) / 1000));     // haze starts a little past the point the camera looks at, at any zoom
        gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);                                                                               // land and columns stay in front of everything drawn here
        gl.uniform1f(L.ground, 0); gl.drawArrays(gl.TRIANGLES, 0, nVert);                                       // the cloud layer
        if (this.vao) gl.bindVertexArray(null);
      } });            // added last: anything placed lower is painted over when the terrain is drawn
    m.triggerRepaint();
    if (!d.on || (!d.vx && !d.vy)) return;
    let raf = 0, skip = false;                                   // keep the map redrawing (about 30 times a second) while the layer drifts
    const tick = () => { skip = !skip; if (!skip) m.triggerRepaint(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, opt.view3d, opt.clouds, meta, cloudPct, t, ctx, cam3d]);
  useEffect(() => { if (tour && opt.view3d) set({ view3d: false }); }, [tour]);

  // Zoomed far out: stars appear around the Earth, and the camera levels off so the globe sits in the middle of the screen.
  useEffect(() => {
    const m = map.current; if (!m || !ready) return;
    const onZoom = () => { const z = m.getZoom(), el = starsEl.current;
      try { m.setMaxPitch(z < 4.5 ? 0 : z < GLOBE_ABOVE ? ((z - 4.5) / (GLOBE_ABOVE - 4.5)) * 84 : 84); } catch (e) {}
      m.getContainer().closest(".stage")?.classList.toggle("far", z < 9);
      if (el) { const R = (512 * 2 ** z) / (2 * Math.PI);              // the globe's radius on screen, in pixels
        el.style.opacity = Math.max(0, Math.min(1, (5.5 - z) / 1.5));
        el.style.setProperty("--r", `${Math.round(R + 14)}px`); } };
    const onEnd = () => { if (opt.view3d && bars3d && !tour && m.getZoom() >= GLOBE_ABOVE && m.getPitch() < 60 && !m.isMoving()) m.easeTo({ pitch: 77, duration: 900 }); };
    m.on("zoom", onZoom); m.on("zoomend", onEnd); onZoom();
    return () => { m.off("zoom", onZoom); m.off("zoomend", onEnd); };
  }, [ready, opt.view3d, bars3d, tour]);

  // In 3D the camera slowly circles the place. Touching the map pauses it; it picks up again a few seconds after you let go.
  useEffect(() => {
    const m = map.current; if (!m || !ready || !opt.view3d || !opt.orbit || tour || showSettings || pick) return;      // it also holds still while a spot readout is open
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0, held = false, live = true;
    const go = () => { if (!live || held) return; if (m.getZoom() < GLOBE_ABOVE) { later(4000); return; } m.easeTo({ bearing: m.getBearing() + 120, duration: 110000, easing: (x) => x }, { orbit: true }); };      // about 1 degree a second
    const later = (ms) => { clearTimeout(timer); timer = setTimeout(go, ms); };
    const hold = () => { held = true; clearTimeout(timer); }, release = () => { held = false; later(5000); };
    const onEnd = (e) => { if (held) return; if (e.orbit) go(); else later(4000); };
    const el = m.getContainer();
    el.addEventListener("pointerdown", hold); el.addEventListener("wheel", () => { hold(); release(); }, { passive: true }); window.addEventListener("pointerup", release);
    m.on("moveend", onEnd); later(2500);
    return () => { live = false; clearTimeout(timer); m.off("moveend", onEnd); el.removeEventListener("pointerdown", hold); window.removeEventListener("pointerup", release); m.stop(); };
  }, [ready, opt.view3d, opt.orbit, tour, showSettings, siteId, !!pick]);

  // Readout beside the spot you pressed: the numbers resolve out of ones and zeros, like a digital display.
  const readout = useRef(null);
  useEffect(() => {
    const m = map.current; readout.current?.remove(); readout.current = null;
    if (!m || !ready || !meta || !layer || !grid || grid._key !== layer.key || !pick || pick.station || tour) return;
    const idx = pick.j * meta.nx + pick.i; let big, sub, bits;
    if (!layer.static) { const v = valueAt(grid, layer, t, idx);
      big = v === null ? "NO READING" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * uf).toFixed(1)} ${unit}`;
      const word = (ENDS[layer.kind] || ["down", "up"])[v < 0 ? 0 : 1];
      sub = v === null ? "the radar could not follow this spot" : speed ? `moving ${word}, around ${fmtDate(layer.dates[t])}` : `${KEYWORD[word] || `moved ${word}`} from ${fmtDate(layer.dates[0])} to ${fmtDate(layer.dates[t])}`;
      bits = v === null ? null : Math.round(Math.abs(v) * 10); }
    else { const q = grid[idx], none = q === (layer.nodata ?? 255);
      big = none ? "NO READING" : isImpact ? `${Math.round((100 * q) / layer.max)}%` : (q / layer.max).toFixed(2);
      sub = none ? "the radar could not follow this spot" : isImpact ? "of the usual signal lost in the storm pass" : "signal quality, from 0 to 1";
      bits = none ? null : q; }
    const [lon, lat] = pick.at || [pick.lon, pick.lat], pt = m.project([lon, lat]), W = m.getContainer().clientWidth;
    const el = document.createElement("div"); el.className = "readout"; el.onclick = (e) => e.stopPropagation();
    const row = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; el.appendChild(d); return d; };
    row("rd-top", `SPOT  ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`);
    const bigEl = row("rd-big", big), subEl = row("rd-sub", sub);
    const bitEl = row("rd-bits", bits === null ? "" : `${bits.toString(2).padStart(12, "0")} = ${bits}${layer.static ? "" : " mm"}`);
    const btns = document.createElement("div"); btns.className = "rd-btns"; el.appendChild(btns);
    const btn = (text, fn) => { const b = document.createElement("button"); b.textContent = text; b.onclick = (e) => { e.stopPropagation(); fn(); }; btns.appendChild(b); };
    btn("History", () => { setTab("spot"); setSheet("half"); }); btn("Close", () => setPick(null));
    // the characters start as ones and zeros and settle left to right into the real text
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || readoutFor.current === `${pick.i},${pick.j}`;
    readoutFor.current = `${pick.i},${pick.j}`;
    let raf = 0;
    if (!still) { const targets = [[bigEl, big], [subEl, sub]], t0 = performance.now(), dur = 1500;
      const tick = (now) => { const f = Math.min(1, (now - t0) / dur);
        for (const [node, text] of targets) { const done = Math.floor(f * text.length); let out = text.slice(0, done);
          for (let k = done; k < text.length; k++) out += text[k] === " " ? " " : Math.random() < 0.5 ? "0" : "1";
          node.textContent = out; }
        if (f < 1) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick); }
    const holder = document.createElement("div"); holder.appendChild(el);      // the holder is positioned; the card inside does its own entrance
    // The card rides on the map beside the spot, on whichever side has room, and is kept clear of the top bar and the footer.
    // (The camera holds still while it is open, so it stays in view.) On a phone it is a smaller card.
    const H = m.getContainer().clientHeight, small = W <= 800, cardW = small ? 172 : 250;
    const side = pt.x + 14 + cardW > W - 6 ? "right" : pt.x - 14 - cardW < 6 ? "left" : pt.x > W / 2 ? "right" : "left";
    const vert = pt.y < 190 ? "top-" : pt.y > H - (small ? 330 : 260) ? "bottom-" : "";
    holder.className = "readout-at" + (small ? " small" : "");
    readout.current = new maplibregl.Marker({ element: holder, anchor: vert + side, offset: [side === "right" ? -14 : 14, vert === "top-" ? 10 : vert ? -10 : 0] }).setLngLat([lon, lat]).addTo(m);
    return () => cancelAnimationFrame(raf);
  }, [ready, meta, layerKey, grid, pick, t, mode, opt.inches, tour]);
  useEffect(() => () => { readout.current?.remove(); }, []);

  // Soft value labels on the map: walk outward from the biggest change in three directions and
  // drop a number wherever the surface crosses one of the contour levels.
  const valMarks = useRef([]);
  useEffect(() => {
    valMarks.current.forEach((k) => k.remove()); valMarks.current = [];
    const m = map.current;
    if (!m || !ready || !meta || !grid || !layer || layer.static || grid._key !== layer.key || !hot || !opt.labels || opt.view3d) return;
    const [w, s, e, n] = meta.bbox, { nx, ny } = meta, out = [];
    const put = (i, j, text, peak) => { const el = document.createElement("div"); el.className = "vlabel" + (peak ? " peak" : ""); el.textContent = text;
      valMarks.current.push(new maplibregl.Marker({ element: el }).setLngLat([w + ((i + 0.5) / nx) * (e - w), n - ((j + 0.5) / ny) * (n - s)]).addTo(m)); };
    const fmt = (v) => `${v > 0 ? "+" : "−"}${Math.abs(v) >= 10 || Number.isInteger(Math.abs(v)) ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}`;
    for (const ang of [20, 140, 260]) {
      const dx = Math.cos((ang * Math.PI) / 180), dy = Math.sin((ang * Math.PI) / 180);
      let prev = null, last = -99, placed = 0;
      for (let r = 2; r < Math.max(nx, ny) && placed < 3; r++) {
        const i = Math.round(hot.i + dx * r), j = Math.round(hot.j + dy * r); if (i < 0 || j < 0 || i >= nx || j >= ny) break;
        const v = valueAt(grid, layer, t, j * nx + i); if (v === null) { prev = null; continue; }
        const band = Math.floor(v / contourStep);
        if (prev !== null && band !== prev && r - last >= Math.max(6, Math.min(nx, ny) / 14)) {
          const level = Math.max(band, prev) * contourStep;
          if (Math.abs(level) > 1e-9) { out.push([i, j, fmt(Math.round(level * uf * 100) / 100)]); last = r; placed++; }
        }
        prev = band;
      }
    }
    // keep labels apart on screen so they never pile up on a small map
    const px = (i, j) => m.project([w + ((i + 0.5) / nx) * (e - w), n - ((j + 0.5) / ny) * (n - s)]), used = [px(hot.i, hot.j)];
    out.forEach(([i, j, text]) => { const q = px(i, j); if (used.every((u) => Math.hypot(u.x - q.x, u.y - q.y) >= 44)) { used.push(q); put(i, j, text, false); } });
    const pk = valueAt(grid, layer, t, hot.j * nx + hot.i);
    if (pk !== null && Math.abs(pk) >= contourStep / 2 && !(pick && pick.i === hot.i && pick.j === hot.j)) put(hot.i, hot.j, `${fmt(Math.round(pk * uf * 10) / 10)} ${unit}`, true);
  }, [ready, meta, grid, layerKey, t, mode, hot?.i, hot?.j, contourStep, pick?.i, pick?.j, opt.labels, opt.view3d, opt.inches]);

  const cov = ctx?.coverage;
  const SENSORS = [["nisar", "NISAR", "L-band"], ["s1", "Sentinel-1", "C-band"]];
  const KINDS = [["impact", "Storm change"], ["up", "Vertical"], ["east", "East-west"], ["asc_los", "Ascending view"], ["desc_los", "Descending view"], ["coh", "Signal quality"]];
  const ENDS = { up: ["down", "up"], east: ["west", "east"], asc_los: ["away from satellite", "toward satellite"], desc_los: ["away from satellite", "toward satellite"] };
  const sensor = layer?.sensor || "nisar";
  const has = (sn, kd) => meta?.layers.find((l) => (l.sensor || "nisar") === sn && l.kind === kd);
  const choose = (sn, kd) => { const l = has(sn, kd) || meta.layers.find((x) => (x.sensor || "nisar") === sn); if (l) { setPlaying(false); setLayerKey(l.key); } };
  const isImpact = layer?.palette === "impact";
  const pickVal = pick && grid && layer?.static && grid._key === layer.key ? grid[pick.j * meta.nx + pick.i] : null;
  const shown = useCount(cur0(chart, layer, t));
  const kindName = layer ? (KINDS.find((k) => k[0] === layer.kind) || [0, layer.label])[1] : "";
  const ends = layer && ENDS[layer.kind];
  const cur = chart && chart.lines[0].pts.find((p) => p.d === layer.dates[t]);
  const SENS = SENSORS.filter(([k]) => meta?.layers.some((l) => (l.sensor || "nisar") === k));
  const fmtCm = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * uf).toFixed(1)} ${unit}`;

  const TABS = [["found", "Findings"], ["view", "View"], ["spot", "Spot"], ["weather", "Weather"], ["compare", "Compare"], ["about", "About"]].filter(([k]) => k !== "compare" || (meta && !meta.event && (cov || SENS.length > 1)));
  const openTab = (k) => { setTab(k); setSheet((v) => (v === "peek" ? "half" : v)); };
  const grab = useRef(null);
  const onGrabDown = (e) => { const el = sheetEl.current; grab.current = { y: e.clientY, h: el.offsetHeight, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onGrabMove = (e) => { const g = grab.current; if (!g) return; const d = g.y - e.clientY; if (Math.abs(d) > 4) g.moved = true; if (g.moved) setDragH(Math.max(120, Math.min(window.innerHeight * 0.92, g.h + d))); };
  const onGrabUp = () => {
    const g = grab.current; grab.current = null; if (!g) return;
    if (!g.moved) { setSheet((v) => (v === "peek" ? "half" : v === "half" ? "full" : "peek")); return; }
    const h = sheetEl.current.offsetHeight, vh = window.innerHeight, snaps = [["peek", PEEK], ["half", vh * 0.52], ["full", vh * 0.88]];
    setSheet(snaps.reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0]); setDragH(null);
  };

  return (
    <div className="stage" style={{ "--sheet-h": dragH !== null ? `${dragH}px` : sheet === "peek" ? `${PEEK}px` : sheet === "half" ? "52dvh" : "88dvh" }} onClick={(e) => { if (siteMenu && !e.target.closest(".sitepick")) setSiteMenu(false); }}>
      <div className="map"><div ref={mapDiv} /></div>
      <div className="stars" ref={starsEl} aria-hidden="true" />
      <div className="topbar">
        <div className="sitepick">
          <button className="brandchip" aria-haspopup="listbox" aria-expanded={siteMenu} onClick={() => setSiteMenu((v) => !v)}>{meta ? meta.short : "Loading"}<span className="caret" aria-hidden="true" /></button>
          {siteMenu && (
            <div className="sitemenu" role="listbox" aria-label="Choose a place">
              {sites.map((st) => <button key={st.id} role="option" aria-selected={st.id === siteId} className={st.id === siteId ? "on" : ""} onClick={() => { setSiteMenu(false); setTour(null); setSiteId(st.id); }}>{st.short || st.id}</button>)}
            </div>)}
        </div>
        <div className="topbtns">
          {meta && layer && (
            <div className="seg dim" aria-label="Flat map or 3D">
              <button className={!opt.view3d ? "on" : ""} aria-pressed={!opt.view3d} onClick={() => set({ view3d: false })}>2D</button>
              <button className={opt.view3d ? "on" : ""} aria-pressed={opt.view3d} disabled={!bars3d} onClick={() => { setTour(null); set({ view3d: true }); }}>3D</button>
            </div>)}
          {meta && layer && <button className="ghost wide" onClick={() => { setTour(null); setTab("found"); setSheet("full"); }}>What we found</button>}
          {meta && layer && <button className="cta" onClick={() => setTour({ i: 0, auto: false })}>Tour</button>}
          <button className="ghost" aria-expanded={showSettings} onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </div>
      {meta && layer && !step && (
        <div className="key" aria-label="Colour key">
          {!layer.static ? (<>
            <div className="keyends"><span><i style={{ background: "#d0303a" }} />{KEYWORD[ends?.[0]] || ends?.[0] || "sank"}</span><span>{KEYWORD[ends?.[1]] || ends?.[1] || "rose"}<i style={{ background: "#2f6fd6" }} /></span></div>
            <div className="ramp" style={{ background: `linear-gradient(90deg, ${css([...RAMP.neg].reverse().map(([t, c]) => [(1 - t) / 2, c]))}, rgba(120,120,116,0.25) 50%, ${css(RAMP.pos.map(([t, c]) => [0.5 + t / 2, c]))})` }} />
            <div className="keyends num"><span>−{(lim * uf).toFixed(1)} {unit}</span><span>0</span><span>+{(lim * uf).toFixed(1)} {unit}</span></div>
          </>) : isImpact ? (<>
            <div className="keyends"><span>no change</span><span>changed</span></div>
            <div className="ramp" style={{ background: `linear-gradient(90deg, rgba(246,200,216,0.08), ${css(RAMP.impact)})` }} />
            <div className="keyends num"><span>0%</span><span>{Math.round(100 * IMPACT_TOP)}% of signal lost, or more</span></div>
          </>) : (<>
            <div className="keyends"><span>signal lost</span><span>stable signal</span></div>
            <div className="ramp" style={{ background: "linear-gradient(90deg, rgb(20,24,32), rgb(150,200,255))" }} />
            <div className="keyends num"><span>0</span><span>1</span></div>
          </>)}
        </div>)}
      {meta?.synthetic && <div className="demochip"><b>Demo data.</b> Radar layers are synthetic.</div>}
      {meta && layer && !pick && grid && !step && sheet === "peek" && <div className="hint">Tap the map to read one spot</div>}
      {showSettings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="card settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <div className="shead"><h2>SARvis <span className="muted" style={{ fontWeight: 400 }}>settings</span></h2><button className="ghost small" onClick={() => setShowSettings(false)}>Done</button></div>
            <h3>On the map</h3>
            <Toggle label="Smooth shading" hint="Off shows the raw pixels. In the Central Valley, on also fills pinholes for display" on={opt.smooth} onChange={(v) => set({ smooth: v })} />
            <Toggle label="Contour lines" on={opt.contours} onChange={(v) => set({ contours: v })} />
            <Toggle label="Number labels" on={opt.labels} onChange={(v) => set({ labels: v })} />
            <Toggle label="Reference and focus boxes" on={opt.boxes} onChange={(v) => set({ boxes: v })} />
            <Toggle label="GPS stations" on={opt.stations} onChange={(v) => set({ stations: v })} />
            <h3>3D</h3>
            <Toggle label="Clouds" hint="A cloud layer over the site. Cover and drift direction follow NASA's daily figures; drift is sped up 12 times" on={opt.clouds} onChange={(v) => set({ clouds: v })} />
            <Toggle label="Circle overhead" hint="The 3D camera slowly circles the place. It pauses while you move the map" on={opt.orbit} onChange={(v) => set({ orbit: v })} />
            <Pick label="Column height" value={opt.tall} onChange={(v) => set({ tall: v })} items={[["low", "Low"], ["medium", "Medium"], ["high", "High"]]} />
            <h3>Numbers and playback</h3>
            <Pick label="Units" value={opt.inches ? "in" : "cm"} onChange={(v) => set({ inches: v === "in" })} items={[["cm", "Centimetres"], ["in", "Inches"]]} />
            <Pick label="Playback speed" value={opt.speed} onChange={(v) => set({ speed: v })} items={[["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]]} />
            <div className="actions">
              <button className="ghost" onClick={copyLink}>{copied ? "Link copied" : "Copy link to this view"}</button>
              <button className="ghost" onClick={() => set({ ...DEFAULTS })}>Reset to defaults</button>
            </div>
          </div>
        </div>
      )}
      <section ref={sheetEl} className={"sheet " + sheet + (dragH !== null ? " dragging" : "")} style={dragH !== null ? { height: dragH } : undefined} aria-label="Controls and details">
        <div className="grab" role="button" tabIndex={0} aria-label="Drag up for more, or press to expand" onPointerDown={onGrabDown} onPointerMove={onGrabMove} onPointerUp={onGrabUp} onPointerCancel={onGrabUp}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet((v) => (v === "peek" ? "half" : v === "half" ? "full" : "peek")); } }}><i /></div>
        {meta && layer && (
          <div className="timebar" id="timebar">
            {!layer.static ? (<>
              <div className="trow">
                <button className="play" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>{playing ? "❚❚" : "▶"}</button>
                <div className="tdate"><span className="muted">{speed ? "speed around" : `since ${fmtDate(layer.dates[0])}`}</span><b>{fmtDate(layer.dates[t])}</b></div>
                <input aria-label="Date" type="range" min={0} max={layer.dates.length - 1} value={t} onChange={(e) => { setPlaying(false); setT(+e.target.value); }} />
              </div>
              <div className="row cap"><span>{opt.view3d && bars3d ? `column: 1 ${un} of change = ${Math.round((mPerCm / uf) * 10) / 10} m · land height ×${TERRAIN_X}${opt.clouds && cloudPct !== null ? ` · sky ${Math.round(cloudPct)}% cloud that day` : ""}` : `${opt.contours ? `lines every ${Math.round(contourStep * uf * 100) / 100} ${unit} · ` : ""}see-through = no reading`}</span></div>
            </>) : isImpact ? (<>
              <div className="trow one"><div className="tdate"><span className="muted">before and after</span><b>{meta.event?.name || "Event"}</b></div></div>
              <div className="row cap"><span>see-through = no reading</span></div>
            </>) : (<>
              <div className="row cap"><span>how well the radar could follow the ground, averaged over all passes</span></div>
            </>)}
          </div>
        )}
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map(([k, name]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k && sheet !== "peek" ? "on" : ""} onClick={() => openTab(k)}>{name}</button>)}
        </nav>
        <div className="sheetbody" ref={bodyEl}>
        {step && (
          <div className="tour" role="region" aria-label="Guided tour">
            <div className="tourtop">
              <div className="dots" aria-label={`Step ${tour.i + 1} of ${steps.length}`}>{steps.map((_, k) => <i key={k} className={k === tour.i ? "on" : k < tour.i ? "done" : ""} />)}</div>
              <label className="auto"><input type="checkbox" checked={tour.auto} onChange={(e) => setTour({ ...tour, auto: e.target.checked })} /> Auto-advance</label>
            </div>
            <div className="tourbody" key={tour.i}>
              <h3><span className="ticon" aria-hidden="true">{tour.i + 1}</span>{step.title}</h3>
              <p>{step.say({ hot, layer, cov, share: hot?.share ?? null, stat: chart?.stat })}</p>
              {step.glow && <div className="cue">{step.glow === "weather" ? "See the weather charts" : step.glow === "coverage" ? "See the comparison numbers" : step.glow === "timebar" ? "Watch the timeline above" : "See the chart"}{step.glow === "timebar" ? "" : " highlighted below"}</div>}
            </div>
            {tour.auto && <div className="tourbar" key={`b${tour.i}`}><i /></div>}
            <div className="tourbtns">
              <button className="ghost" disabled={tour.i === 0} onClick={() => setTour({ ...tour, i: tour.i - 1 })}>Back</button>
              {tour.i < steps.length - 1 ? <button className="cta" onClick={() => setTour({ ...tour, i: tour.i + 1 })}>Next </button> : <button className="cta" onClick={() => setTour(null)}>Finish </button>}
              <button className="ghost" onClick={() => setTour(null)}>Exit</button>
            </div>
          </div>
        )}
        {meta && layer && tab === "view" && (
          <div className="pane viewpane" key={"view" + meta.id}>
          <div>
            <label>Sensor</label>
            <div className="seg">
              {SENS.map(([k, name, band]) => (
                <button key={k} className={sensor === k ? "on" : ""} aria-pressed={sensor === k} onClick={() => choose(k, layer.kind)}><i style={{ background: C[k] }} />{name} <small>{band}</small></button>))}
            </div>
          </div>
          <div>
            <label>Measurement</label>
            <div className="chips">
              {KINDS.filter(([k]) => has(sensor, k)).map(([k, name]) => <button key={k} className={layer.kind === k ? "on" : ""} aria-pressed={layer.kind === k} onClick={() => choose(sensor, k)}>{name}</button>)}
            </div>
            {meta.dropped && <p className="muted" style={{ margin: "8px 0 0" }}>{meta.dropped}</p>}
          </div>
            <div className="two">
          {!layer.static && (
            <div className="seg" aria-label="Show">
              <button className={!speed ? "on" : ""} aria-pressed={!speed} onClick={() => setMode("total")}>Total change</button>
              <button className={speed ? "on" : ""} aria-pressed={speed} onClick={() => setMode("speed")}>Speed</button>
            </div>
          )}
              <label className="strength"><span>Colour strength <b>{Math.round(opt.strength * 100)}%</b></span>
                <input type="range" min="20" max="100" step="2" value={Math.round(opt.strength * 100)} onChange={(e) => set({ strength: +e.target.value / 100 })} aria-label="How strongly the radar colours cover the map" /></label>
              <div className="seg" aria-label="Background">
                <button className={base === "sat" ? "on" : ""} aria-pressed={base === "sat"} onClick={() => setBase("sat")}>Satellite</button>
                <button className={base === "dark" ? "on" : ""} aria-pressed={base === "dark"} onClick={() => setBase("dark")}>Map</button>
              </div>
            </div>
          </div>
        )}
        {meta && layer && tab === "spot" && (
          <div className="pane grid" key="spot">
            <div className="col">
          {hot && (
            <button className="finding" onClick={() => { setPick({ i: hot.i, j: hot.j, lon: hot.lon, lat: hot.lat }); setTab("spot"); }}>
              <span>{isImpact
                ? <><b>{Math.round(100 * hot.share)}%</b> of the focus area lost more than 30% of its usual radar signal across the storm. Strongest spot: <b>{Math.round(100 * hot.v)}%</b>.</>
                : <>Biggest change in the focus area: <b>{`${hot.v > 0 ? "+" : "−"}${Math.abs(hot.v * uf).toFixed(1)} ${un}`}</b>{ends ? ` ${hot.v >= 0 ? ends[1] : ends[0]}` : ""} since {fmtDate(layer.dates[0])}.</>}
                <small> Tap to see that spot.</small></span>
            </button>
          )}
          <div className="card" id="pickcard" ref={cardRef}>
            <h2>{pick ? (pick.station ? `Ground check at station ${pick.station}` : `Spot at ${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}`) : "Pick a spot"}</h2>
            <p className="muted" style={{ margin: "0 0 8px" }}>{layer.static ? (pick ? "Radar signal quality for each pair of passes (1 = surface unchanged, 0 = changed completely)." : "Tap the map to see how the radar signal held up at that spot.") : pick ? `${kindName} ${speed ? `speed, ${un} per month` : `motion, ${un}`}` : "Tap the map, or a labelled GPS station, to see how that spot moved."}</p>
            {isImpact && pickVal !== null && <div className="hero" key={`${pick.i}-${pick.j}`}>{pickVal === layer.nodata ? "No reading" : `${Math.round((100 * pickVal) / layer.max)}%`}<small> {pickVal === layer.nodata ? "here (water, or never a stable signal)" : "of the usual signal lost across the storm"}</small></div>}
            {sigChart && <Chart key={`s${pick.i}-${pick.j}`} lines={sigChart.lines} markX={null} eventX={eventX} eventLabel={meta.event?.name} domain={[0, 1]} unit="" />}
            {cur && cur.y !== null && <div className="hero" key={`${pick.i}-${pick.j}-${mode}`}>{fmtCm(shown ?? cur.y)}<small> {ends ? (cur.y >= 0 ? ends[1] : ends[0]) : ""} {speed ? "around" : "by"} {fmtDate(layer.dates[t])}</small></div>}
            {chart && <Chart key={`m${pick.i}-${pick.j}-${layerKey}-${mode}`} k={uf} lines={chart.lines} markX={toDay(layer.dates[t])} eventX={eventX} eventLabel={meta.event?.name} />}
            {meta.tied_to && <p className="muted" style={{ margin: "8px 0 0" }}><b style={{ color: "var(--ink)" }}>Pinned to GPS station {meta.tied_to}.</b> {meta.tie_note} A close match at that station is by design, not a test.</p>}
            {chart?.stat && <p className="muted" style={{ margin: "8px 0 0" }}>Radar minus GPS, root-mean-square: <b style={{ color: "var(--ink)" }}>{(chart.stat.rms * uf).toFixed(2)} {un}</b> over {chart.stat.n} dates{ctx.gnss.ref ? ` (GPS relative to station ${ctx.gnss.ref})` : " (GPS not referenced; compare vertical only)"}.</p>}
          </div>
            </div>
            <div className="col">
          {sliceOk && (
            <div className="card" id="slice">
              <h2>Slice through this spot</h2>
              <p className="muted" style={{ margin: "0 0 8px" }}>Ground height along the white line on the map, with the surface coloured by the change measured there. The radar sees the surface only; nothing below it is measured.</p>
              <div className="seg" style={{ marginBottom: 10 }}>
                <button className={sliceDir === "ns" ? "on" : ""} aria-pressed={sliceDir === "ns"} onClick={() => setSliceDir("ns")}>North to south</button>
                <button className={sliceDir === "we" ? "on" : ""} aria-pressed={sliceDir === "we"} onClick={() => setSliceDir("we")}>West to east</button>
              </div>
              {!slice ? <p className="muted">Loading terrain…</p> : slice.error ? <p className="muted">Terrain heights could not be loaded.</p>
                : <SliceChart slice={slice} color={layer.static ? (v) => `rgb(${ramp(RAMP.impact, Math.min(1, v / IMPACT_TOP))})` : (v) => colorCss(v / lim)} unit={layer.static ? "" : unit} k={layer.static ? 1 : uf} isShare={!!layer.static} />}
            </div>
          )}
            </div>
          </div>
        )}
        {meta && layer && tab === "weather" && (
          <div className="pane grid" key="weather">
          {rain && rain.pts.length > 0 && (
            <div className="card" id="weather">
              <h2>Daily rainfall, mm</h2>
              <p className="muted" style={{ margin: "0 0 8px" }}>Regional estimate at the site centre.</p>
              <Bars pts={rain.pts} x0={rain.x0} x1={rain.x1} markX={layer.static ? null : toDay(layer.dates[t])} eventX={eventX} />
              <p className="muted" style={{ margin: "6px 0 0" }}>{ctx.rain.source}</p>
            </div>
          )}
          {wind && wind.pts.length > 0 && (
            <div className="card">
              <h2>Strongest daily wind, m/s</h2>
              <p className="muted" style={{ margin: "0 0 8px" }}>Regional model estimate at the site centre, 10 m above ground.{meta.event ? " A coarse model like this smooths out a hurricane's core, so it reads far below the peak winds reported at landfall." : ""}</p>
              {windNow && (
                <div className="windnow">
                  <svg viewBox="-20 -20 40 40" width="44" height="44" role="img" aria-label={`Wind from ${compass(windNow.dir)}`}>
                    <circle r="18" fill="none" stroke="#383835" strokeWidth="1.5" /><text y="-9" textAnchor="middle" style={{ fontSize: 7 }}>N</text>
                    <g transform={`rotate(${windNow.dir + 180})`}><path d="M0,-13 L5,-3 L1.5,-3 L1.5,12 L-1.5,12 L-1.5,-3 L-5,-3 Z" fill="#f0efec" /></g>
                  </svg>
                  <div><b>{windNow.y.toFixed(1)} m/s</b> peak, {windNow.mean.toFixed(1)} average<br /><span className="muted">from the {compass(windNow.dir)} on {fmtDate(windNow.d)}</span></div>
                </div>
              )}
              <Bars pts={wind.pts} x0={wind.x0} x1={wind.x1} markX={layer.static ? null : toDay(layer.dates[t])} eventX={eventX} unit="m/s" label="Daily peak wind" />
              <p className="muted" style={{ margin: "6px 0 0" }}>{ctx.wind.source}</p>
              {meta.event && <p className="muted" style={{ margin: "6px 0 0" }}>These wind figures come from a global weather model that averages over an area roughly 50 km across, so they show when the storm passed, not how hard it blew at the coast. {meta.event.note}</p>}
            </div>
          )}
          </div>
        )}
        {meta && layer && tab === "compare" && (
          <div className="pane grid" key="compare">
          {cov && !meta.event && (
            <div className="card" id="coverage">
              <h2>How often each radar got a reading in the focus area</h2>
              <p className="muted" style={{ margin: "0 0 10px" }}>Average share of passes with a usable measurement inside the yellow box{cov.window ? `, ${fmtDate(cov.window[0])} to ${fmtDate(cov.window[1])} (the weeks both radars cover)` : ""}.</p>
              <div className="tiles">
                {SENS.map(([k, name, band]) => (
                  <div key={k} className="tile"><span className="swatch" style={{ background: C[k] }} /><span className="muted">{name} ({band})</span>
                    <div className="big">{pct(cov[k]?.asc)} <small>ascending</small> · {pct(cov[k]?.desc)} <small>descending</small></div></div>))}
              </div>
            </div>
          )}
          {wl && SENS.length > 1 && (
            <div className="card">
              <h2>Why the two radars can disagree</h2>
              <p className="muted" style={{ margin: "0 0 10px" }}>A radar loses track when neighbouring pixels move apart by more than a quarter of its wavelength between two passes.</p>
              <div className="tiles">
                {SENS.map(([k, name, band]) => (
                  <div key={k} className="tile">
                    <span className="swatch" style={{ background: C[k] }} /><span className="muted">{name} ({band}), {wl[k].toFixed(1)} cm wavelength</span>
                    <div className="meter"><i style={{ width: `${(100 * wl[k]) / Math.max(wl.nisar, wl.s1)}%`, background: C[k] }} /></div>
                    <div className="big">{(wl[k] / 4).toFixed(1)} cm <small>largest step it can follow</small></div>
                  </div>))}
              </div>
            </div>
          )}
          <div className="card" id="bands">
            <h2>Radar bands, longest wavelength first</h2>
            <p className="muted" style={{ margin: "0 0 10px" }}>Two of these are measured on this map. The other three are shown for scale only: their public data does not cover these sites.</p>
            <div className="bands">
              {BANDS.map((b) => { const cm = b.key === "L" ? (wl?.nisar ?? b.cm) : b.key === "C" ? (wl?.s1 ?? b.cm) : b.cm, on = b.key === "L" || (b.key === "C" && SENS.length > 1);
                return (
                  <div key={b.key} className="band">
                    <div className="bandhead"><span className="swatch" style={{ background: b.color }} /><b>{b.key}-band</b><span className="muted">{b.who}</span><span className={`chip ${on ? "on" : ""}`}>{on ? "on this map" : "not on this map"}</span></div>
                    <div className="meter"><i style={{ width: `max(3px, ${(100 * cm) / BANDS[0].cm}%)`, background: b.color }} /></div>
                    <div className="bandfoot"><span className="num">{b.approx ? `about ${Math.round(cm)}` : cm.toFixed(1)} cm</span><span className="muted">{b.note}</span></div>
                  </div>); })}
            </div>
            <p className="muted" style={{ margin: "10px 0 0" }}>Longer waves pass through plants and follow bigger ground movements. Shorter waves show finer detail but lose track of fast motion sooner. P, X and Ka wavelengths are worked out from each band's frequency range.</p>
          </div>
          </div>
        )}
        {meta && layer && tab === "found" && !step && (
          <div className="pane" id="found">
            {!found ? <p className="muted">Loading the findings.</p> : (<>
              <p className="overall">{found.overall}</p>
              <div className="found">
                {sites.filter((st) => found.sites[st.id]).map((st) => { const f = found.sites[st.id]; return (
                  <div key={st.id} className={"card finding" + (st.id === siteId ? " here" : "")}>
                    <h2>{f.place}</h2>
                    <div className="hero">{f.big}</div>
                    <div className="muted heronote">{f.big_note}</div>
                    <p className="conclusion">{f.conclusion}</p>
                    <ul>{f.points.map((x, k) => <li key={k}>{x}</li>)}</ul>
                    <p className="sure"><b>How sure:</b> {f.sure}</p>
                    <button className="ghost" onClick={() => { if (st.id !== siteId) setSiteId(st.id); setSheet("peek"); }}>{st.id === siteId ? "Back to the map" : "Show me"}</button>
                  </div>); })}
              </div>
              <p className="muted" style={{ margin: "12px 0 0" }}>Worked out from the data files on {found.generated} by <code>pipeline/findings.py</code>. Nothing here is typed in by hand.</p>
            </>)}
          </div>
        )}
        {meta && layer && tab === "about" && (
          <div className="pane" key="about">
            {meta.backdrop_credit && <div className="card"><h2>Background picture here</h2><p className="muted" style={{ margin: 0 }}>{meta.backdrop_credit}</p></div>}
        {meta && (
          <div className="story" key={meta.id}>
            <div><b>{meta.name}</b><p>{meta.story}</p>{meta.event && <p className="muted">{meta.event.name}, {meta.event.when}. {meta.event.note}</p>}</div>
          </div>
        )}
          <details className="card" open={notesOpen} onToggle={(e) => setNotesOpen(e.currentTarget.open)}>
            <summary>How to read this</summary>
            <ul className="notes">
              <li>Each pixel is about 80 m. Motion is relative to the white dashed reference area, which is assumed stable. The yellow dashed box is the focus area used for the coverage numbers.</li>
              <li>The radar sees motion toward or away from the satellite. Only about {Math.round(100 * Math.abs(meta.los?.asc?.n ?? 0.2))}% of north-south motion shows up, so vertical and east-west values absorb some of it.</li>
              <li>A pixel may miss up to a quarter of its dates; those gaps are filled at its own average rate. Pixels with more gaps are blank.</li>
              {meta.processing?.asc && <li>Processing: ionosphere correction {meta.processing.asc.iono_applied ? "applied" : "not applied"}{meta.processing.asc.deramp ? ", scene-wide tilt removed per pair" : ""}, {meta.processing.asc.pairs} ascending and {meta.processing.desc?.pairs ?? 0} descending pairs.</li>}
              <li>Sentinel-1 values are OPERA DISP-S1 at 30 m, sampled onto the NISAR grid. The two sensors use different dates.</li>
              {meta.event && <li>Storm change compares the pair of passes that brackets the storm with the calm pairs before it, and keeps only change seen from both directions. It shows where the surface changed, not confirmed damage: tides, crops and wet soil also lower the signal.</li>}
              <li>Source: {meta.source}, provisional products, not yet fully validated by NASA.</li>
            </ul>
          </details>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}

function Pick({ label, value, onChange, items }) {
  return (<div className="srow"><span className="slabel">{label}</span>
    <div className="seg mini">{items.map(([k, name]) => <button key={k} className={value === k ? "on" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>{name}</button>)}</div></div>);
}
function Toggle({ label, hint, on, onChange }) {
  return (<label className="srow toggle"><span className="slabel">{label}{hint && <small>{hint}</small>}</span>
    <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} /></label>);
}
const cur0 = (chart, layer, t) => { const p = chart && layer && !layer.static ? chart.lines[0].pts.find((q) => q.d === layer.dates[t]) : null; return p && p.y !== null ? p.y : null; };
function useCount(target) {          // ease the headline number toward its new value
  const [v, setV] = useState(target); const from = useRef(target);
  useEffect(() => {
    if (target === null || typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setV(target); from.current = target; return; }
    const a = from.current ?? target, t0 = performance.now(); let id;
    const step = (now) => { const k = Math.min(1, (now - t0) / 350), e = 1 - Math.pow(1 - k, 3); const x = a + (target - a) * e; setV(x); from.current = x; if (k < 1) id = requestAnimationFrame(step); };
    id = requestAnimationFrame(step); return () => cancelAnimationFrame(id);
  }, [target]);
  return v;
}
// Terrain height from open elevation tiles (Mapzen "terrarium" encoding, hosted on AWS Open Data).
const tileCache = {};
async function elevations(pts, z = 12) {
  const n = 2 ** z, need = {};
  const loc = pts.map(({ lon, lat }) => { const x = ((lon + 180) / 360) * n, y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n; const tx = Math.floor(x), ty = Math.floor(y); need[`${tx}/${ty}`] = [tx, ty]; return [tx, ty, Math.min(255, Math.floor((x - tx) * 256)), Math.min(255, Math.floor((y - ty) * 256))]; });
  await Promise.all(Object.entries(need).map(async ([k, [tx, ty]]) => {
    if (tileCache[k]) return;
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`); if (!r.ok) throw new Error("terrain");
    const bm = await createImageBitmap(await r.blob()), c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bm, 0, 0); tileCache[k] = g.getImageData(0, 0, 256, 256).data;
  }));
  return loc.map(([tx, ty, px, py]) => { const d = tileCache[`${tx}/${ty}`], o = (py * 256 + px) * 4; return d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768; });
}

function SliceChart({ slice, color, unit, isShare, k = 1 }) {
  const [hx, setHx] = useHover();
  const { rows, at, ends } = slice, W = 330, H = 190, m = { l: 40, r: 10, t: 22, b: 26 };
  const x1 = rows[rows.length - 1].km, hs = rows.map((r) => r.h);
  let lo = Math.min(0, ...hs), hi = Math.max(...hs); if (hi - lo < 20) hi = lo + 20;
  const base = lo - (hi - lo) * 0.35;                       // room below the surface for the ground fill
  const sx = (k) => m.l + (k / x1) * (W - m.l - m.r), sy = (h) => m.t + ((hi - h) / (hi - base)) * (H - m.t - m.b);
  const area = `M${sx(0)},${sy(base)} ` + rows.map((r) => `L${sx(r.km).toFixed(1)},${sy(r.h).toFixed(1)}`).join(" ") + ` L${sx(x1)},${sy(base)} Z`;
  const h = hx !== null ? rows.reduce((a, r) => (Math.abs(r.km - hx) < Math.abs(a.km - hx) ? r : a)) : null;
  const onMove = (e) => { const r = e.currentTarget.getBoundingClientRect(); setHx(Math.max(0, Math.min(x1, ((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r)) * x1))); };
  const exag = ((hi - base) / (H - m.t - m.b)) > 0 ? ((x1 * 1000) / (W - m.l - m.r)) / ((hi - base) / (H - m.t - m.b)) : 1;
  const fmtV = (v) => (v === null ? "no reading" : isShare ? `${Math.round(v * 100)}% changed` : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * k).toFixed(1)} ${unit}`);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Terrain slice" onPointerDown={onMove} onPointerMove={onMove} onPointerLeave={() => setHx(null)} style={{ touchAction: "pan-y" }}>
        <defs><linearGradient id="earth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6b5a45" /><stop offset="1" stopColor="#2a241d" /></linearGradient></defs>
        {lo < 0 || Math.min(...hs) <= 1 ? <rect x={m.l} y={sy(0)} width={W - m.l - m.r} height={sy(base) - sy(0)} fill="#16324a" /> : null}
        <path d={area} fill="url(#earth)" />
        {rows.slice(1).map((r, k) => <line key={k} x1={sx(rows[k].km)} y1={sy(rows[k].h)} x2={sx(r.km)} y2={sy(r.h)} stroke={r.v === null ? "#8a8985" : color(r.v)} strokeWidth={r.v === null ? 1.5 : 4.5} strokeLinecap="round" />)}
        <line x1={sx(at)} x2={sx(at)} y1={m.t} y2={H - m.b} stroke="#f0efec" strokeDasharray="3 3" />
        {[hi, lo].map((v) => <text key={v} x={m.l - 6} y={sy(v) + 4} textAnchor="end">{Math.round(v)}</text>)}
        <text x={m.l - 6} y={m.t - 8} textAnchor="end">m</text>
        <text x={m.l} y={H - 8}>{ends[0]}</text><text x={W - m.r} y={H - 8} textAnchor="end">{ends[1]}</text>
        <text x={(W + m.l - m.r) / 2} y={H - 8} textAnchor="middle">{x1.toFixed(1)} km across</text>
        {h && <g><line x1={sx(h.km)} x2={sx(h.km)} y1={m.t} y2={H - m.b} stroke="#f0efec" /><circle cx={sx(h.km)} cy={sy(h.h)} r="4.5" fill={h.v === null ? "#8a8985" : color(h.v)} stroke="#242423" strokeWidth="2" />
          <text x={m.l} y={12} style={{ fill: "#f0efec", fontSize: 11 }}>{h.km.toFixed(1)} km: {Math.round(h.h)} m high, {fmtV(h.v)}</text></g>}
      </svg>
      <p className="muted" style={{ margin: "6px 0 0" }}>Heights are stretched about {exag >= 10 ? Math.round(exag) : exag.toFixed(1)} times so the slope is visible. Elevation: Mapzen terrain tiles on AWS Open Data.</p>
    </div>
  );
}

function useHover() { const [h, setH] = useState(null); return [h, setH]; }

function Chart({ lines, markX, eventX = null, eventLabel = "", domain = null, unit = "", k = 1 }) {
  const [hx, setHx] = useHover();
  const W = 330, H = 200, m = { l: 40, r: 10, t: 24, b: 24 };
  const all = lines.flatMap((l) => l.pts.filter((p) => p.y !== null));
  if (!all.length) return <p className="muted">No valid data here.</p>;
  const x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x));
  let lo = Math.min(0, ...all.map((p) => p.y)), hi = Math.max(0, ...all.map((p) => p.y));
  if (domain) { lo = domain[0]; hi = domain[1]; } else if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r), sy = (y) => m.t + ((hi - y) / (hi - lo)) * (H - m.t - m.b);
  const ticks = (domain ? [domain[0], (domain[0] + domain[1]) / 2, domain[1]] : [lo + pad, 0, hi - pad]).filter((v, k, a) => a.findIndex((u) => Math.abs(u - v) < (hi - lo) * 0.12) === k);
  const dayStr = (x) => new Date(x * 864e5).toISOString().slice(0, 10);
  const onMove = (e) => { const r = e.currentTarget.getBoundingClientRect(); setHx(x0 + ((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r)) * (x1 - x0)); };
  const near = (l) => { const v = l.pts.filter((p) => p.y !== null); if (!v.length || hx === null) return null; const b = v.reduce((a, p) => (Math.abs(p.x - hx) < Math.abs(a.x - hx) ? p : a)); return Math.abs(b.x - hx) <= 12 ? b : null; };
  const tips = hx !== null ? lines.map((l) => [l, near(l)]).filter((t) => t[1]) : [];
  return (
    <div>
      {lines.length > 1 && <div className="legend">{lines.map((l) => <span key={l.id}><i style={{ background: C[l.id] }} />{NAME[l.id]}</span>)}</div>}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Displacement time series" onPointerDown={onMove} onPointerMove={onMove} onPointerLeave={() => setHx(null)} style={{ touchAction: "pan-y" }}>
        {ticks.map((v) => (<g key={v}><line x1={m.l} x2={W - m.r} y1={sy(v)} y2={sy(v)} stroke="#383835" strokeWidth={v === 0 ? 1.5 : 1} /><text x={m.l - 6} y={sy(v) + 4} textAnchor="end">{(v * k).toFixed(1)}</text></g>))}
        <text x={m.l} y={H - 6}>{dayStr(x0)}</text><text x={W - m.r} y={H - 6} textAnchor="end">{dayStr(x1)}</text>
        {markX !== null && markX >= x0 && markX <= x1 && <line x1={sx(markX)} x2={sx(markX)} y1={m.t} y2={H - m.b} stroke="#8a8985" strokeDasharray="3 3" />}
        {eventX !== null && eventX >= x0 && eventX <= x1 && <g><line x1={sx(eventX)} x2={sx(eventX)} y1={m.t} y2={H - m.b} stroke="#eda100" strokeWidth="1.5" /><text x={sx(eventX) + (sx(eventX) > W * 0.6 ? -5 : 5)} y={H - m.b - 5} textAnchor={sx(eventX) > W * 0.6 ? "end" : "start"} style={{ fill: "#eda100" }}>{eventLabel}</text></g>}
        {lines.map((l) => { const v = l.pts.filter((p) => p.y !== null); return <path key={l.id} className="draw" pathLength="1" d={v.map((p, k) => `${k ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("")} fill="none" stroke={C[l.id]} strokeWidth={l.thin ? 1.25 : 2} strokeLinejoin="round" />; })}
        {tips.map(([l, p]) => <circle key={l.id} cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={C[l.id]} stroke="#242423" strokeWidth="2" />)}
        {tips.length > 0 && <text x={m.l} y={12} style={{ fill: "#f0efec", fontSize: 11 }}>{tips.map(([l, p]) => `${lines.length > 1 ? NAME[l.id].split(" ")[0] + " " : ""}${p.d ? fmtDate(p.d) : dayStr(p.x)}: ${(p.y * k).toFixed(2)}`).join("   ")}</text>}
      </svg>
    </div>
  );
}

function Bars({ pts, x0, x1, markX, eventX = null, unit = "mm", label = "Daily rainfall" }) {
  const [hx, setHx] = useHover();
  const W = 330, H = 110, m = { l: 40, r: 10, t: 18, b: 22 };
  const hi = Math.max(1, ...pts.map((p) => p.y)), bw = Math.max(1, (W - m.l - m.r) / (x1 - x0 + 1) - 0.6);
  const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r), sy = (y) => m.t + (1 - y / hi) * (H - m.t - m.b);
  const h = hx !== null ? pts.reduce((a, p) => (Math.abs(p.x - hx) < Math.abs(a.x - hx) ? p : a)) : null;
  const onMove = (e) => { const r = e.currentTarget.getBoundingClientRect(); setHx(x0 + ((((e.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r)) * (x1 - x0)); };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} onPointerDown={onMove} onPointerMove={onMove} onPointerLeave={() => setHx(null)} style={{ touchAction: "pan-y" }}>
      <line x1={m.l} x2={W - m.r} y1={sy(0)} y2={sy(0)} stroke="#383835" strokeWidth="1.5" />
      <line x1={m.l} x2={W - m.r} y1={sy(hi)} y2={sy(hi)} stroke="#383835" />
      <text x={m.l - 6} y={sy(hi) + 4} textAnchor="end">{hi.toFixed(0)}</text><text x={m.l - 6} y={sy(0) + 4} textAnchor="end">0</text>
      <text x={m.l} y={H - 5}>{fmtDate(pts[0].d)}</text><text x={W - m.r} y={H - 5} textAnchor="end">{fmtDate(pts[pts.length - 1].d)}</text>
      {markX !== null && markX >= x0 && markX <= x1 && <line x1={sx(markX)} x2={sx(markX)} y1={m.t} y2={H - m.b} stroke="#8a8985" strokeDasharray="3 3" />}
      {eventX !== null && eventX >= x0 && eventX <= x1 && <line x1={sx(eventX)} x2={sx(eventX)} y1={m.t} y2={H - m.b} stroke="#eda100" strokeWidth="1.5" />}
      {pts.map((p) => <rect key={p.d} x={sx(p.x) - bw / 2} y={sy(p.y)} width={bw} height={sy(0) - sy(p.y)} fill={h && h.d === p.d ? "#9ec5f4" : "#5598e7"} />)}
      {h && <text x={m.l} y={11} style={{ fill: "#f0efec", fontSize: 11 }}>{fmtDate(h.d)}: {h.y.toFixed(1)} {unit}</text>}
    </svg>
  );
}
