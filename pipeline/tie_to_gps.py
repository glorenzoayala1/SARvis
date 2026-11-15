"""Pin an exported SARvis site to one GPS station.

Why: every radar value is measured relative to a reference patch that is assumed not to move. In the Central Valley
the first real run disagreed with GPS station HANF by up to 15 cm, so that assumption failed there. This script shifts
each date of each layer by one constant so the radar matches the GPS station at the station's location. Differences
between places on the map are untouched. After this, that GPS station is no longer an independent check.

    python pipeline/tie_to_gps.py app/public/data/central-valley HANF
"""
import json, sys, datetime as dt
import numpy as np

folder, station = sys.argv[1], sys.argv[2]
meta = json.load(open(f"{folder}/meta.json")); ctx = json.load(open(f"{folder}/context.json"))
if meta.get("tied_to"): sys.exit(f"already pinned to {meta['tied_to']}")
nx, ny = meta["nx"], meta["ny"]; w, s, e, n = meta["bbox"]
st = next(x for x in ctx["gnss"]["stations"] if x["id"] == station)
day = lambda x: dt.date(int(x[:4]), int(x[4:6]), int(x[6:]))
gdays = [day(x) for x in st["dates"]]

def gps(comp, d, half=3):                     # mean of the daily GPS values within 3 days of a radar date
    v = [st[comp][k] for k, g in enumerate(gdays) if abs((g - day(d)).days) <= half and st[comp][k] is not None]
    return float(np.mean(v)) if v else np.nan

i = int((st["lon"] - w) / (e - w) * nx); j = int((n - st["lat"]) / (n - s) * ny)
report = {}
for L in meta["layers"]:
    if not L["file"].endswith(".i16"): continue
    d = L["dates"]; raw = np.fromfile(f"{folder}/{L['file']}", dtype="<i2").reshape(len(d), ny, nx)
    a = raw.astype(float); a[raw == meta["nodata"]] = np.nan; a *= meta["scale"]
    radar = np.nanmedian(a[:, max(0, j - 4):j + 5, max(0, i - 4):i + 5].reshape(len(d), -1), axis=1)      # 9 x 9 pixels around the station
    if L["kind"] == "up": g = [gps("u", x) for x in d]
    elif L["kind"] == "east": g = [gps("e", x) for x in d]
    else:
        v = (meta["los_s1"] if L["sensor"] == "s1" else meta["los"])[L["kind"][:-4]]
        g = [v["e"] * gps("e", x) + v["n"] * gps("n", x) + v["u"] * gps("u", x) for x in d]
    g = np.array(g) - g[0]
    shift = g - radar; ok = np.isfinite(shift)
    shift = np.interp(np.arange(len(d)), np.flatnonzero(ok), shift[ok])                                   # dates with no reading at the station borrow from neighbours
    a += shift[:, None, None]
    out = np.where(np.isfinite(a), np.clip(np.round(a / meta["scale"]), -32767, 32767), meta["nodata"]).astype("<i2")
    out.tofile(f"{folder}/{L['file']}")
    L["p98"] = round(float(np.nanpercentile(np.abs(a[-1]), 98)), 2)
    report[L["key"]] = {"largest_shift_cm": round(float(np.max(np.abs(shift))), 1), "dates_without_station_reading": int((~ok).sum())}
meta["tied_to"] = station
meta["tie_note"] = (f"Every date was shifted by one constant so the radar matches GPS station {station} at the station. "
                    "The original reference patch turned out to be moving.")
meta["processing"]["tie"] = report
json.dump(meta, open(f"{folder}/meta.json", "w"), separators=(",", ":"))
print(json.dumps(report, indent=1))
