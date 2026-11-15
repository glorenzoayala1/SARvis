"""Work out the findings shown in the app from the exported data, and write app/public/data/findings.json.

Every number in the app's Findings tab comes from this file, and this file comes only from the data folders.
Re-run it whenever a site's data changes:

    python pipeline/findings.py app/public/data
"""
import json, sys, datetime as dt, calendar
import numpy as np

root = sys.argv[1]
day = lambda x: dt.date(int(x[:4]), int(x[4:6]), int(x[6:]))
nice = lambda x: f"{day(x).day} {calendar.month_abbr[day(x).month]} {day(x).year}"
month = lambda y, m: f"{calendar.month_name[m]} {y}"
pct = lambda v: f"{round(100 * v)}%"

def grid(folder, meta, L):
    raw = np.fromfile(f"{folder}/{L['file']}", dtype="<i2").reshape(len(L["dates"]), meta["ny"], meta["nx"])
    a = raw.astype(float); a[raw == meta["nodata"]] = np.nan
    return a * meta["scale"]

def u8(folder, meta, name, frames):
    raw = np.fromfile(f"{folder}/{name}", dtype="u1").reshape(frames, meta["ny"], meta["nx"]).astype(float)
    raw[raw == 255] = np.nan
    return raw / 250.0

def box_mask(meta, box):
    w, s, e, n = meta["bbox"]; nx, ny = meta["nx"], meta["ny"]
    xs = w + (np.arange(nx) + .5) * (e - w) / nx; ys = n - (np.arange(ny) + .5) * (n - s) / ny
    # same rule as the app: every pixel the box touches counts, including the ones its edges cut through
    i0, i1 = max(0, int((box[0] - w) / (e - w) * nx)), min(nx - 1, int((box[2] - w) / (e - w) * nx))
    j0, j1 = max(0, int((n - box[3]) / (n - s) * ny)), min(ny - 1, int((n - box[1]) / (n - s) * ny))
    m = np.zeros((ny, nx), bool); m[j0:j1 + 1, i0:i1 + 1] = True
    return m, xs, ys

def monthly_speed(dates, series):
    """cm per 30 days for each calendar month that the record covers almost fully"""
    moved, covered = {}, {}
    for k in range(1, len(dates)):
        d0, d1 = day(dates[k - 1]), day(dates[k]); span = (d1 - d0).days; step = (series[k] - series[k - 1]) / span
        for i in range(span):
            d = d0 + dt.timedelta(i); key = (d.year, d.month)
            moved[key] = moved.get(key, 0) + step; covered[key] = covered.get(key, 0) + 1
    return {k: moved[k] / covered[k] * 30 for k in moved if covered[k] >= calendar.monthrange(*k)[1] - 3}

def monthly_rain(ctx):
    out = {}
    for d, v in zip(ctx["rain"]["dates"], ctx["rain"]["mm"]):
        if v is not None: out[(int(d[:4]), int(d[4:6]))] = out.get((int(d[:4]), int(d[4:6])), 0) + v
    return out

def motion_site(folder, meta, ctx):
    L = next(l for l in meta["layers"] if l["key"] == "up"); d = L["dates"]; a = grid(folder, meta, L)
    fm, xs, ys = box_mask(meta, meta["focus_box"]); last = np.where(fm, a[-1], np.nan); ok = np.isfinite(last)
    j, i = np.unravel_index(np.nanargmin(last), last.shape)
    peak = float(last[j, i]); box_mid = float(np.nanmedian(last))
    moving = ok & (last < -10)                                           # the part of the study box that sank more than 10 cm
    series = np.nanmedian(a[:, moving], axis=1)
    ms = monthly_speed(d, -series); rain = monthly_rain(ctx)
    fast = max(ms, key=ms.get); slow = min(ms, key=ms.get); wet = max((k for k in rain if k in ms), key=lambda k: rain[k])
    sp, rn = [], []
    for k in range(1, len(d)):
        d0, d1 = day(d[k - 1]), day(d[k]); sp.append(-(series[k] - series[k - 1]) / (d1 - d0).days * 30)
        rn.append(sum(v or 0 for x, v in zip(ctx["rain"]["dates"], ctx["rain"]["mm"]) if d0 < day(x) <= d1))
    corr = float(np.corrcoef(sp, rn)[0, 1])
    cov = ctx.get("coverage") or {}
    n = {"from": d[0], "to": d[-1], "days": (day(d[-1]) - day(d[0])).days, "peak_cm": round(peak, 1), "peak_at": [round(float(ys[j]), 4), round(float(xs[i]), 4)],
         "box_middle_cm": round(box_mid, 1), "share_over_10cm": round(float(moving.sum() / ok.sum()), 3), "moving_middle_cm": round(float(series[-1]), 1),
         "fastest_month": [*fast, round(ms[fast], 1)], "slowest_month": [*slow, round(ms[slow], 1)], "wettest_month": [*wet, round(rain[wet]), round(ms[wet], 1)],
         "speed_rain_correlation": round(corr, 2), "coverage": cov}
    big = f"{abs(peak) / 100:.1f} m" if abs(peak) >= 100 else f"{abs(peak):.0f} cm"
    points = [f"Between {nice(d[0])} and {nice(d[-1])} ({n['days']} days) the fastest spot sank {abs(peak):.0f} cm.",
              f"{pct(n['share_over_10cm'])} of the study box sank more than 10 cm. Across that part the middle value is {abs(series[-1]):.0f} cm.",
              f"It sank fastest in {month(*fast)} ({ms[fast]:.1f} cm a month)" + (f" and slowest in {month(*slow)} ({ms[slow]:.1f} cm a month)." if ms[slow] >= 0 else f". In {month(*slow)} it rose instead ({-ms[slow]:.1f} cm).")]
    px = a[:, j, i]; steps = np.diff(px[np.isfinite(px)]); n["peak_steps_down"] = [int((steps < 0).sum()), int(len(steps))]; n["peak_largest_step_cm"] = round(float(np.max(np.abs(steps))), 1)
    if abs(corr) < 0.4:
        points.append(f"The wettest month was {month(*wet)} ({rain[wet]:.0f} mm of rain), when it sank {ms[wet]:.1f} cm. Pass by pass, speed and rain barely line up (correlation {corr:.2f}).")
    else:
        points.append(f"Speed followed rain from pass to pass (correlation {corr:.2f}). The wettest month was {month(*wet)} ({rain[wet]:.0f} mm).")
    if cov.get("s1") and cov.get("window"):
        na, nd, sa, sd = cov["nisar"]["asc"], cov["nisar"]["desc"], cov["s1"]["asc"], cov["s1"]["desc"]
        points.append(f"From {nice(cov['window'][0])} to {nice(cov['window'][1])}, when both radars were flying, NISAR got a usable reading in the study box on {pct(na)} and {pct(nd)} of passes (its two directions). Sentinel-1 got {pct(sa)} and {pct(sd)}.")
        n["nisar_minus_s1"] = round((na + nd - sa - sd) / 2, 3)
    return n, big, f"the fastest spot sank, {nice(d[0])} to {nice(d[-1])}", points, month(*fast), month(*slow)

out = {"generated": dt.date.today().isoformat(), "sites": {}}
for site in json.load(open(f"{root}/index.json")):
    folder = f"{root}/{site}"; meta = json.load(open(f"{folder}/meta.json")); ctx = json.load(open(f"{folder}/context.json"))
    if meta.get("synthetic"): continue                                   # never state findings from demo data
    if meta.get("first_look"): continue                                  # first-look places are shown on the map but are not conclusions
    if not meta.get("event"):
        n, big, note, points, fast, slow = motion_site(folder, meta, ctx)
        if meta.get("tied_to"):
            st = next(x for x in ctx["gnss"]["stations"] if x["id"] == meta["tied_to"]); u = np.array([np.nan if v is None else v for v in st["u"]], float)
            sm = np.array([np.nanmean(u[max(0, k - 3):k + 4]) for k in range(len(u))])          # 7-day average
            lo = next(k for k, x in enumerate(st["dates"]) if x >= n["from"]); hi = max(k for k, x in enumerate(st["dates"]) if x <= n["to"])
            pk = lo + int(np.nanargmax(sm[lo:hi + 1])); rise, fall = sm[pk] - sm[lo], sm[pk] - sm[hi]
            n["gps"] = {"station": st["id"], "rise_cm": round(float(rise), 1), "peak": st["dates"][pk], "fall_cm": round(float(fall), 1)}
            points.insert(0, f"GPS station {st['id']} rose {rise:.1f} cm from {nice(st['dates'][lo])} to {nice(st['dates'][pk])}, then sank {fall:.1f} cm by {nice(st['dates'][hi])}.")
            conclusion = (f"The ground here rose slightly through the winter and then sank steadily from {calendar.month_name[day(st['dates'][pk]).month]} on, "
                          f"by {abs(n['moving_middle_cm']):.0f} cm across the sinking part of the study box and {abs(n['peak_cm']):.0f} cm at the deepest spot by {nice(n['to'])}.")
            sure = (f"The first run disagreed with GPS by up to {meta['processing']['tie']['up']['largest_shift_cm']:.0f} cm, so every date is pinned to GPS station {st['id']}. "
                    "That station sets the zero and is not an independent check. East-west motion is left out because the two viewing directions disagree.")
        else:
            conclusion = (f"The slide moved the whole time from {nice(n['from'])} to {nice(n['to'])}, up to {abs(n['peak_cm']) / 100:.1f} m at its fastest spot. "
                          f"It sank fastest in {fast} and slowest in {slow}.")
            if n.get("nisar_minus_s1", 0) > 0.1: conclusion += " NISAR kept a reading on the slide far more often than Sentinel-1 did."
            sure = ("The only GPS stations are off the slide, so the largest numbers have no ground measurement to confirm them. "
                    f"The fastest spot went down in {n['peak_steps_down'][0]} of its {n['peak_steps_down'][1]} steps between passes, and its largest single step was {n['peak_largest_step_cm']:.0f} cm, so the total is not the product of one bad reading.")
        out["sites"][site] = {"place": meta["name"], "kind": "motion", "big": big, "big_note": note, "conclusion": conclusion, "points": points, "sure": sure, "numbers": n}
    else:
        ev = meta["event"]; ss = meta["signal_series"]; n = {"landfall_utc": ev["utc"], "tracks": {}}; points = []; drops = []
        fm, _, _ = box_mask(meta, meta["focus_box"])
        for tr, name in (("asc", "ascending"), ("desc", "descending")):
            S = ss[tr]; q = u8(folder, meta, S["file"], len(S["dates"])); mean = [float(np.nanmean(x)) for x in q]; k = S["storm_pair"]
            calm = float(np.mean([v for i, v in enumerate(mean) if i != k])); imp = u8(folder, meta, f"{tr}_impact.u8", 1)[0]; ok = np.isfinite(imp)
            n["tracks"][tr] = {"storm_pass": [S["starts"][k], S["dates"][k]], "storm_quality": round(mean[k], 3), "calm_quality": round(calm, 3), "calm_passes": len(mean) - 1,
                               "drop": round(1 - mean[k] / calm, 3), "box_share_changed_over_30pct": round(float((imp[fm & ok] > 0.3).mean()), 3), "area_with_reading": round(float(ok.mean()), 3)}
            drops.append(1 - mean[k] / calm)
            points.append(f"{name.capitalize()} direction: average signal quality was {calm:.2f} over the {len(mean) - 1} calm passes before the storm, and {mean[k]:.2f} in the pass from {nice(S['starts'][k])} to {nice(S['dates'][k])}, which spans landfall. That is a {pct(1 - mean[k] / calm)} drop.")
        a, d_ = n["tracks"]["asc"], n["tracks"]["desc"]
        points.append(f"Inside the study box on the coast, {pct(d_['box_share_changed_over_30pct'])} of the ground changed by more than 30% in the descending direction but only {pct(a['box_share_changed_over_30pct'])} in the ascending one.")
        both = u8(folder, meta, "impact.u8", 1)[0]; n["area_with_reading"] = round(float(np.isfinite(both).mean()), 3)
        points.append(f"Only {pct(n['area_with_reading'])} of the area gives a reading in both directions. The rest is water or ground the radar could not follow.")
        conclusion = (f"NISAR recorded Hurricane Isaias passing: signal quality fell by {pct(min(drops))} to {pct(max(drops))} in the passes that span landfall ({nice(ev['utc'])} UTC, the evening before in local time). "
                      "The two viewing directions do not agree on where the ground changed, so this is evidence of the storm, not a damage map.")
        sure = f"The baseline is only {a['calm_passes']} calm passes per direction, and it includes heavy rain in early October. {ev.get('note', '')}"
        out["sites"][site] = {"place": meta["name"], "kind": "event", "big": f"{pct(min(drops))} to {pct(max(drops))}", "big_note": f"drop in signal quality in the storm pass (landfall {nice(ev['utc'])} UTC)",
                              "conclusion": conclusion, "points": points, "sure": sure.strip(), "numbers": n}

# one line across all sites, only from numbers above
s = out["sites"]; parts = []
if "portuguese-bend" in s: parts.append(f"a landslide that sank up to {abs(s['portuguese-bend']['numbers']['peak_cm']) / 100:.1f} m")
if "central-valley" in s: parts.append(f"farmland that sank up to {abs(s['central-valley']['numbers']['peak_cm']):.0f} cm")
if "destin" in s: parts.append("a hurricane landfall that showed up as a loss of signal")
out["overall"] = "In under a year of data, NISAR measured " + ", ".join(parts[:-1]) + (", and " if len(parts) > 1 else "") + parts[-1] + "."
adv = [(k, v["numbers"].get("nisar_minus_s1")) for k, v in s.items() if v["numbers"].get("nisar_minus_s1") is not None]
if adv:
    best = max(adv, key=lambda x: x[1]); worst = min(adv, key=lambda x: x[1])
    out["overall"] += (f" Against Sentinel-1, its advantage was large on the steep, vegetated slide ({round(100 * best[1])} percentage points more passes with a reading)"
                       + (f" and small on open farmland ({round(100 * worst[1])} points)." if worst[0] != best[0] else "."))
json.dump(out, open(f"{root}/findings.json", "w"), indent=1)
print(json.dumps(out, indent=1))
