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
       "central-valley": (-119.750, 36.000, -119.400, 36.250, [(34, "A", 20), (114, "D", 70)])}[site]
W, S, E, N, tracks = BOX
UP_RATE, EAST_RATE = -0.20, 0.10          # cm/day
FREQ = 1.2575e9; LAM = 29979245800.0 / FREQ
PHASE_SIGN = -1.0
to_xy = Transformer.from_crs(4326, 32611, always_xy=True)
cx, cy = to_xy.transform((W + E) / 2, (S + N) / 2)
x = np.arange(cx - 12000, cx + 12000, 80.0) if site == "portuguese-bend" else np.arange(cx - 30000, cx + 30000, 80.0)
y = (np.arange(cy + 12000, cy - 12000, -80.0) if site == "portuguese-bend" else np.arange(cy + 30000, cy - 30000, -80.0))
X, Y = np.meshgrid(x, y)
sig = 1200.0 if site == "portuguese-bend" else 8000.0
blob = np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2 * sig ** 2))
rng = np.random.default_rng(0)
for track, d, frame in tracks:
    # NISAR looks left: ascending -> satellite east of target
    e = 0.60 if d == "A" else -0.60
    n = -0.12
    u = np.sqrt(1 - e * e - n * n)
    start = dt.date(2025, 11, 24 if d == "A" else 23)
    for k in range(8):
        t0 = start + dt.timedelta(days=12 * k); t1 = t0 + dt.timedelta(days=12)
        los = 12 * (UP_RATE * u + EAST_RATE * e) * blob                    # cm toward satellite
        phase = los * 4 * np.pi / LAM / PHASE_SIGN + rng.normal(0, 0.05, blob.shape) + rng.normal(0, 3)
        coh = 0.8 - 0.6 * (blob > 0.97)                                    # decorrelated core
        s = lambda t, hh: t.strftime("%Y%m%d") + hh
        name = (f"NISAR_L2_PR_GUNW_{6+k:03d}_{track:03d}_{d}_{frame:03d}_{7+k:03d}_4000_SH_"
                f"{s(t0,'T024109')}_{s(t0,'T024144')}_{s(t1,'T024109')}_{s(t1,'T024144')}_P05023_N_F_J_001.h5")
        with h5py.File(out / name, "w") as f:
            g = f.create_group("/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/HH")
            g["xCoordinates"] = x; g["yCoordinates"] = y; g["projection"] = np.uint32(32611)
            g.create_dataset("unwrappedPhase", data=phase.astype("f4"), chunks=(128, 128), compression="gzip")
            g.create_dataset("coherenceMagnitude", data=coh.astype("f4"), chunks=(128, 128), compression="gzip")
            g.create_dataset("connectedComponents", data=np.ones(blob.shape, "u2"), chunks=(128, 128))
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
