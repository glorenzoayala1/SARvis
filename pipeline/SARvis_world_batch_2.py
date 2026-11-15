# ---
# jupyter:
#   jupytext:
#     text_representation:
#       extension: .py
#       format_name: percent
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# %% [markdown]
# # SARvis: the four full-year places
# Run the three cells in order. Cell 2 asks for your Earthdata login once. Cell 3 then works through the list
# on its own and downloads one zip per place plus `world.zip` with all of them.
#
# To finish sooner, open this notebook in two or three browser tabs and give each tab a different part of the list.

# %%
# 1. Get the pipeline
# !rm -rf SARvis && git clone -q https://github.com/glorenzoayala1/SARvis.git
# !pip install -q earthaccess pyproj h5py

# %%
# 2. Log in to Earthdata once (saved for the rest of this session)
import earthaccess
earthaccess.login(persist=True)

# %%
# 3. Run the list. Edit PLACES to split the work across tabs.
PLACES = ["mexico-city", "kilauea", "reykjanes", "delhi"]      # about 20 minutes each (a full year of passes)
import os, runpy, shutil, time, traceback
import matplotlib; matplotlib.use("Agg")           # plots go to files, not the screen
done, failed = [], []
for place in PLACES:
    t0 = time.time(); os.environ["SARVIS_SITE"] = place; os.environ["SARVIS_OUT"] = "web_data"
    print(f"\n=================== {place} ===================")
    try:
        runpy.run_path("SARvis/pipeline/sarvis_pipeline.py", run_name="__main__")
        shutil.make_archive(f"web_data/{place}", "zip", f"web_data/{place}")
        done.append(place); print(f"{place}: finished in {(time.time() - t0) / 60:.0f} min")
    except BaseException as e:                      # one bad place must not stop the rest
        if isinstance(e, KeyboardInterrupt): raise
        failed.append(place); print(f"{place}: FAILED after {(time.time() - t0) / 60:.0f} min"); traceback.print_exc()
print("\nfinished:", done, "\nfailed:", failed)
os.makedirs("world", exist_ok=True)
for place in done: shutil.copy(f"web_data/{place}.zip", f"world/{place}.zip")
shutil.make_archive("world", "zip", "world")
try:
    from google.colab import files; files.download("world.zip")
except Exception: print("Download world.zip from the file panel on the left.")
