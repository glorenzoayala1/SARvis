# SARwatch

NASA Space Apps 2026, "Dancing with the SARs". Ground motion from NISAR L-band interferograms,
for Portuguese Bend (landslide) and the Central Valley near Corcoran (subsidence).

## Layout
- `pipeline/SARwatch_pipeline.ipynb`: open in Colab. Searches NISAR GUNW, streams a crop per pair,
  builds the time series, then adds rainfall (NASA POWER), GPS stations (Nevada Geodetic Lab)
  and the Sentinel-1 record (OPERA DISP-S1). Writes `web_data/<site>/` and `<site>.zip`.
- `pipeline/sarwatch_pipeline.py`: same code as a script (jupytext pair of the notebook).
- `pipeline/make_synthetic.py`, `make_synthetic_s1.py`: write fake NISAR and Sentinel-1 files with a known answer for testing.
- `app/`: Next.js + MapLibre viewer. Reads `app/public/data/<site>/`.

## Run the pipeline (Colab)
1. Upload the notebook to Colab. Run cell 1 and 2. Set `MAX_PAIRS = 3` for the first run.
2. Cell 3 asks for your Earthdata login.
3. Cell 4 is the timing gate: one cropped pair should come back in well under 2 minutes.
4. Run the Central Valley site first (`SITE = "central-valley"`) and do the sign check in cell 6.
5. Set `MAX_PAIRS = None`, run both sites, download each `<site>.zip` and unzip into `app/public/data/<site>/`.
6. If a part-2 step blocks you, set `RUN_RAIN`, `RUN_GNSS` or `RUN_S1` to False and keep going.

## Run the app
    cd app && npm install && npm run dev      # http://localhost:3000
    npm run build                             # static site in app/out, deploy to Vercel

Deploy on Vercel: import the repo, set Root Directory to `app`, framework Next.js.

The radar layers shipped in `app/public/data` are SYNTHETIC (the app shows a banner). Rainfall and GPS in
that folder are real. Replace the folder contents with pipeline output.

## Self-test without Earthdata
    python pipeline/make_synthetic.py /tmp/synth portuguese-bend
    python pipeline/make_synthetic_s1.py /tmp/synth_s1 portuguese-bend
    SARWATCH_SYNTH=1 SARWATCH_SYNTH_DIR=/tmp/synth SARWATCH_SYNTH_S1_DIR=/tmp/synth_s1 SARWATCH_OUT=/tmp/web_data python pipeline/sarwatch_pipeline.py

## Not yet verified against real files
- Phase sign convention (`PHASE_SIGN`). Check on Central Valley: subsidence must be negative.
- Meaning of the `mask` layer digits (`USE_MASK` is off).
- Both reference boxes are first guesses.
- Streaming speed from Colab.
- Sentinel-1 sign convention (`S1_SIGN`), same Central Valley check.
- `focus_box` for Portuguese Bend is a rough box around the slide.
- On-slide ground truth: the City of Rancho Palos Verdes survey spreadsheets ("PB MOVEMENT DATA POSTING ...xlsx")
  have no public URL that I could find. Get them from the city, convert to the `SURVEY_CSV` columns, and the app
  will show those points like GPS stations. Until then the GPS check only covers stable ground off the slide.

## Credits to cite in the submission
- NISAR L2 GUNW provisional products, ASF DAAC / NASA / ISRO.
- HDF5 paths from MintPy `prep_nisar.py` (insarlab/MintPy).
- Search and version-filter logic adapted from ASF OpenSARLab MintPy Recipe Book (BSD-3-Clause).
- OPERA DISP-S1 and DISP-S1-STATIC, JPL OPERA / ASF DAAC; file layout and rebase rule from opera-adt/opera-utils.
- Rainfall: NASA POWER (MERRA-2). GPS: Nevada Geodetic Laboratory daily solutions.
- Basemap: OpenStreetMap contributors. Map library: MapLibre GL JS.
