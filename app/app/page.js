"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";

// Map colour: blue = positive, red = negative, neutral grey at zero. Coherence uses one hue.
const POS = [59, 130, 214], NEG = [217, 83, 74], MID = [120, 120, 116];
// Chart series colours (fixed by entity): NISAR blue, Sentinel-1 orange, GPS light grey.
const C = { nisar: "#3987e5", s1: "#d95926", gps: "#c3c2b7", asc: "#199e70", desc: "#9085e9" };
const NAME = { nisar: "NISAR (L-band)", s1: "Sentinel-1 (C-band)", gps: "GPS", asc: "Ascending passes", desc: "Descending passes" };
const IMPACT = [213, 81, 129];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const fmtDate = (s) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "");
const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 864e5;
const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const boxLine = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];

export default function Page() {
  const mapDiv = useRef(null), map = useRef(null), canvas = useRef(null), marks = useRef([]);
  const cache = useRef({});
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [layerKey, setLayerKey] = useState(null);
  const [grid, setGrid] = useState(null);
  const [other, setOther] = useState(null);     // same measurement from the other sensor
  const [t, setT] = useState(0);
  const [pick, setPick] = useState(null);       // {i, j, lon, lat, station?}
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState("total");    // "total" = change since first date, "speed" = cm per 30 days between dates
  const [ready, setReady] = useState(false);    // map style loaded (isStyleLoaded() flips false while tiles load, so track it ourselves)
  const cardRef = useRef(null);

  useEffect(() => {
    fetch("data/index.json").then((r) => r.json()).then(async (ids) => {
      const ms = await Promise.all(ids.map((id) => fetch(`data/${id}/meta.json`).then((r) => r.json()).catch(() => ({ id }))));
      const h = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
      want.current = h;
      setSites(ms.map((m, k) => ({ id: ids[k], short: m.short, emoji: m.emoji }))); setSiteId(ids.includes(h.site) ? h.site : ids[0]);
      if (h.mode === "speed") setMode("speed");
    });
  }, []);
  const [sig, setSig] = useState(null);         // per-pass signal quality arrays {asc, desc}
  const [tour, setTour] = useState(null);       // {i, auto} while the guided tour runs
  const [copied, setCopied] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
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
      style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
        layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.8, "raster-brightness-max": 0.75 } }] },
      center: [-118.37, 33.75], zoom: 11, attributionControl: false, dragRotate: false, pitchWithRotate: false,
    });
    map.current.touchZoomRotate.disableRotation();
    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.current.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    map.current.on("load", () => setReady(true));
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
    m.fitBounds([[w, s], [e, n]], { padding: { top: phone ? 48 : 40, bottom: phone ? 120 : 120, left: phone ? 16 : 40, right: phone ? 16 : 40 }, duration: firstFit.current || calm ? 0 : 1600, essential: true });
    firstFit.current = false;
    if (phone) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");   // start collapsed; the (i) button still opens it
    const onClick = (ev) => { const p = toPixel(ev.lngLat.lng, ev.lngLat.lat); if (p) { setPick(p); if (window.innerWidth <= 800) setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50); } };
    m.on("click", onClick);
    const boxes = { type: "FeatureCollection", features: [["#f0efec", meta.ref_box], ["#eda100", meta.focus_box]].filter((b) => b[1])
      .map(([color, b]) => ({ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates: boxLine(b) } })) };
    const draw = () => {
      if (m.getSource("boxes")) m.getSource("boxes").setData(boxes);
      else { m.addSource("boxes", { type: "geojson", data: boxes });
        m.addLayer({ id: "boxes", type: "line", source: "boxes", paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-dasharray": [2, 2] } }); }
    };
    draw();
    return () => m.off("click", onClick);
  }, [meta, ready]);

  // GPS / survey stations as clickable markers
  useEffect(() => {
    marks.current.forEach((k) => k.remove()); marks.current = [];
    if (!meta || !ctx?.gnss || !map.current) return;
    ctx.gnss.stations.forEach((st) => {
      const el = document.createElement("button"); el.className = "station"; el.textContent = st.id; el.title = `${st.kind === "survey" ? "Survey point" : "GPS station"} ${st.id}`;
      el.onclick = (ev) => { ev.stopPropagation(); const p = toPixel(st.lon, st.lat); if (p) setPick({ ...p, station: st.id }); };
      marks.current.push(new maplibregl.Marker({ element: el }).setLngLat([st.lon, st.lat]).addTo(map.current));
    });
  }, [meta, ctx]);

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
  const lim = useMemo(() => {
    if (!layer || layer.static) return 1;
    if (!speed || !grid || grid._key !== layer.key) return Math.max(layer.p98, 0.5);
    const n = meta.nx * meta.ny, v = [];
    for (let k = 1; k < layer.dates.length; k++) for (let p = k % 7; p < n; p += 7) { const x = valueAt(grid, layer, k, p); if (x !== null) v.push(Math.abs(x)); }
    v.sort((a, b) => a - b);
    return Math.max(v[Math.floor(v.length * 0.98)] || 0.5, 0.5);
  }, [layer, grid, speed, meta]);

  useEffect(() => {
    if (!meta || !grid || !layer || !map.current || !ready || grid._key !== layer.key) return;
    const { nx, ny } = meta, c = canvas.current;
    c.width = nx; c.height = ny;
    const g2 = c.getContext("2d"), img = g2.createImageData(nx, ny), off = layer.static ? 0 : t * nx * ny;
    if (off + nx * ny > grid.length) return;
    for (let p = 0; p < nx * ny; p++) {
      let rgb, a = 215;
      if (layer.static && layer.palette === "impact") {
        if (grid[p] === layer.nodata) { a = 0; rgb = MID; } else { const v = grid[p] / layer.max; rgb = IMPACT; a = Math.min(235, 255 * Math.max(0, v - 0.08) * 1.6); }
      } else if (layer.static) rgb = mix([20, 24, 32], [150, 200, 255], grid[p] / 255);
      else {
        const val = valueAt(grid, layer, t, p);
        if (val === null) { a = 0; rgb = MID; }
        else { const v = Math.max(-1, Math.min(1, val / lim)); rgb = v >= 0 ? mix(MID, POS, v) : mix(MID, NEG, -v); a = 30 + 200 * Math.min(1, Math.abs(v) * 2.5); }
      }
      img.data.set([rgb[0], rgb[1], rgb[2], a], p * 4);
    }
    g2.putImageData(img, 0, 0);
    // A canvas source repaints straight from the canvas: no image decode, no aborted loads while scrubbing.
    const [w, s, e, n] = meta.bbox, coords = [[w, n], [e, n], [e, s], [w, s]], m = map.current;
    let src = m.getSource("sar");
    if (src && src._site !== meta.id) { m.removeLayer("sar"); m.removeSource("sar"); src = null; }
    if (!src) {
      m.addSource("sar", { type: "canvas", canvas: c, coordinates: coords, animate: false });
      m.addLayer({ id: "sar", type: "raster", source: "sar", paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } }, m.getLayer("boxes") ? "boxes" : undefined);
      src = m.getSource("sar"); src._site = meta.id;
    }
    src.play(); src.pause(); m.triggerRepaint();
  }, [meta, grid, t, layerKey, ready, mode, lim]);

  const pin = useRef(null);
  useEffect(() => {
    pin.current?.remove(); pin.current = null;
    if (pick && !pick.station && map.current) { const el = document.createElement("div"); el.className = "pin"; pin.current = new maplibregl.Marker({ element: el }).setLngLat([pick.lon, pick.lat]).addTo(map.current); }
  }, [pick]);

  useEffect(() => {
    if (!playing || !layer || layer.static) return;
    const id = setInterval(() => setT((v) => (v + 1) % layer.dates.length), 600);
    return () => clearInterval(id);
  }, [playing, layerKey, meta]);

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

  // Guided tour: each step names the view it wants; an effect moves the app there as data arrives.
  const steps = useMemo(() => {
    if (!meta) return [];
    const hasS1 = meta.layers.some((l) => l.sensor === "s1" && l.kind === "up"), st = ctx?.gnss?.stations?.[0];
    const main = meta.default_layer && meta.layers.find((l) => l.key === meta.default_layer) ? meta.default_layer : "up";
    if (meta.event) return [
      { say: `${meta.story} Pink marks where the ground surface looked different to the radar after the storm than before it.`, layer: main },
      { say: "This is the spot in the yellow box that changed the most. The chart shows the radar signal holding steady through the calm weeks, then dropping across the storm.", layer: main, pick: "hot" },
      { say: "The rain and wind charts below mark the day the storm arrived, so you can line the weather up with the change.", layer: main, pick: "hot", scroll: "weather" },
      { say: "What this cannot tell you: pink means the surface changed, not that something was destroyed. Tides, crops and wet soil also change the signal, and open water gives no reading.", layer: main, notes: true },
    ];
    return [
      { say: `${meta.story} Red is moving down, blue is moving up. Watch it build up pass by pass.`, layer: "up", mode: "total", play: true },
      { say: "This is the spot in the yellow box that moved the most. Every point on the chart is one pass of the satellite, 12 days apart.", layer: "up", mode: "total", pick: "hot" },
      { say: "Speed shows when it moved fastest. Compare the timing with the rainfall chart below.", layer: "up", mode: "speed", pick: "hot" },
      ...(hasS1 ? [{ say: "An older radar, Sentinel-1, looked at the same place with a much shorter wavelength. Blank patches are where it lost track of the ground.", layer: "s1_up", mode: "total" }] : []),
      ...(st ? [{ say: `A check against the ground: GPS station ${st.id} measured the same motion from a fixed antenna. The two should agree closely.`, layer: "up", mode: "total", station: st }] : []),
      { say: "What this cannot see: motion along the north-south direction is mostly invisible to the radar, and these are early products NASA has not finished validating.", layer: "up", mode: "total", notes: true },
    ];
  }, [meta, ctx]);
  const step = tour && steps[tour.i];
  useEffect(() => {
    if (!step || !meta || !layer) return;
    if (layer.key !== step.layer && meta.layers.find((l) => l.key === step.layer)) { setPlaying(false); setLayerKey(step.layer); return; }
    if (step.mode && mode !== step.mode) { setMode(step.mode); return; }
    if (!grid || grid._key !== layer.key) return;
    setPlaying(!!step.play);
    if (!layer.static) setT(step.play ? 0 : layer.dates.length - 1);
    setNotesOpen(!!step.notes);
    if (step.pick === "hot" && hot) setPick({ i: hot.i, j: hot.j, lon: hot.lon, lat: hot.lat });
    else if (step.station) { const p = toPixel(step.station.lon, step.station.lat); if (p) setPick({ ...p, station: step.station.id }); }
    else if (!step.pick) setPick(null);
    if (step.scroll) setTimeout(() => document.getElementById(step.scroll)?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  }, [tour?.i, step, layerKey, grid, mode, hot === null]);
  useEffect(() => {
    if (!tour?.auto) return;
    const id = setTimeout(() => setTour((v) => (v && v.i < steps.length - 1 ? { ...v, i: v.i + 1 } : null)), 8000);
    return () => clearTimeout(id);
  }, [tour, steps.length]);
  useEffect(() => { setTour(null); }, [siteId]);

  const cov = ctx?.coverage;
  const SENSORS = [["nisar", "NISAR", "L-band"], ["s1", "Sentinel-1", "C-band"]];
  const KINDS = [["impact", "Storm change", "🌀"], ["up", "Vertical", "↕️"], ["east", "East-west", "↔️"], ["asc_los", "Ascending view", "↗️"], ["desc_los", "Descending view", "↘️"], ["coh", "Signal quality", "📶"]];
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
  const unit = speed ? "cm/month" : "cm";
  const fmtCm = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} ${unit}`;

  return (
    <div className="shell">
      <div className="map">
        <div ref={mapDiv} />
        {meta && layer && (
          <div className="timebar">
            {!pick && grid && <div className="hint">Tap the map to read one spot</div>}
            {!grid && <div className="hint">Loading…</div>}
            {!layer.static ? (<>
              <div className="trow">
                <button className="play" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>{playing ? "❚❚" : "▶"}</button>
                <div className="tdate"><span className="muted">{speed ? "speed around" : `since ${fmtDate(layer.dates[0])}`}</span><b>{fmtDate(layer.dates[t])}</b></div>
                <input aria-label="Date" type="range" min={0} max={layer.dates.length - 1} value={t} onChange={(e) => { setPlaying(false); setT(+e.target.value); }} />
              </div>
              <div className="ramp" style={{ background: `linear-gradient(90deg, rgb(${NEG}), rgb(${MID}), rgb(${POS}))` }} />
              <div className="row"><span>−{lim.toFixed(1)} {unit} {ends ? ends[0] : ""}</span><span>+{lim.toFixed(1)} {unit} {ends ? ends[1] : ""}</span></div>
            </>) : isImpact ? (<>
              <div className="trow one"><div className="tdate"><span className="muted">before and after</span><b>{meta.event?.name || "Event"}</b></div></div>
              <div className="ramp" style={{ background: `linear-gradient(90deg, rgba(${IMPACT},0.05), rgb(${IMPACT}))` }} />
              <div className="row"><span>surface unchanged</span><span>surface changed a lot</span></div>
            </>) : (<>
              <div className="ramp" style={{ background: "linear-gradient(90deg, rgb(20,24,32), rgb(150,200,255))" }} />
              <div className="row"><span>0 signal lost</span><span>1 stable signal</span></div>
            </>)}
          </div>
        )}
      </div>
      <aside className={"panel" + (step ? " touring" : "")}>
        <header>
          <h1><span className="logo" aria-hidden="true">🛰️</span> <span className="brand">SARvis</span></h1>
          <p className="sub">Watching the ground move from space, every 12 days.</p>
          {meta && layer && (
            <div className="actions hide-on-tour">
              <button className="cta" onClick={() => setTour({ i: 0, auto: false })}><span aria-hidden="true">🎬</span> Take the tour</button>
              <button className="ghost" onClick={copyLink}><span aria-hidden="true">🔗</span> {copied ? "Link copied" : "Copy link to this view"}</button>
            </div>
          )}
        </header>
        {step && (
          <div className="tour" role="region" aria-label="Guided tour" key={tour.i}>
            <div className="tourtop"><b>Step {tour.i + 1} of {steps.length}</b>
              <label className="auto"><input type="checkbox" checked={tour.auto} onChange={(e) => setTour({ ...tour, auto: e.target.checked })} /> Auto-advance</label></div>
            <p>{step.say}</p>
            {tour.auto && <div className="tourbar"><i /></div>}
            <div className="tourbtns">
              <button className="ghost" disabled={tour.i === 0} onClick={() => setTour({ ...tour, i: tour.i - 1 })}>Back</button>
              {tour.i < steps.length - 1 ? <button className="cta" onClick={() => setTour({ ...tour, i: tour.i + 1 })}>Next</button> : <button className="cta" onClick={() => setTour(null)}>Finish</button>}
              <button className="ghost" onClick={() => setTour(null)}>Exit</button>
            </div>
          </div>
        )}
        {meta?.synthetic && <div className="banner"><b>Demo data.</b> Radar motion is synthetic. Rainfall and GPS are real.</div>}
        <div className="seg hide-on-tour" role="tablist" aria-label="Site">
          {sites.map((st) => <button key={st.id} role="tab" aria-selected={st.id === siteId} className={"tab" + (st.id === siteId ? " on" : "")} onClick={() => setSiteId(st.id)}><span className="em" aria-hidden="true">{st.emoji}</span>{st.short || st.id}</button>)}
        </div>
        {meta && (
          <div className="story hide-on-tour" key={meta.id}>
            <div className="em" aria-hidden="true">{meta.emoji}</div>
            <div><b>{meta.name}</b><p>{meta.story}</p>{meta.event && <p className="muted">{meta.event.name}, {meta.event.when}. {meta.event.note}</p>}</div>
          </div>
        )}
        {meta && layer && (<>
          <div className="hide-on-tour">
            <label>Sensor</label>
            <div className="seg">
              {SENS.map(([k, name, band]) => (
                <button key={k} className={sensor === k ? "on" : ""} aria-pressed={sensor === k} onClick={() => choose(k, layer.kind)}><i style={{ background: C[k] }} />{name} <small>{band}</small></button>))}
            </div>
          </div>
          <div className="hide-on-tour">
            <label>Measurement</label>
            <div className="chips">
              {KINDS.filter(([k]) => has(sensor, k)).map(([k, name, icon]) => <button key={k} className={layer.kind === k ? "on" : ""} aria-pressed={layer.kind === k} onClick={() => choose(sensor, k)}><span aria-hidden="true">{icon}</span> {name}</button>)}
            </div>
          </div>
          {hot && (
            <button className="finding hide-on-tour" onClick={() => setPick({ i: hot.i, j: hot.j, lon: hot.lon, lat: hot.lat })}>
              <span className="em" aria-hidden="true">{isImpact ? "🔎" : "⚡"}</span>
              <span>{isImpact
                ? <><b>{Math.round(100 * hot.share)}%</b> of the focus area lost more than 30% of its usual radar signal across the storm. Strongest spot: <b>{Math.round(100 * hot.v)}%</b>.</>
                : <>Biggest change in the focus area: <b>{`${hot.v > 0 ? "+" : "−"}${Math.abs(hot.v).toFixed(1)} cm`}</b>{ends ? ` ${hot.v >= 0 ? ends[1] : ends[0]}` : ""} since {fmtDate(layer.dates[0])}.</>}
                <small> Tap to see that spot.</small></span>
            </button>
          )}
          {!layer.static && (
            <div className="seg hide-on-tour" aria-label="Show">
              <button className={!speed ? "on" : ""} aria-pressed={!speed} onClick={() => setMode("total")}><span aria-hidden="true">📏</span> Total change</button>
              <button className={speed ? "on" : ""} aria-pressed={speed} onClick={() => setMode("speed")}><span aria-hidden="true">⏱️</span> Speed</button>
            </div>
          )}
          <div className="card" ref={cardRef}>
            <h2><span aria-hidden="true">📍</span> {pick ? (pick.station ? `Ground check at station ${pick.station}` : `Spot at ${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}`) : "Pick a spot"}</h2>
            <p className="muted" style={{ margin: "0 0 8px" }}>{layer.static ? (pick ? "Radar signal quality for each pair of passes (1 = surface unchanged, 0 = changed completely)." : "Tap the map to see how the radar signal held up at that spot.") : pick ? `${kindName} ${speed ? "speed, cm per month" : "motion, cm"}` : "Tap the map, or a labelled GPS station, to see how that spot moved."}</p>
            {isImpact && pickVal !== null && <div className="hero" key={`${pick.i}-${pick.j}`}>{pickVal === layer.nodata ? "No reading" : `${Math.round((100 * pickVal) / layer.max)}%`}<small> {pickVal === layer.nodata ? "here (water, or never a stable signal)" : "of the usual signal lost across the storm"}</small></div>}
            {sigChart && <Chart key={`s${pick.i}-${pick.j}`} lines={sigChart.lines} markX={null} eventX={eventX} eventLabel={meta.event?.name} domain={[0, 1]} unit="" />}
            {cur && cur.y !== null && <div className="hero" key={`${pick.i}-${pick.j}-${mode}`}>{fmtCm(shown ?? cur.y)}<small> {ends ? (cur.y >= 0 ? ends[1] : ends[0]) : ""} {speed ? "around" : "by"} {fmtDate(layer.dates[t])}</small></div>}
            {chart && <Chart key={`m${pick.i}-${pick.j}-${layerKey}-${mode}`} lines={chart.lines} markX={toDay(layer.dates[t])} eventX={eventX} eventLabel={meta.event?.name} />}
            {chart?.stat && <p className="muted" style={{ margin: "8px 0 0" }}>Radar minus GPS, root-mean-square: <b style={{ color: "var(--ink)" }}>{chart.stat.rms.toFixed(2)} cm</b> over {chart.stat.n} dates{ctx.gnss.ref ? ` (GPS relative to station ${ctx.gnss.ref})` : " (GPS not referenced; compare vertical only)"}.</p>}
          </div>
          {rain && rain.pts.length > 0 && (
            <div className="card" id="weather">
              <h2><span aria-hidden="true">🌧️</span> Daily rainfall, mm</h2>
              <p className="muted" style={{ margin: "0 0 8px" }}>Regional estimate at the site centre.</p>
              <Bars pts={rain.pts} x0={rain.x0} x1={rain.x1} markX={layer.static ? null : toDay(layer.dates[t])} eventX={eventX} />
              <p className="muted" style={{ margin: "6px 0 0" }}>{ctx.rain.source}</p>
            </div>
          )}
          {wind && wind.pts.length > 0 && (
            <div className="card">
              <h2><span aria-hidden="true">💨</span> Strongest daily wind, m/s</h2>
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
            </div>
          )}
          {wl && SENS.length > 1 && (
            <div className="card">
              <h2><span aria-hidden="true">📡</span> Why the two radars can disagree</h2>
              <p className="muted" style={{ margin: "0 0 10px" }}>A radar loses track when neighbouring pixels move apart by more than a quarter of its wavelength between two passes.</p>
              <div className="tiles">
                {SENS.map(([k, name, band]) => (
                  <div key={k} className="tile">
                    <span className="swatch" style={{ background: C[k] }} /><span className="muted">{name} ({band}), {wl[k].toFixed(1)} cm wavelength</span>
                    <div className="meter"><i style={{ width: `${(100 * wl[k]) / Math.max(wl.nisar, wl.s1)}%`, background: C[k] }} /></div>
                    <div className="big">{(wl[k] / 4).toFixed(1)} cm <small>largest step it can follow</small></div>
                  </div>))}
              </div>
              <p className="muted" style={{ margin: "10px 0 0" }}>Shorter wavelengths (X-band, about 3 cm) see finer detail but lose fast motion sooner. Longer ones (P-band, 30 to 100 cm) are used for forests, not ground motion.</p>
            </div>
          )}
          {cov && !meta.event && (
            <div className="card">
              <h2><span aria-hidden="true">🎯</span> How much of the focus area each radar could measure</h2>
              <p className="muted" style={{ margin: "0 0 10px" }}>Share of pixels in the yellow box with a reading on every date.</p>
              <div className="tiles">
                {SENS.map(([k, name, band]) => (
                  <div key={k} className="tile"><span className="swatch" style={{ background: C[k] }} /><span className="muted">{name} ({band})</span>
                    <div className="big">{pct(cov[k]?.asc)} <small>ascending</small> · {pct(cov[k]?.desc)} <small>descending</small></div></div>))}
              </div>
            </div>
          )}
          <details className="card" open={notesOpen} onToggle={(e) => setNotesOpen(e.currentTarget.open)}>
            <summary><span aria-hidden="true">📖</span>&nbsp;How to read this</summary>
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
        </>)}
      </aside>
    </div>
  );
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
function useHover() { const [h, setH] = useState(null); return [h, setH]; }

function Chart({ lines, markX, eventX = null, eventLabel = "", domain = null, unit = "" }) {
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
        {ticks.map((v) => (<g key={v}><line x1={m.l} x2={W - m.r} y1={sy(v)} y2={sy(v)} stroke="#383835" strokeWidth={v === 0 ? 1.5 : 1} /><text x={m.l - 6} y={sy(v) + 4} textAnchor="end">{v.toFixed(1)}</text></g>))}
        <text x={m.l} y={H - 6}>{dayStr(x0)}</text><text x={W - m.r} y={H - 6} textAnchor="end">{dayStr(x1)}</text>
        {markX !== null && markX >= x0 && markX <= x1 && <line x1={sx(markX)} x2={sx(markX)} y1={m.t} y2={H - m.b} stroke="#8a8985" strokeDasharray="3 3" />}
        {eventX !== null && eventX >= x0 && eventX <= x1 && <g><line x1={sx(eventX)} x2={sx(eventX)} y1={m.t} y2={H - m.b} stroke="#eda100" strokeWidth="1.5" /><text x={sx(eventX) + (sx(eventX) > W * 0.6 ? -5 : 5)} y={H - m.b - 5} textAnchor={sx(eventX) > W * 0.6 ? "end" : "start"} style={{ fill: "#eda100" }}>{eventLabel}</text></g>}
        {lines.map((l) => { const v = l.pts.filter((p) => p.y !== null); return <path key={l.id} className="draw" pathLength="1" d={v.map((p, k) => `${k ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("")} fill="none" stroke={C[l.id]} strokeWidth={l.thin ? 1.25 : 2} strokeLinejoin="round" />; })}
        {tips.map(([l, p]) => <circle key={l.id} cx={sx(p.x)} cy={sy(p.y)} r="4.5" fill={C[l.id]} stroke="#242423" strokeWidth="2" />)}
        {tips.length > 0 && <text x={m.l} y={12} style={{ fill: "#f0efec", fontSize: 11 }}>{tips.map(([l, p]) => `${lines.length > 1 ? NAME[l.id].split(" ")[0] + " " : ""}${p.d ? fmtDate(p.d) : dayStr(p.x)}: ${p.y.toFixed(2)}`).join("   ")}</text>}
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
