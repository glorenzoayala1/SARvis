"""Halve the grid of an exported SARvis site (each new pixel is the median of 2 x 2 old ones) so it loads faster.

    python pipeline/shrink.py app/public/data/central-valley
"""
import json, sys, warnings
import numpy as np

folder = sys.argv[1]
meta = json.load(open(f"{folder}/meta.json"))
if meta.get("shrunk"): sys.exit("already shrunk")
nx, ny = meta["nx"], meta["ny"]; nx2, ny2 = nx // 2, ny // 2
w, s, e, n = meta["bbox"]

def block(a):                                  # (frames, ny, nx) with NaN for no reading -> (frames, ny2, nx2)
    a = a[:, :ny2 * 2, :nx2 * 2].reshape(a.shape[0], ny2, 2, nx2, 2).transpose(0, 1, 3, 2, 4).reshape(a.shape[0], ny2, nx2, 4)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore"); return np.nanmedian(a, axis=3)

files = {L["file"]: ("<i2", meta["nodata"]) if L["file"].endswith(".i16") else ("u1", L.get("nodata", 255)) for L in meta["layers"]}
for v in (meta.get("signal_series") or {}).values(): files[v["file"]] = ("u1", 255)
for f, (dtype, nod) in files.items():
    raw = np.fromfile(f"{folder}/{f}", dtype=dtype).reshape(-1, ny, nx)
    a = raw.astype(float); a[raw == nod] = np.nan
    b = block(a)
    np.where(np.isfinite(b), np.rint(b), nod).astype(dtype).tofile(f"{folder}/{f}")
# the bounding box loses the odd last row or column, if any
meta["bbox"] = [w, n - (n - s) * (ny2 * 2) / ny, w + (e - w) * (nx2 * 2) / nx, n]
meta["nx"], meta["ny"], meta["shrunk"] = nx2, ny2, 2
json.dump(meta, open(f"{folder}/meta.json", "w"), separators=(",", ":"))
print("grid", nx, "x", ny, "->", nx2, "x", ny2)
