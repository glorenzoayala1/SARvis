# ---
# jupyter:
#   jupytext:
#     formats: ipynb,py:percent
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# %% [markdown]
# # SARvis pipeline: NISAR GUNW -> ground-motion time series -> web files
#
# NASA Space Apps 2026, "Dancing with the SARs".
#
# What this does, per site:
# 1. Finds every NISAR 12-day interferogram (L2 GUNW) for one ascending and one descending track.
# 2. Streams only the pixels over the site from each ~2.3 GB file (no full downloads).
# 3. Masks bad pixels, converts phase to centimetres, references to a stable area.
# 4. Chains the pairs into a cumulative line-of-sight (LOS) time series per track.
# 5. Combines the two tracks into vertical and east-west motion.
# 6. Writes small binary files the web app reads.
#
# Borrowed code and conventions (cite these in the project submission):
# - HDF5 dataset paths: MintPy `prep_nisar.py` (insarlab/MintPy).
# - Search fields and "keep latest product version" logic: ASF OpenSARLab MintPy Recipe Book,
#   `4_Access_NISAR_Data.ipynb` (BSD-3-Clause).
# - Streaming settings: ASF NISAR Data User Guide, earthaccess page.
#
# Part 2 (cells 8-10) adds context: NASA POWER rainfall, GPS stations from the Nevada Geodetic
# Laboratory, and the Sentinel-1 C-band record (OPERA DISP-S1) on the same grid. The DISP-S1 file
# layout and the reference-date "rebase" rule follow opera-adt/opera-utils.
#
# Things this notebook does NOT know and makes you check (search for "CHECK"):
# - the phase sign convention (cell 6),
# - the meaning of the `mask` layer digits (cell 4),
# - whether the reference boxes are really stable ground (cell 2).

# %%
# 1. Install (Colab already has numpy, h5py, matplotlib)
import os, sys, subprocess
SYNTH = os.environ.get("SARVIS_SYNTH") == "1"      # local self-test on fake files; leave unset in Colab
if not SYNTH:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "earthaccess", "pyproj", "h5py"], check=True)

import re, json, time, datetime as dt
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import h5py
from pyproj import Transformer

# %%
# 2. Configuration
# bbox = (west, south, east, north) in degrees.
# ref_box = area assumed NOT moving; every interferogram is shifted so its median there is zero.
#   CHECK: both ref boxes are first guesses from a map. Look at the cell-5 plots and move them
#   if they sit on anything that moves or on low-coherence ground.
SITES = {
    "portuguese-bend": {
        "name": "Portuguese Bend landslide, Rancho Palos Verdes, CA",
        "emoji": "\u26f0\ufe0f", "short": "Portuguese Bend",
        "story": "A hillside neighbourhood sliding slowly toward the ocean.",
        # What the first full real run showed (Nov 2025 to Oct 2026), written by hand from the numbers, shown in the tour:
        "finding": "In this record the slide moved fastest in the wet winter months, about 6 cm a month, and slowed to about 3.5 by autumn. Single storms do not line up with single speed-ups.",
        "bbox": (-118.420, 33.715, -118.320, 33.790),
        "ref_box": (-118.385, 33.770, -118.365, 33.785),     # contains continuous GPS station PVHS
        "focus_box": (-118.385, 33.733, -118.350, 33.752),   # CHECK: rough box around the active slide
        "gnss_ref": "PVHS",                                  # GPS station inside ref_box; other stations are differenced against it
        "deramp": True,                                      # remove a tilted plane per pair, fitted outside focus_box
        "tracks": [  # frames checked against CMR footprints: all pairs of these two cover the whole box.
            {"id": "asc", "track": 34, "dir": "A", "frame": 19},   # frame 18 stops short of the reference box (found in the first full run)
            {"id": "desc", "track": 13, "dir": "D", "frame": 72},
        ],
        "site_height_m": 60.0,
    },
    "central-valley": {
        "name": "Central Valley subsidence near Corcoran, CA",
        "emoji": "\U0001f33e", "short": "Central Valley",
        "story": "Farmland that sinks when groundwater is pumped out and rebounds a little when it rains.",
        # What the first full real run showed, after pinning it to GPS (pipeline/tie_to_gps.py), written by hand from the numbers:
        "finding": "GPS station HANF rose about 3 cm through the wet winter, then sank about 9 cm from late February to October. "
                   "With the radar pinned to that station, the middle of the yellow box sank about 9 cm and the deepest spot about 33 cm.",
        "bbox": (-119.750, 36.000, -119.400, 36.250),
        "ref_box": (-119.440, 36.210, -119.410, 36.240),
        "focus_box": (-119.700, 36.050, -119.500, 36.200),
        "gnss_ref": None,                                    # no active GPS station in the ref box (checked 2026-11-14)
        "deramp": False,                                     # the sinking area is wider than this scene, so a plane fit would remove real signal
        "tracks": [
            {"id": "asc", "track": 34, "dir": "A", "frame": 20},
            {"id": "desc", "track": 114, "dir": "D", "frame": 70},
        ],
        "site_height_m": 60.0,
    },
    "destin": {
        "name": "Hurricane Isaias landfall near Destin, FL",
        "emoji": "\U0001f300", "short": "Destin hurricane",
        "story": "A hurricane came ashore here in October 2026. Radar passes before and after show where the surface changed.",
        "bbox": (-86.750, 30.330, -86.300, 30.550),
        "ref_box": (-86.600, 30.500, -86.500, 30.540),       # CHECK: first guess at undisturbed inland ground
        "focus_box": (-86.650, 30.370, -86.400, 30.430),     # CHECK: the coastal strip around Destin
        "gnss_ref": None,
        "deramp": True,
        "tracks": [  # both confirmed in CMR on 2026-11-14, with pairs that bracket the landfall
            {"id": "asc", "track": 76, "dir": "A", "frame": 17},
            {"id": "desc", "track": 127, "dir": "D", "frame": 73},
        ],
        "site_height_m": 5.0,
        "start": "20260801", "end": "20261101",              # only the passes around the storm
        "s1": False,                                         # OPERA DISP-S1 stops around March 2026 here
        "event": {"name": "Hurricane Isaias", "utc": "20261010", "when": "evening of 9 October 2026 (local time)",
                  "note": "Landfall near Destin at about 8:30 pm local time on 9 October 2026 as a Category 2 hurricane with "
                          "105 mph winds, as reported by NBC News and AccuWeather from National Hurricane Center advisories. "
                          "These are figures from the time, not the final storm report."},
        # What the first real run showed (5 pairs per track), written by hand from the numbers, shown in the tour:
        "finding": "Both viewing directions lost signal in the storm pass: the scene average fell from about 0.25 to 0.16 in one "
                   "and from 0.37 to 0.23 in the other. They disagree on where. Only one direction shows strong change on the "
                   "barrier island, so this map keeps the smaller of the two readings.",
    },
    # ---- Places around the world, added 2026-11-15. Frames checked against CMR footprints that day (pipeline/scan notes in the README).
    #      Reference and focus boxes are FIRST GUESSES from general geography; nothing here is checked against ground measurements.
    "mexico-city": {
        "name": "Mexico City subsidence, Mexico", "emoji": "", "short": "Mexico City", "story": "A city built on a drained lakebed. Pumping groundwater from the clay beneath it makes the ground sink.",
        "bbox": (-99.2, 19.33, -98.95, 19.52), "ref_box": (-99.198, 19.395, -99.175, 19.425), "focus_box": (-99.1, 19.36, -98.97, 19.48),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 19, "dir": "A", "frame": 11}, {"id": "desc", "track": 113, "dir": "D", "frame": 79}],
        "site_height_m": 2240.0,
    },
    "kilauea": {
        "name": "Kilauea volcano, Hawaii", "emoji": "", "short": "Kilauea", "story": "An active volcano. The ground swells as magma collects under the summit and drops when it drains or erupts.",
        "bbox": (-155.35, 19.33, -155.15, 19.47), "ref_box": (-155.19, 19.44, -155.16, 19.465), "focus_box": (-155.31, 19.38, -155.24, 19.44),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 151, "dir": "A", "frame": 11}, {"id": "desc", "track": 72, "dir": "D", "frame": 79}],
        "site_height_m": 1100.0,
    },
    "reykjanes": {
        "name": "Reykjanes peninsula, Iceland", "emoji": "", "short": "Reykjanes", "story": "Magma has been collecting under Svartsengi, next to the town of Grindavik, lifting the ground between eruptions.",
        "bbox": (-22.6, 63.8, -22.25, 63.93), "ref_box": (-22.29, 63.9, -22.26, 63.92), "focus_box": (-22.5, 63.84, -22.36, 63.91),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 159, "dir": "A", "frame": 34}, {"id": "desc", "track": 82, "dir": "D", "frame": 56}],
        "site_height_m": 40.0,
    },
    "delhi": {
        "name": "Delhi subsidence, India", "emoji": "", "short": "Delhi", "story": "Parts of south-west Delhi sink as groundwater is pumped out faster than it is replaced.",
        "bbox": (77.0, 28.45, 77.2, 28.62), "ref_box": (77.17, 28.59, 77.195, 28.615), "focus_box": (77.04, 28.5, 77.12, 28.56),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 156, "dir": "A", "frame": 16}, {"id": "desc", "track": 106, "dir": "D", "frame": 74}],
        "site_height_m": 215.0,
    },
    "campi-flegrei": {
        "name": "Campi Flegrei, Italy", "emoji": "", "short": "Campi Flegrei", "story": "A volcanic caldera under the town of Pozzuoli, near Naples. The ground here has been rising for years.",
        "bbox": (14.05, 40.78, 14.22, 40.88), "ref_box": (14.19, 40.86, 14.215, 40.878), "focus_box": (14.09, 40.8, 14.16, 40.85),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 43, "dir": "A", "frame": 22}, {"id": "desc", "track": 152, "dir": "D", "frame": 68}],
        "site_height_m": 40.0,
    },
    "jakarta": {
        "name": "Jakarta subsidence, Indonesia", "emoji": "", "short": "Jakarta", "story": "The north of the city sinks as groundwater is pumped from beneath it, next to a rising sea.",
        "bbox": (106.7, -6.3, 106.98, -6.08), "ref_box": (106.8, -6.29, 106.84, -6.26), "focus_box": (106.74, -6.16, 106.92, -6.09),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 10, "dir": "A", "frame": 174}, {"id": "desc", "track": 18, "dir": "D", "frame": 92}],
        "site_height_m": 5.0,
    },
    "semarang": {
        "name": "Semarang subsidence, Indonesia", "emoji": "", "short": "Semarang", "story": "A port city on Java's north coast whose low-lying districts are sinking.",
        "bbox": (110.33, -7.03, 110.52, -6.92), "ref_box": (110.4, -7.03, 110.43, -7.01), "focus_box": (110.39, -6.985, 110.5, -6.935),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 154, "dir": "A", "frame": 174}, {"id": "desc", "track": 162, "dir": "D", "frame": 92}],
        "site_height_m": 5.0,
    },
    "bangkok": {
        "name": "Bangkok subsidence, Thailand", "emoji": "", "short": "Bangkok", "story": "A delta city on soft clay. Its south-east has a history of sinking from groundwater pumping.",
        "bbox": (100.4, 13.55, 100.75, 13.85), "ref_box": (100.42, 13.8, 100.46, 13.84), "focus_box": (100.55, 13.57, 100.73, 13.72),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 112, "dir": "A", "frame": 8}, {"id": "desc", "track": 4, "dir": "D", "frame": 82}],
        "site_height_m": 2.0,
    },
    "lagos": {
        "name": "Lagos coast, Nigeria", "emoji": "", "short": "Lagos", "story": "A fast-growing coastal city, much of it on reclaimed and low-lying land.",
        "bbox": (3.3, 6.4, 3.6, 6.62), "ref_box": (3.33, 6.58, 3.37, 6.61), "focus_box": (3.38, 6.41, 3.58, 6.48),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 15, "dir": "A", "frame": 5}, {"id": "desc", "track": 152, "dir": "D", "frame": 85}],
        "site_height_m": 5.0,
    },
    "ho-chi-minh": {
        "name": "Ho Chi Minh City subsidence, Vietnam", "emoji": "", "short": "Ho Chi Minh City", "story": "A delta city whose southern and western districts sit on soft ground and are reported to be sinking.",
        "bbox": (106.55, 10.68, 106.8, 10.88), "ref_box": (106.76, 10.85, 106.79, 10.875), "focus_box": (106.58, 10.69, 106.76, 10.78),
        "gnss_ref": None, "deramp": True, "s1": False, "first_look": True,
        "tracks": [{"id": "asc", "track": 155, "dir": "A", "frame": 7}, {"id": "desc", "track": 47, "dir": "D", "frame": 83}],
        "site_height_m": 5.0,
    },
}
FIRST_RUN = False        # True = quick gate run: Central Valley, 3 pairs, no Sentinel-1. False = full run of SITE below.
SITE = os.environ.get("SARVIS_SITE", "central-valley" if FIRST_RUN else "portuguese-bend")      # or "central-valley" or "destin"
SHORT_NAME = "NISAR_L2_GUNW_PROVISIONAL_V1"
COH_MIN = 0.3            # pixels below this coherence are dropped for that pair
USE_MASK = True          # drop water and invalid-subswath pixels (low byte of the mask layer, see cell 4)
APPLY_IONO = "auto"      # True / False / "auto". NASA ships an ionosphere phase screen but does not apply it.
                         # "auto" applies it only if it makes the pairs flatter (smaller scene-wide tilt).
MAX_GAP_FRAC = 0.25      # a pixel may miss up to this share of pairs; gaps are filled at that pixel's own average rate
PHASE_SIGN = -1.0        # CHECK in cell 6. displacement_toward_satellite = PHASE_SIGN * phase * wavelength / (4 pi)
MAX_PAIRS = 3 if (FIRST_RUN and not SYNTH) else None
RUN_RAIN, RUN_GNSS, RUN_S1 = True, True, not (FIRST_RUN and not SYNTH)   # part 2 steps; turn one off if it blocks you
S1_SIGN = 1.0            # CHECK in cell 10, same test as PHASE_SIGN: sinking ground must be negative
SURVEY_CSV = None        # optional on-slide survey points: columns id,lat,lon,date(YYYYMMDD),east_cm,north_cm,up_cm
WORKERS = 4
FSSPEC = {"cache_type": "background", "block_size": 16 * 1024 * 1024}   # ASF's suggested starting point
OUT = Path(os.environ.get("SARVIS_OUT", "web_data")) / SITE
OUT.mkdir(parents=True, exist_ok=True)
cfg = SITES[SITE]
print(SITE, cfg["bbox"])

# %%
# 3. Search. Granule names look like
#    NISAR_L2_PR_GUNW_<cycle>_<track>_<A|D>_<frame>_..._<refStart>_<refEnd>_<secStart>_<secEnd>_<CRID>_..._<counter>
NAME = re.compile(r"NISAR_L2_PR_GUNW_(\d{3})_(\d{3})_([AD])_(\d{3})_")
STAMP = re.compile(r"\d{8}T\d{6}")

def parse_name(name):
    m = NAME.search(name)
    s = STAMP.findall(name)
    ver = int(re.search(r"_(\d{3})(?:\.h5)?$", name).group(1))
    return {"track": int(m.group(2)), "dir": m.group(3), "frame": int(m.group(4)),
            "ref": s[0][:8], "sec": s[2][:8], "version": ver}

def pick(urls, tr):
    """Keep one track/frame, newest product version per date pair, sorted by reference date."""
    best = {}
    for u in urls:
        p = parse_name(Path(u).name)
        if (p["track"], p["dir"], p["frame"]) != (tr["track"], tr["dir"], tr["frame"]):
            continue
        k = (p["ref"], p["sec"])
        if k not in best or p["version"] > best[k][0]:
            best[k] = (p["version"], u)
    return [(k[0], k[1], v[1]) for k, v in sorted(best.items())]

if SYNTH:
    urls = sorted(str(p) for p in Path(os.environ["SARVIS_SYNTH_DIR"]).glob("*.h5"))
    open_file = lambda u: h5py.File(u, "r")
else:
    import earthaccess
    earthaccess.login()                       # prompts for your Earthdata username/password
    res = earthaccess.search_data(short_name=SHORT_NAME, bounding_box=cfg["bbox"], count=-1)
    urls = [l for r in res for l in r.data_links(access="external") if l.endswith(".h5")]
    fs = earthaccess.get_fsspec_https_session()
    open_file = lambda u: h5py.File(fs.open(u, **FSSPEC), "r")
    # Does each frame's footprint contain the whole site box? A frame that stops short leaves the reference box empty.
    def covers(r):
        try:
            pts = [(q["Latitude"], q["Longitude"]) for q in r["umm"]["SpatialExtent"]["HorizontalSpatialDomain"]["Geometry"]["GPolygons"][0]["Boundary"]["Points"]]
        except Exception:
            return None
        def inside(lat, lon):
            c = False
            for (y1, x1), (y2, x2) in zip(pts, pts[1:] + pts[:1]):
                if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1: c = not c
            return c
        return all(inside(la, lo) for la, lo in ((cfg["bbox"][1], cfg["bbox"][0]), (cfg["bbox"][1], cfg["bbox"][2]), (cfg["bbox"][3], cfg["bbox"][0]), (cfg["bbox"][3], cfg["bbox"][2])))
    foot = {}
    for r in res:
        name = Path(r.data_links(access="external")[0]).name; p = parse_name(name); k = (p["track"], p["dir"], p["frame"])
        c = covers(r)
        if c is not None: foot.setdefault(k, []).append(c)
    for tr in cfg["tracks"]:
        v = foot.get((tr["track"], tr["dir"], tr["frame"]), [])
        if v and sum(v) < len(v):
            alt = [f"frame {k[2]}" for k, vv in foot.items() if k[:2] == (tr["track"], tr["dir"]) and all(vv)]
            print(f"WARNING {tr['id']}: frame {tr['frame']} covers the whole box in only {sum(v)} of {len(v)} pairs.", "Use", ", ".join(alt) if alt else "a smaller box", "instead.")

pairs = {tr["id"]: [p for p in pick(urls, tr) if p[0] >= cfg.get("start", "0") and p[1] <= cfg.get("end", "9")][:MAX_PAIRS]
         for tr in cfg["tracks"]}
for k, v in pairs.items():
    print(k, len(v), "pairs", v[0][:2] if v else "", "->", v[-1][:2] if v else "")
    for a, b in zip(v[:-1], v[1:]):
        if a[1] != b[0]:
            print("   chain break: pair ends", a[1], "next starts", b[0])

# %%
# 4. Stream one cropped pair. Paths are the ones MintPy's prep_nisar.py uses.
ROOT = "/science/LSAR/GUNW/grids/frequencyA"
UNW = ROOT + "/unwrappedInterferogram"
RG = "/science/LSAR/GUNW/metadata/radarGrid"
IDENT = "/science/LSAR/identification"
W, S, E, N = cfg["bbox"]

def txt(v):
    if isinstance(v, h5py.Dataset):
        v = v[()]
    if isinstance(v, np.ndarray):
        v = v.item() if v.size == 1 else v.flat[0]
    return v.decode() if isinstance(v, bytes) else str(v)

def read_pair(url):
    t0 = time.time()
    with open_file(url) as f:
        pol = [txt(p) for p in np.atleast_1d(f[ROOT + "/listOfPolarizations"][()])][0]
        g = f[f"{UNW}/{pol}"]
        epsg = int(np.asarray(g["projection"][()]).item())
        x = g["xCoordinates"][()]; y = g["yCoordinates"][()]
        to_xy = Transformer.from_crs(4326, epsg, always_xy=True)
        cx, cy = to_xy.transform([W, E, W, E], [S, S, N, N])
        ix = np.where((x >= min(cx) - 200) & (x <= max(cx) + 200))[0]
        iy = np.where((y >= min(cy) - 200) & (y <= max(cy) + 200))[0]
        if ix.size == 0 or iy.size == 0:
            raise ValueError("site bbox is outside this frame")
        sx = slice(ix.min(), ix.max() + 1); sy = slice(iy.min(), iy.max() + 1)
        out = {"epsg": epsg, "x": x[sx], "y": y[sy], "pol": pol,
               "unw": g["unwrappedPhase"][sy, sx].astype("f4"),
               "coh": g["coherenceMagnitude"][sy, sx].astype("f4"),
               "cc": g["connectedComponents"][sy, sx],
               "freq": float(f[ROOT + "/centerFrequency"][()]),
               "orbit": txt(f[IDENT + "/orbitPassDirection"]),
               "look": txt(f[IDENT + "/lookDirection"])}
        fill = g["unwrappedPhase"].attrs.get("_FillValue")
        if fill is not None:
            out["unw"][out["unw"] == np.asarray(fill).item()] = np.nan
        if APPLY_IONO and "ionospherePhaseScreen" in g:
            ion = g["ionospherePhaseScreen"][sy, sx].astype("f4")
            ifill = g["ionospherePhaseScreen"].attrs.get("_FillValue")
            if ifill is not None:
                ion[ion == np.asarray(ifill).item()] = np.nan
            out["ion"] = ion
        if f"{UNW}/mask" in f and f[f"{UNW}/mask"].shape == g["unwrappedPhase"].shape:
            out["mask"] = f[f"{UNW}/mask"][sy, sx]
        # line-of-sight unit vector: a coarse cube (height, y, x). Take the height layer nearest the site.
        h = f[RG + "/heightAboveEllipsoid"][()]
        k = int(np.argmin(np.abs(h - cfg["site_height_m"])))
        rx = f[RG + "/xCoordinates"][()]; ry = f[RG + "/yCoordinates"][()]
        j = int(np.argmin(np.abs(ry - np.mean(cy)))); i = int(np.argmin(np.abs(rx - np.mean(cx))))
        out["los_x"] = float(f[RG + "/losUnitVectorX"][k, j, i])
        out["los_y"] = float(f[RG + "/losUnitVectorY"][k, j, i])
    out["seconds"] = time.time() - t0
    return out

# GATE: time one file. If this takes minutes, lower FSSPEC["block_size"] to 4 MB or set MAX_PAIRS.
first = read_pair(pairs[cfg["tracks"][0]["id"]][0][2])
print("crop", first["unw"].shape, "EPSG", first["epsg"], first["pol"], first["orbit"], first["look"],
      "in %.1f s" % first["seconds"])
if "mask" in first:
    # opera-utils (nisar/_mask.py) decodes the mask as three decimal digits: hundreds = water,
    # tens / ones = reference / secondary subswath (0 = invalid), 255 = fill. Real provisional files
    # also carry higher bits (values like 131083 = 131072 + 11) whose meaning I could not confirm,
    # so only the low byte is used.
    print("mask values in crop:", np.unique(first["mask"])[:20], "-> low byte:", np.unique(first["mask"] & 0xFF)[:20])

# %%
# 5. Read every pair, put it on one lon/lat grid, convert to cm, reference, and chain.
lat0 = (S + N) / 2
dlon = 80.0 / (111320.0 * np.cos(np.radians(lat0))); dlat = 80.0 / 110540.0
lons = np.arange(W + dlon / 2, E, dlon); lats = np.arange(N - dlat / 2, S, -dlat)   # row 0 = north
LON, LAT = np.meshgrid(lons, lats)
ny, nx = LON.shape
rw, rs, re_, rn = cfg["ref_box"]
REF = (LON >= rw) & (LON <= re_) & (LAT >= rs) & (LAT <= rn)

def day(s): return dt.date(int(s[:4]), int(s[4:6]), int(s[6:])).toordinal()
def ymd(o): return dt.date.fromordinal(int(o)).strftime("%Y%m%d")

def to_grid(p, arr, nodata=np.nan):
    """Nearest-neighbour sample of a cropped UTM array onto the common lon/lat grid."""
    gx, gy = Transformer.from_crs(4326, p["epsg"], always_xy=True).transform(LON, LAT)
    dx = p["x"][1] - p["x"][0]; dy = p["y"][1] - p["y"][0]
    i = np.rint((gx - p["x"][0]) / dx).astype(int); j = np.rint((gy - p["y"][0]) / dy).astype(int)
    ok = (i >= 0) & (i < p["x"].size) & (j >= 0) & (j < p["y"].size)
    out = np.full(LON.shape, nodata, dtype="f4")
    out[ok] = arr[j[ok], i[ok]]
    return out

def los_enu(p):
    """Unit vector from the ground to the satellite as (east, north, up).
    The file stores x and y components; which way the vector points is not stated in the docs
    I could read, so orient it by geometry: left-looking ascending or right-looking descending
    means the satellite is east of the target."""
    e, n = p["los_x"], p["los_y"]
    u = float(np.sqrt(max(0.0, 1 - e * e - n * n)))
    sat_is_east = (p["orbit"][0].upper() == "A") == (p["look"][0].upper() == "L")
    if (e > 0) != sat_is_east:
        e, n = -e, -n
    return e, n, u

fx0, fs0, fx1, fn0 = cfg["focus_box"]
FOCUS = (LON >= fx0) & (LON <= fx1) & (LAT >= fs0) & (LAT <= fn0)
XKM = (LON - LON.mean()) * 111.32 * np.cos(np.radians(lat0)); YKM = (LAT - LAT.mean()) * 110.54

def plane(d, where):
    """Least-squares plane through d on the pixels in `where`. Returns the plane and its tilt in cm per 10 km."""
    ok = np.isfinite(d) & where
    if ok.sum() < 50: return np.zeros_like(d), np.nan
    A = np.c_[XKM[ok], YKM[ok], np.ones(ok.sum())]
    c = np.linalg.lstsq(A, d[ok], rcond=None)[0]
    return c[0] * XKM + c[1] * YKM + c[2], 10 * float(np.hypot(c[0], c[1]))

stacks = {}
for tr in cfg["tracks"]:
    plist = pairs[tr["id"]]
    data = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for p in ex.map(read_pair, [u for _, _, u in plist]):      # results arrive in order; print as they land
            data.append(p)
            print(f"\r{tr['id']}: {len(data)} of {len(plist)} files read", end="", flush=True)
    print()
    lam_cm = 29979245800.0 / data[0]["freq"]
    k_cm = PHASE_SIGN * lam_cm / (4 * np.pi)
    raw, ion, coh, bad = [], [], [], []
    for p in data:
        c = to_grid(p, p["coh"])
        b = (c < COH_MIN) | (to_grid(p, p["cc"].astype("f4"), 0) == 0)
        if USE_MASK and "mask" in p:
            m = to_grid(p, (p["mask"] & 0xFF).astype("f4"), 255).astype(int)
            b |= (m == 255) | (m >= 100) | ((m // 10) % 10 == 0) | (m % 10 == 0)
        raw.append(k_cm * to_grid(p, p["unw"])); coh.append(c); bad.append(b)
        ion.append(k_cm * to_grid(p, p["ion"]) if "ion" in p else None)
    # Ionosphere: compare the scene-wide tilt of each pair with and without NASA's phase screen.
    tilt = lambda arrs: float(np.nanmedian([plane(np.where(b, np.nan, a), ~FOCUS)[1] for a, b in zip(arrs, bad)]))
    have_ion = all(i is not None and np.isfinite(i).any() for i in ion)
    t_raw = tilt(raw); t_ion = tilt([r - i for r, i in zip(raw, ion)]) if have_ion else np.nan
    use_ion = have_ion and (APPLY_IONO is True or (APPLY_IONO == "auto" and t_ion < t_raw))
    disp = []; ref_fallbacks = 0
    for r, i, b in zip(raw, ion, bad):
        d = (r - i) if use_ion else r.copy()
        d[b | ~np.isfinite(d)] = np.nan
        if cfg.get("deramp"):
            d = d - plane(d, ~FOCUS)[0]
        if np.isfinite(d[REF]).sum() >= 10: ref = np.nanmedian(d[REF])
        else: ref = np.nanmedian(d[~FOCUS]) if np.isfinite(d[~FOCUS]).any() else 0.0; ref_fallbacks += 1     # never blank a whole pair
        disp.append(d - ref)
    disp = np.array(disp); coh = np.array(coh)
    if ref_fallbacks: print(f"   NOTE: the reference box had no usable pixels in {ref_fallbacks} of {len(disp)} pairs; those pairs were referenced to everything outside the focus box.")
    dates = [plist[0][0]] + [b for _, b, _ in plist]
    # Chain the pairs. A pixel missing in a few pairs is filled at its own average rate; too many gaps drops it.
    days = np.array([day(b) - day(a) for a, b, _ in plist], "f4")[:, None, None]
    okp = np.isfinite(disp)
    rate = np.nansum(np.where(okp, disp, 0), axis=0) / np.maximum((okp * days).sum(axis=0), 1)
    keep = okp.mean(axis=0) >= 1 - MAX_GAP_FRAC
    filled = np.where(okp, disp, rate[None] * days)
    cum = np.concatenate([np.zeros((1, ny, nx), "f4"), np.cumsum(filled, axis=0)]).astype("f4")
    cum[:, ~keep] = np.nan
    stacks[tr["id"]] = {"dates": dates, "pairs": disp, "cum": cum, "coh": coh, "plist": plist,
                        "water": np.all(bad & (np.array(coh) >= 0), axis=0) if USE_MASK else None,
                        "enu": los_enu(data[0]), "lam_cm": lam_cm, "iono_applied": bool(use_ion),
                        "gap_filled_frac": float((~okp)[:, keep].mean()) if keep.any() else 0.0,
                        "valid_frac": float(keep.mean())}
    print(tr["id"], "wavelength %.2f cm" % lam_cm, "LOS (e,n,u) = %.2f %.2f %.2f" % stacks[tr["id"]]["enu"])
    print("   scene tilt, cm per 10 km: raw %.2f, with ionosphere screen %.2f -> ionosphere correction %s"
          % (t_raw, t_ion, "APPLIED" if use_ion else "not applied"), "| plane removed" if cfg.get("deramp") else "")
    print("   pixels kept: %.0f%% (%.0f%% with every pair; %.1f%% of kept values gap-filled)"
          % (100 * keep.mean(), 100 * okp.all(axis=0).mean(), 100 * stacks[tr["id"]]["gap_filled_frac"]),
          "| ref-box pixels usable in last pair: %d" % np.isfinite(disp[-1][REF]).sum())

# %%
# 6. Look at it.  CHECK the sign here, on PORTUGUESE BEND, ascending panel.
# Positive = toward the satellite. The slide moves seaward (south to south-west) and down. The ascending
# view has east, north and up components that are all positive, so that motion must come out NEGATIVE
# there. If the slide is positive in the ascending panel, set PHASE_SIGN = +1.0 and rerun from cell 5.
# (PHASE_SIGN = -1 matches how MintPy converts NISAR phase.) Central Valley is not a good sign test in
# winter: the first real run showed scene-wide tilts of several cm, and GPS station HANF rising.
import matplotlib
if SYNTH: matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, ax = plt.subplots(1, len(stacks), figsize=(6 * len(stacks), 5), squeeze=False)
for a, (k, s) in zip(ax[0], stacks.items()):
    lim = np.nanpercentile(np.abs(s["cum"][-1]), 98) if np.isfinite(s["cum"][-1]).any() else 1
    im = a.imshow(s["cum"][-1], cmap="RdBu", vmin=-lim, vmax=lim, extent=(W, E, S, N), aspect="auto")
    a.plot([rw, re_, re_, rw, rw], [rs, rs, rn, rn, rs], "k-", lw=1)
    a.set_title(f"{k}: LOS cm, {s['dates'][0]} to {s['dates'][-1]} (box = reference)")
    plt.colorbar(im, ax=a)
fig.savefig(OUT / "check_los.png", dpi=110, bbox_inches="tight")

# %%
# 7. Two tracks -> vertical and east. North is dropped: both tracks see only ~0.1-0.16 of it,
#    so any real north-south motion leaks into these two numbers. State this in the app.
def decompose(a, d):
    """a, d = dicts with dates, cum (t, y, x), enu. Returns dates, up, east on d's dates."""
    ta = np.array([day(x) for x in a["dates"]]); td = np.array([day(x) for x in d["dates"]])
    keep = (td >= ta[0]) & (td <= ta[-1])               # put ascending onto descending dates
    tt = td[keep]
    i1 = np.clip(np.searchsorted(ta, tt), 1, len(ta) - 1); i0 = i1 - 1
    w = ((tt - ta[i0]) / (ta[i1] - ta[i0]))[:, None, None]
    a_on_d = a["cum"][i0] * (1 - w) + a["cum"][i1] * w
    dd = d["cum"][keep] - d["cum"][keep][0]; aa = a_on_d - a_on_d[0]
    (ea, _, ua), (ed, _, ud) = a["enu"], d["enu"]
    det = ea * ud - ed * ua
    return [x for x, k in zip(d["dates"], keep) if k], (ea * dd - ed * aa) / det, (aa * ud - dd * ua) / det, det

layers = {}
for k, s in stacks.items():
    layers[k + "_los"] = {"dates": s["dates"], "data": s["cum"], "sensor": "nisar", "kind": k + "_los",
                          "label": f"NISAR {'ascending' if k == 'asc' else 'descending'} line of sight (+ toward satellite)"}
if {"asc", "desc"} <= set(stacks):
    cd, up, east, det = decompose(stacks["asc"], stacks["desc"])
    layers["up"] = {"dates": cd, "data": up, "sensor": "nisar", "kind": "up", "label": "NISAR vertical (+ up)"}
    layers["east"] = {"dates": cd, "data": east, "sensor": "nisar", "kind": "east", "label": "NISAR east-west (+ east)"}
    print("decomposition determinant %.2f (near 0 would mean the two views are too similar)" % det)
# Coverage = how often a focus-box pixel had a usable reading, averaged over pixels and passes.
def share(valid_stack): return round(float(valid_stack[:, FOCUS].mean()), 3) if len(valid_stack) else None
context = {"coverage": {"focus_box": list(cfg["focus_box"]), "window": None,
                        "nisar": {k: share(np.isfinite(v["pairs"])) for k, v in stacks.items()}, "s1": {}}}
all_dates = sorted({d for L in layers.values() for d in L["dates"]})
D0, D1 = all_dates[0], all_dates[-1]

# %%
# 8. Weather: NASA POWER daily rainfall and wind at the site centre. No login needed.
#    This is MERRA-2 reanalysis on a coarse grid (about 50 km), so it is regional weather, not a gauge
#    on the slide. Swap in GPM IMERG if you want finer rain; it needs Earthdata login.
#    Wind direction is the direction the wind blows FROM, in degrees clockwise from north.
import urllib.request
def http(u, binary=False):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "sarvis"}), timeout=120) as r:
        b = r.read()
    return b if binary else b.decode("utf-8", "replace")

if RUN_RAIN:
    r0 = ymd(day(D0) - 30)
    u = ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,WS10M,WS10M_MAX,WD10M,CLOUD_AMT&community=AG"
         f"&longitude={(W + E) / 2:.4f}&latitude={(S + N) / 2:.4f}&start={r0}&end={D1}&format=JSON")
    j = json.loads(http(u))
    pr = j["properties"]["parameter"]["PRECTOTCORR"]
    context["rain"] = {"dates": list(pr), "mm": [None if v < 0 else round(v, 2) for v in pr.values()],
                       "source": "NASA POWER PRECTOTCORR (" + ", ".join(j["header"]["sources"]) + "), mm/day"}
    par = j["properties"]["parameter"]; clean = lambda k: [None if v < -900 else round(v, 2) for v in par[k].values()]
    context["wind"] = {"dates": list(par["WS10M"]), "speed": clean("WS10M"), "max": clean("WS10M_MAX"), "dir": clean("WD10M"),
                       "source": "NASA POWER 10 m wind (" + ", ".join(j["header"]["sources"]) + "), m/s; direction = where the wind blows from"}
    if "CLOUD_AMT" in par:      # share of sky covered by cloud that day, used for the clouds in the 3D view
        context["cloud"] = {"dates": list(par["CLOUD_AMT"]), "pct": clean("CLOUD_AMT"), "source": "NASA POWER CLOUD_AMT, daily mean cloud cover, %"}
    print("rain days", len(pr), "total mm %.0f" % sum(v for v in pr.values() if v > 0),
          "| strongest daily max wind %.1f m/s" % max(v for v in par["WS10M_MAX"].values() if v > -900))

# %%
# 9. GPS ground check: daily station positions from the Nevada Geodetic Laboratory (IGS20 frame).
#    Raw GPS includes plate motion that the radar (relative to ref_box) does not see. If gnss_ref
#    is set, every station is differenced against it, which removes that. If not, only trust "up".
def read_tenv3(sta):
    rows = []
    for l in http(f"https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/{sta}.tenv3").splitlines()[1:]:
        p = l.split()
        o = int(p[3]) + 678576            # MJD -> proleptic ordinal (MJD 0 = 1858-11-17)
        if day(D0) - 10 <= o <= day(D1):
            rows.append((o, float(p[7]) + float(p[8]), float(p[9]) + float(p[10]), float(p[11]) + float(p[12])))
    return {r[0]: np.array(r[1:]) * 100 for r in rows}     # cm

if RUN_GNSS:
    stations = []
    for l in http("https://geodesy.unr.edu/NGLStationPages/DataHoldings.txt").splitlines()[1:]:
        p = l.split()
        if len(p) < 9: continue
        lat, lon = float(p[1]), float(p[2]); lon = lon - 360 if lon > 180 else lon
        if W <= lon <= E and S <= lat <= N and p[8].replace("-", "") >= D0:
            stations.append((p[0], lat, lon))
    ref = read_tenv3(cfg["gnss_ref"]) if cfg.get("gnss_ref") else None
    out = []
    for sta, lat, lon in stations:
        if sta == cfg.get("gnss_ref"): continue
        ts = read_tenv3(sta)
        days = sorted(set(ts) & set(ref)) if ref else sorted(ts)
        if len(days) < 10: continue
        v = np.array([ts[o] - (ref[o] if ref else 0) for o in days])
        v = v - np.median(v[:5], axis=0)
        out.append({"id": sta, "lat": lat, "lon": lon, "kind": "gps", "dates": [ymd(o) for o in days],
                    "e": v[:, 0].round(2).tolist(), "n": v[:, 1].round(2).tolist(), "u": v[:, 2].round(2).tolist()})
        print(sta, "days", len(days), "net E/N/U cm", np.median(v[-5:], axis=0).round(2))
    context["gnss"] = {"ref": cfg.get("gnss_ref"), "stations": out,
                       "source": "Nevada Geodetic Laboratory daily solutions (IGS20), cm"}
if SURVEY_CSV:   # e.g. the City of Rancho Palos Verdes monument surveys, once you have the spreadsheet
    import csv, collections
    pts = collections.defaultdict(list)
    for r in csv.DictReader(open(SURVEY_CSV)): pts[(r["id"], float(r["lat"]), float(r["lon"]))].append(r)
    for (pid, lat, lon), rr in pts.items():
        rr.sort(key=lambda r: r["date"])
        context.setdefault("gnss", {"ref": None, "stations": [], "source": ""})["stations"].append(
            {"id": pid, "lat": lat, "lon": lon, "kind": "survey", "dates": [r["date"] for r in rr],
             "e": [float(r["east_cm"]) for r in rr], "n": [float(r["north_cm"]) for r in rr], "u": [float(r["up_cm"]) for r in rr]})

# %%
# 10. Sentinel-1 C-band record (OPERA DISP-S1) on the same grid, same reference box, same dates window.
#     Each file holds displacement (metres) from a reference date that jumps forward every few months;
#     "rebasing" adds the last value of the previous block so the series is continuous.
#     CHECK S1_SIGN the same way as PHASE_SIGN (Central Valley must sink).
S1NAME = re.compile(r"OPERA_L3_DISP-S1_IW_F(\d{5})_VV_(\d{8})T(\d{2})\d{4}Z_(\d{8})T\d{6}Z_v[\d.]+_(\d{8}T\d{6})Z")
def read_disp(url):
    from pyproj import CRS
    with open_file(url) as f:
        wkt = f["spatial_ref"].attrs["crs_wkt"]
        epsg = CRS.from_wkt(wkt.decode() if isinstance(wkt, bytes) else str(wkt)).to_epsg()
        x = f["x"][()]; y = f["y"][()]
        cx, cy = Transformer.from_crs(4326, epsg, always_xy=True).transform([W, E, W, E], [S, S, N, N])
        ix = np.where((x >= min(cx) - 100) & (x <= max(cx) + 100))[0]
        iy = np.where((y >= min(cy) - 100) & (y <= max(cy) + 100))[0]
        sx = slice(ix.min(), ix.max() + 1); sy = slice(iy.min(), iy.max() + 1)
        d = f["displacement"][sy, sx].astype("f4") * 100.0 * S1_SIGN
        d[f["recommended_mask"][sy, sx] == 0] = np.nan
    return {"epsg": epsg, "x": x[sx], "y": y[sy], "d": d}

def read_los_tif(src):
    import rasterio
    with rasterio.open(src) as r:
        px, py = Transformer.from_crs(4326, r.crs, always_xy=True).transform((W + E) / 2, (S + N) / 2)
        e, n, u = [float(v) for v in next(r.sample([(px, py)]))]
    return (e, n, u) if u > 0 else (-e, -n, -u)        # make it ground -> satellite

RUN_S1 = RUN_S1 and cfg.get("s1", True)
if RUN_S1:
    if SYNTH:
        sdir = Path(os.environ["SARVIS_SYNTH_S1_DIR"])
        s1_urls = sorted(str(p) for p in sdir.glob("*.nc")); los_urls = sorted(str(p) for p in sdir.glob("*enu.tif"))
        open_tif = lambda u: u
    else:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "rasterio"], check=True)
        t0, t1 = f"{D0[:4]}-{D0[4:6]}-{D0[6:]}", f"{D1[:4]}-{D1[4:6]}-{D1[6:]}"
        res = earthaccess.search_data(short_name="OPERA_L3_DISP-S1_V1", bounding_box=cfg["bbox"], temporal=(t0, t1), count=-1)
        s1_urls = sorted({l for r in res for l in r.data_links(access="external") if l.endswith(".nc")})
        res = earthaccess.search_data(short_name="OPERA_L3_DISP-S1-STATIC_V1", bounding_box=cfg["bbox"], count=-1)
        los_urls = sorted({l for r in res for l in r.data_links(access="external") if l.endswith("line_of_sight_enu.tif")})
        open_tif = lambda u: fs.open(u)
    frames = {}
    for u in s1_urls:
        m = S1NAME.search(u)
        if not m: continue
        fr, refd, hh, secd, gen = m.groups()
        local = (int(hh) + (W + E) / 2 / 15) % 24          # sun-synchronous: ~18h local = ascending, ~6h = descending
        k = (refd, secd)
        fd = frames.setdefault(fr, {"pass": "asc" if local >= 12 else "desc", "files": {}})
        if k not in fd["files"] or gen > fd["files"][k][0]: fd["files"][k] = (gen, u)
    s1 = {}
    for pas in ("asc", "desc"):
        cand = [(len(v["files"]), fr) for fr, v in frames.items() if v["pass"] == pas]
        if not cand: continue
        fr = max(cand)[1]
        items = sorted(frames[fr]["files"].items(), key=lambda kv: kv[0][1])
        data = []
        with ThreadPoolExecutor(WORKERS) as ex:
            for p in ex.map(read_disp, [v[1] for _, v in items]):
                data.append(p)
                print(f"\rSentinel-1 {pas}: {len(data)} of {len(items)} files read", end="", flush=True)
        print()
        raw = np.array([to_grid(p, p["d"]) for p in data])
        raw = raw - np.nanmedian(raw[:, REF], axis=1)[:, None, None]
        refs = [k[0] for k, _ in items]
        cum = np.zeros_like(raw); offset = np.zeros((ny, nx), "f4"); prev = np.zeros((ny, nx), "f4"); cur = refs[0]
        for i, (rd, layer) in enumerate(zip(refs, raw)):          # rebase (opera-utils rebase_timeseries, NaN propagates)
            if rd != cur: offset = offset + prev; cur = rd
            prev = layer; cum[i] = layer + offset
        cum = cum - cum[0]
        los = [u for u in los_urls if f"_F{fr}_" in u]
        s1[pas] = {"dates": [k[1] for k, _ in items], "cum": cum, "raw": raw, "frame": fr,
                   "enu": read_los_tif(open_tif(los[0])) if los else None}
        layers[f"s1_{pas}_los"] = {"dates": s1[pas]["dates"], "data": cum, "sensor": "s1", "kind": pas + "_los",
                                   "label": f"Sentinel-1 {'ascending' if pas == 'asc' else 'descending'} line of sight (+ toward satellite)"}
        print("Sentinel-1", pas, "frame", fr, len(items), "dates", s1[pas]["dates"][0], "->", s1[pas]["dates"][-1], "LOS", s1[pas]["enu"])
    if {"asc", "desc"} <= set(s1) and s1["asc"]["enu"] and s1["desc"]["enu"]:
        cd, up, east, det = decompose(s1["asc"], s1["desc"])
        layers["s1_up"] = {"dates": cd, "data": up, "sensor": "s1", "kind": "up", "label": "Sentinel-1 vertical (+ up)"}
        layers["s1_east"] = {"dates": cd, "data": east, "sensor": "s1", "kind": "east", "label": "Sentinel-1 east-west (+ east)"}
    # Coverage: share of focus-box pixels that keep a measurement on every date.
    if s1:      # compare the two sensors over the same weeks only
        w0 = max(min(v["dates"][0] for v in s1.values()), D0); w1 = min(max(v["dates"][-1] for v in s1.values()), D1)
        context["coverage"]["window"] = [w0, w1]
        context["coverage"]["s1"] = {k: share(np.isfinite(v["raw"])[[w0 <= d <= w1 for d in v["dates"]]]) for k, v in s1.items()}
        context["coverage"]["nisar"] = {k: share(np.isfinite(v["pairs"])[[a >= w0 and b <= w1 for a, b, _ in v["plist"]]]) for k, v in stacks.items()}
    print("average share of passes with a usable reading in the focus box:", context["coverage"])

# %%
# 10b. Storm impact (only for sites with an "event"). Radar coherence ("signal quality") drops wherever the
#      surface changed between two passes: flooding, fallen trees, damaged roofs, moved sand. For each track,
#      compare the pair that brackets the event with the usual level in the calm pairs before it.
#      impact = usual coherence - storm-pair coherence (0 = no change, 1 = signal fully lost).
#      Pixels that are never coherent (water, dense forest) cannot show a drop and are left blank.
#      The combined layer takes the SMALLER of the two tracks, so a change must be seen from both directions.
#      This is surface change, not a damage assessment: tides, crops and wet soil also lower coherence.
static_layers = {}
ev = cfg.get("event")
if ev:
    imp = {}
    for k, s in stacks.items():
        pre = [i for i, (a, b, _) in enumerate(s["plist"]) if b < ev["utc"]]
        hit = [i for i, (a, b, _) in enumerate(s["plist"]) if a < ev["utc"] <= b]
        if len(pre) < 2 or not hit:
            print(k, "cannot compute impact: need 2+ calm pairs and one pair bracketing", ev["utc"], "| calm:", len(pre), "storm:", len(hit))
            continue
        base = np.nanmedian(s["coh"][pre], axis=0); spread = np.nanmax(s["coh"][pre], axis=0) - np.nanmin(s["coh"][pre], axis=0)
        d = np.clip(base - s["coh"][hit[0]], 0, 1)
        d[(base < COH_MIN) | ~np.isfinite(d)] = np.nan
        imp[k] = d
        s["storm_pair"] = hit[0]
        print(k, "storm pair", s["plist"][hit[0]][:2], "| calm pairs", len(pre),
              "| median coherence drop in focus box %.2f, elsewhere %.2f, usual calm-pair swing %.2f"
              % (np.nanmedian(d[FOCUS]), np.nanmedian(d[~FOCUS]), np.nanmedian(spread)))
        static_layers[k + "_impact"] = {"data": d, "kind": k + "_impact",
                                        "label": f"NISAR {'ascending' if k == 'asc' else 'descending'} storm change (0-1)"}
    if len(imp) == 2:
        both = np.fmin(imp["asc"], imp["desc"]); both[~(np.isfinite(imp["asc"]) & np.isfinite(imp["desc"]))] = np.nan
        static_layers = {"impact": {"data": both, "kind": "impact", "label": "Storm change seen from both directions (0-1)"}, **static_layers}

# %%
# 11. Export for the web app. Values are int16 hundredths of a cm, -32768 = no data, row 0 = north.
meta = {"id": SITE, "name": cfg["name"], "short": cfg.get("short", SITE), "emoji": cfg.get("emoji", ""), "story": cfg.get("story", ""), "first_look": bool(cfg.get("first_look", False)), "finding": cfg.get("finding", ""),
        "event": cfg.get("event"), "bbox": [W, S, E, N], "nx": nx, "ny": ny,
        "units": "cm", "scale": 0.01, "nodata": -32768, "ref_box": list(cfg["ref_box"]),
        "focus_box": list(cfg["focus_box"]),
        "synthetic": SYNTH, "source": SHORT_NAME, "coh_min": COH_MIN, "phase_sign": PHASE_SIGN,
        "processing": {k: {"iono_applied": v["iono_applied"], "gap_filled_frac": round(v["gap_filled_frac"], 3),
                           "deramp": bool(cfg.get("deramp")), "pairs": len(v["pairs"])} for k, v in stacks.items()},
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "los": {k: dict(zip("enu", [round(float(v), 3) for v in s["enu"]])) for k, s in stacks.items()},
        "wavelength_cm": {"nisar": round(float(next(iter(stacks.values()))["lam_cm"]), 2), "s1": 5.55},   # Sentinel-1: 5.405 GHz
        "layers": []}
if RUN_S1 and s1:
    meta["los_s1"] = {k: dict(zip("enu", [round(float(v), 3) for v in s["enu"]])) for k, s in s1.items() if s["enu"]}
for key, L in layers.items():
    q = np.where(np.isfinite(L["data"]), np.clip(np.rint(L["data"] / 0.01), -32767, 32767), -32768).astype("<i2")
    q.tofile(OUT / f"{key}.i16")
    fin = np.abs(L["data"][np.isfinite(L["data"])])
    meta["layers"].append({"key": key, "label": L["label"], "file": f"{key}.i16", "dates": L["dates"],
                           "sensor": L["sensor"], "kind": L["kind"],
                           "p98": round(float(np.percentile(fin, 98)), 2) if fin.size else 1.0})
for k, s in stacks.items():   # mean coherence: low = decorrelated (moving too fast, vegetation, water)
    okc = np.isfinite(s["coh"]); mean_coh = np.where(okc, s["coh"], 0).sum(axis=0) / np.maximum(okc.sum(axis=0), 1)
    (np.clip(mean_coh, 0, 1) * 255).astype("u1").tofile(OUT / f"{k}_coh.u8")
    meta["layers"].append({"key": k + "_coh", "label": f"NISAR {k} mean coherence (0-1)", "file": f"{k}_coh.u8",
                           "static": True, "sensor": "nisar", "kind": "coh"})
for key, L in static_layers.items():      # 0-250 = value 0-1, 255 = no data
    np.where(np.isfinite(L["data"]), np.rint(np.clip(L["data"], 0, 1) * 250), 255).astype("u1").tofile(OUT / f"{key}.u8")
    meta["layers"].insert(0, {"key": key, "label": L["label"], "file": f"{key}.u8", "static": True, "sensor": "nisar",
                              "kind": L["kind"], "palette": "impact", "nodata": 255, "max": 250})
if ev:
    meta["default_layer"] = "impact" if "impact" in static_layers else None
# Per-pass signal quality through time, for the chart (one value per pair, stamped with the later date)
for k, s in stacks.items():
    (np.clip(np.nan_to_num(s["coh"]), 0, 1) * 250).astype("u1").tofile(OUT / f"{k}_cohpairs.u8")
meta["signal_series"] = {k: {"file": f"{k}_cohpairs.u8", "dates": [b for _, b, _ in s["plist"]],
                             "starts": [a for a, _, _ in s["plist"]], "storm_pair": s.get("storm_pair")} for k, s in stacks.items()}
(OUT / "meta.json").write_text(json.dumps(meta, indent=1))
(OUT / "context.json").write_text(json.dumps(context))
print("wrote", sorted(p.name for p in OUT.iterdir()))
if not SYNTH:
    import shutil
    shutil.make_archive(str(OUT), "zip", OUT)     # download <site>.zip from the Colab file browser
print("Unzip into the app at public/data/<site>/ and make sure the site id is in public/data/index.json")
