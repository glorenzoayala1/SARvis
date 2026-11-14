"""Write fake GUNW-shaped HDF5 files with a known answer, to test the pipeline without Earthdata.
Usage: python make_synthetic.py <out_dir> <site>
The ground truth is a Gaussian patch moving UP_RATE cm/day up and EAST_RATE cm/day east."""
import sys, datetime as dt
from pathlib import Path
import numpy as np, h5py
from pyproj import Transformer

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
site = sys.argv[2]
BOX = {"portuguese-bend": (-118.420, 33.715, -118.320, 33.790, [(34, "A", 18), (13, "D", 72)]),
       "central-valley": (-119.750, 36.000, -119.400, 36.250, [(34, "A", 20), (114, "D", 70)]),
       "destin": (-86.750, 30.330, -86.300, 30.550, [(76, "A", 17), (127, "D", 73)])}[site]
W, S, E, N, tracks = BOX
EPSG = 32616 if site == "destin" else 32611
STORM = dt.date(2026, 10, 10) if site == "destin" else None
UP_RATE, EAST_RATE = -0.20, 0.10          # cm/day
FREQ = 1.2575e9; LAM = 29979245800.0 / FREQ
PHASE_SIGN = -1.0
to_xy = Transformer.from_crs(4326, EPSG, always_xy=True)
cx, cy = to_xy.transform((W + E) / 2, (S + N) / 2)
half = 12000 if site == "portuguese-bend" else 32000
x = np.arange(cx - half, cx + half, 80.0); y = np.arange(cy + half, cy - half, -80.0)
X, Y = np.meshgrid(x, y)
sig = 1200.0 if site == "portuguese-bend" else 8000.0
if STORM:   # a coastal band of surface change, plus open water to the south that is never coherent
    band = np.exp(-((Y - (cy - 6000)) ** 2) / (2 * 2500.0 ** 2)) * np.exp(-((X - cx) ** 2) / (2 * 14000.0 ** 2))
    sea = Y < cy - 10500
blob = np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * sig ** 2))
rng = np.random.default_rng(0)
for track, d, frame in tracks:
    # NISAR looks left: ascending -> satellite east of target
    e = 0.60 if d == "A" else -0.60
    n = -0.12
    u = np.sqrt(1 - e * e - n * n)
    start = dt.date(2025, 11, 24 if d == "A" else 23)
    if STORM: start = dt.date(2026, 8, 18 if d == "A" else 22)
    for k in range(5 if STORM else 8):
        t0 = start + dt.timedelta(days=12 * k); t1 = t0 + dt.timedelta(days=12)
        los = 12 * (UP_RATE * u + EAST_RATE * e) * blob                    # cm toward satellite
        iono = (X - cx) / 5000.0 * rng.normal(0, 1) + (Y - cy) / 5000.0 * rng.normal(0, 1)   # radians, tilted plane
        phase = los * 4 * np.pi / LAM / PHASE_SIGN + rng.normal(0, 0.05, blob.shape) + rng.normal(0, 3) + iono
        coh = 0.8 - 0.6 * (blob > 0.97)                                    # decorrelated core
        if STORM:
            los = los * 0                                                  # no steady motion at the storm site
            coh = 0.75 + rng.normal(0, 0.04, blob.shape)
            if t0 < STORM <= t1: coh = coh - 0.55 * band
            coh = np.clip(np.where(sea, 0.12, coh), 0.02, 0.98)
        s = lambda t, hh: t.strftime("%Y%m%d") + hh
        name = (f"NISAR_L2_PR_GUNW_{6+k:03d}_{track:03d}_{d}_{frame:03d}_{7+k:03d}_4000_SH_"
                f"{s(t0,'T024109')}_{s(t0,'T024144')}_{s(t1,'T024109')}_{s(t1,'T024144')}_P05023_N_F_J_001.h5")
        with h5py.File(out / name, "w") as f:
            g = f.create_group("/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/HH")
            g["xCoordinates"] = x; g["yCoordinates"] = y; g["projection"] = np.uint32(EPSG)
            g.create_dataset("unwrappedPhase", data=phase.astype("f4"), chunks=(128, 128), compression="gzip")
            g.create_dataset("coherenceMagnitude", data=coh.astype("f4"), chunks=(128, 128), compression="gzip")
            g.create_dataset("connectedComponents", data=np.ones(blob.shape, "u2"), chunks=(128, 128))
            g.create_dataset("ionospherePhaseScreen", data=iono.astype("f4"), chunks=(128, 128), compression="gzip")
            mask = np.full(blob.shape, 131072 + 11, "u4"); mask[:5] = 111        # high bit set like real files; a strip of "water"
            f.create_dataset("/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/mask", data=mask, chunks=(128, 128))
            f["/science/LSAR/GUNW/grids/frequencyA/listOfPolarizations"] = np.array([b"HH"])
            f["/science/LSAR/GUNW/grids/frequencyA/centerFrequency"] = FREQ
            f["/science/LSAR/identification/orbitPassDirection"] = b"Ascending" if d == "A" else b"Descending"
            f["/science/LSAR/identification/lookDirection"] = b"Left"
            r = f.create_group("/science/LSAR/GUNW/metadata/radarGrid")
            r["heightAboveEllipsoid"] = np.array([-500.0, 0.0, 500.0])
            r["xCoordinates"] = x[::50]; r["yCoordinates"] = y[::50]
            shape = (3, y[::50].size, x[::50].size)
            # stored pointing satellite->ground on purpose, to exercise the orientation fix
            r["losUnitVectorX"] = np.full(shape, -e); r["losUnitVectorY"] = np.full(shape, -n)
print("wrote", len(list(out.glob("*.h5"))), "files; truth up %.2f east %.2f cm/day" % (UP_RATE, EAST_RATE))
