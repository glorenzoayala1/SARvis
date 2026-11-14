"""Fake OPERA DISP-S1 files + LOS GeoTIFFs with the same ground truth as make_synthetic.py.
Usage: python make_synthetic_s1.py <out_dir> <site>"""
import sys, datetime as dt
from pathlib import Path
import numpy as np, h5py, rasterio
from rasterio.transform import from_origin
from pyproj import Transformer, CRS

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True); site = sys.argv[2]
W, S, E, N, sig, half = {"portuguese-bend": (-118.420, 33.715, -118.320, 33.790, 1200.0, 12000),
                         "central-valley": (-119.750, 36.000, -119.400, 36.250, 8000.0, 30000)}[site]
UP_RATE, EAST_RATE = -0.20, 0.10
to_xy = Transformer.from_crs(4326, 32611, always_xy=True)
cx, cy = to_xy.transform((W + E) / 2, (S + N) / 2)
x = np.arange(cx - half, cx + half, 30.0); y = np.arange(cy + half, cy - half, -30.0)
X, Y = np.meshgrid(x, y)
blob = np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * sig ** 2))
wkt = CRS.from_epsg(32611).to_wkt()
# Sentinel-1 looks right: ascending -> satellite west of target. hour is UTC.
for frame, pas, e, hour in ((16940, "asc", -0.62, 1), (18904, "desc", 0.62, 13)):
    n = -0.11; u = np.sqrt(1 - e * e - n * n)
    with rasterio.open(out / f"OPERA_L3_DISP-S1-STATIC_F{frame}_20140403_S1A_v1.0_line_of_sight_enu.tif", "w", driver="GTiff",
                       height=40, width=40, count=3, dtype="float32", crs="EPSG:32611",
                       transform=from_origin(cx - half, cy + half, half / 20, half / 20)) as r:
        for b, v in enumerate((e, n, u), 1): r.write(np.full((40, 40), v, "float32"), b)
    start = dt.date(2025, 11, 20); ref = start
    for k in range(1, 9):
        if k == 5: ref = start + dt.timedelta(days=12 * 4)        # reference date jumps forward
        sec = start + dt.timedelta(days=12 * k)
        d_cm = (sec - ref).days * (UP_RATE * u + EAST_RATE * e) * blob
        mask = (blob < 0.75).astype("u1")                          # wide decorrelated core
        name = f"OPERA_L3_DISP-S1_IW_F{frame}_VV_{ref:%Y%m%d}T{hour:02d}4949Z_{sec:%Y%m%d}T{hour:02d}4950Z_v1.0_20260817T231015Z.nc"
        with h5py.File(out / name, "w") as f:
            f["x"] = x; f["y"] = y
            f.create_dataset("displacement", data=(d_cm / 100).astype("f4"), chunks=(256, 256), compression="gzip")
            f.create_dataset("recommended_mask", data=mask, chunks=(256, 256), compression="gzip")
            f.create_dataset("spatial_ref", data=0).attrs["crs_wkt"] = wkt
print("wrote", len(list(out.glob("*.nc"))), "DISP files")
