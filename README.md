# GPX Merge

A small browser app for merging GPX recordings of the same ride from different devices: power from a bike computer, heart rate from a watch, the GPS track from whichever recording is complete. The result is one GPX file to upload to Strava (or anywhere else).

Everything runs in the page. Files are read locally and never uploaded. There is no build step and no dependencies.

## Use it

- **Locally:** open `index.html` in a browser. Opening it straight from disk works fine.
- **GitHub Pages:** push the repo, then under *Settings → Pages* choose *Deploy from a branch*, branch `main`, folder `/ (root)`.

Drop in two or more GPX files, check the preview, and click **Download merged GPX**.

## How the merge works

1. **Base file.** By default this is the recording that has power (or the one with the most points). It supplies the GPS track and timestamps. You can change it.
2. **Clock alignment.** Device clocks drift by a few seconds. The app slides each file against the base, ±30 s, and picks the shift where cadence lines up best, or GPS speed if a file has no cadence. You can see the result in the "clock check" chart and change the offset by hand.
3. **Channels.** Elevation, power, heart rate, cadence and temperature are each taken from one file you choose. The default is whichever file covers the most of the ride.
4. **Short gaps** (5 s or less by default) are filled by drawing a line between the readings either side. A power or cadence gap that ends in a zero is the start of a coast, so it is filled with 0 rather than a made-up ramp.
5. **Longer gaps.** If a channel's chosen file has nothing for a stretch, for example because a device died mid-ride, the app borrows readings from another file that has them. If the base file has no points at all for a stretch, points from the other files are added to the track, with elevation adjusted to match. You can turn this off.
6. **Output.** GPX 1.1 with `<power>` and the Garmin `TrackPointExtension` fields for heart rate, cadence and temperature, the same layout Strava exports. GPS, elevation and timestamps from the base file are copied exactly as recorded.

## Files

```
index.html     page
css/style.css  styles (light and dark)
js/gpx.js      parsing, alignment, merging, GPX writing (also works in Node)
js/plot.js     small canvas line chart
js/app.js      UI
```

`js/gpx.js` has no browser dependencies, so you can script it in Node:

```js
const G = require('./js/gpx.js');
const files = [a, b].map(path => G.parseGPX(fs.readFileSync(path, 'utf8'), path));
const plan = G.autoPlan(files);
fs.writeFileSync('merged.gpx', G.writeGPX(G.merge(files, plan), { name: plan.name }));
```

## Limits

- GPX only. FIT and TCX files aren't read.
- Assumes one-second recording, or close to it. "Smart recording" files work, but with fewer points to compare when lining up clocks.
- Strava recalculates moving time and climbing itself, so those may differ a little from the preview.

## Privacy note

GPX files contain exact GPS tracks, often starting at your front door. `.gitignore` excludes `*.gpx` so ride files aren't committed by accident.
