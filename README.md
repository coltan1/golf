# Sunny Links — Hole 1

A calm, stylised 3D golf game. One hole, played with a single swipe.

Three.js + vanilla ES modules. No build step, no bundler, no assets — every
texture, sound and piece of geometry is generated at runtime.

## Running it

ES modules need to be served over HTTP (opening `index.html` straight off disk
will fail on CORS):

```bash
node serve.mjs
```

Then open <http://localhost:5177>. Three.js is loaded from a CDN via an import
map, so the first load needs a network connection.

`serve.mjs` is a ~50-line static server whose only real job is sending
`Cache-Control: no-store`. Without that, browsers apply *heuristic* freshness to
responses carrying only `Last-Modified` — the longer a file has gone unchanged,
the longer it gets cached — so the file you finally edit after a while is
exactly the one that goes stale. The page still renders; it just isn't running
your code. Any static server works, but plain `python -m http.server` will bite
you this way.

## Freecam

Press **F**, or call `freecam()` from the browser console. The game keeps
simulating while you fly, so you can hit a shot and go watch it from anywhere.

| | |
|---|---|
| Move | `W` `A` `S` `D`, `Q` down / `E` up |
| Look | drag |
| Speed | `shift` fast · `ctrl` slow · mouse wheel to set |
| Exit | `F` — the game camera eases back into framing rather than cutting |

From the console: `freecam.goto(x, y, z)`, `freecam.lookAt(x, y, z)`,
`freecam.off()`. Handy targets — the pond is around `(-58, -286)`, the green
`(31, -388)`, the tee `(0, 6)`.

## Playing

| | |
|---|---|
| **Swing** | Press and hold, swipe **down** to load the backswing, then flick **up** to release |
| **Shape it** | Finish the forward flick to the left or right to draw or fade the ball |
| **Aim** | Drag **sideways** before you start the backswing (or `←` / `→`) |
| **Cancel** | Lift your finger without flicking forward — the club eases back, no shot |
| **Keyboard** | Hold `Space` to charge, release to swing |

Power comes from how far you pull *and* how fast. A committed forward flick
adds a little pop — it never subtracts, and there is no randomness anywhere.
The club is chosen for you based on the distance left and your lie.

## Architecture

```
index.html        import map, HUD markup, all CSS
src/
  main.js         bootstrap, game state machine, frame loop
  course.js       the hole, described once — layout maths, terrain height,
                  surface classification, and the baked course texture
  terrain.js      sculpted ground mesh, pond surface, toon ramp
  scenery.js      sky dome, lighting, clouds, backdrop hills
  props.js        instanced trees, clubhouse village, flagstick, tee markers
  golfer.js       the character and the swing rig
  ball.js         arcade flight arc, bounce/roll, trail and effects
  input.js        the swipe gesture (aim vs. charge vs. release)
  camerarig.js    damped camera, one desired framing per mode
  aimline.js      terrain-hugging aim ribbon
  audio.js        synthesised ambience and cues
  hud.js          thin wrapper over the DOM overlay
  util.js         easing, damping, seeded RNG
```

### Matching the reference art direction

**Cel shading.** Every lit surface in the game uses `MeshToonMaterial` with one
shared 16-step ramp (`makeToonRamp` in [terrain.js](src/terrain.js)) — terrain,
trees, character, buildings, ball, even the pond. Three things had to be true
together for the bands to actually show up:

- *The ramp floors low (0.15), not high.* Shadow fill comes from the hemisphere
  light, which is indirect and never passes through the ramp. Flattening the
  ramp to lift shadows is what turns cel shading back into smooth shading.
- *The hemisphere light stays modest relative to the sun.* It adds smoothly, so
  if it dominates it washes the steps out.
- *Tone mapping is off.* A filmic curve compresses everything above ~0.8, which
  is exactly where the brightest two bands live. With `NoToneMapping` the output
  is `albedo × light / π` and the steps land as authored.

The sun sits at 45°, which is the other half of it: much lower and open ground
never climbs out of a mid band, dragging the whole course dark. At 45° flat turf
lands one band below the top, so ground that rolls sunward pops to full and
ground that rolls away drops a step.

Geometry is smooth-normalled throughout — with a hard ramp, smooth normals give
clean curved bands, where flat shading would give facets instead. The conifers
are one lathe each, with the tier rims scalloped around the circumference for a
bumpy silhouette.

Four more things carry the look:

**Forested backdrop.** Three layers of ridges ringing the course
([scenery.js](src/scenery.js)), each a squashed sphere displaced by
canopy-scale noise — that bumpy silhouette is what reads as treetops from a
distance, for one smooth mesh instead of thousands of tree instances. They're
real toon-shaded geometry, not a matte, so they cel-shade on the same ramp as
everything else and the horizon never looks like it came from a different game.
Depth comes from fog rather than baked haze, which is what lets them be lit.

The noise frequency is the thing to get right, and it is easy to get wrong:
`fbm2` stacks harmonics up to **6.3× its base frequency** internally, so asking
for 40-yard canopy clumps directly produces 6-yard detail underneath them. On a
7-yard vertex grid that aliases into hard triangular facets. Pick the base so
the *top* harmonic still has four or five vertices across it.

Depth is carried by colour, not just fog: each layer steps darker, cooler and
bluer, so the backdrop separates from the warm yellow-green course instead of
melting into it. Heavy fog washes every layer to the same pale value and
collapses exactly the depth you were trying to create.

**Mowing lines.** They run *down* the line of play and curve with the dogleg,
keyed on signed perpendicular distance from the centreline. Two patterns share
one `MOW_PERIOD` (in [course.js](src/course.js)) against that same value, so
they stay exactly in phase: broad bands baked into the course texture, which
survive to any distance, plus crisper per-pixel grooves in the terrain shader
fed by a custom `aCourse` vertex attribute. `fwidth` fades the shader grooves
out the moment they get finer than the pixel grid, so the fairway recedes
smoothly instead of shimmering.

**Boundaries are geometry, not just colour.** What makes a hole read as a golf
hole is that every mowing line is a real edge:

- *Height.* Rough is left long and the fairway and green are cut short, so
  there's an actual lip at each boundary — the rough sits ~0.34 yards proud,
  and the green is a built-up pad on a tight shoulder. That step catches the
  light, and a lit edge reads far harder than a colour change.
- *Per-pixel sharpening.* `aCourse` carries the raw *signed distance* to the
  fairway and green edges rather than pre-blended masks, because a mask baked
  at vertex resolution is already smeared over a couple of yards by the time it
  interpolates and no shader work gets that edge back. The fragment shader
  thresholds it against its own `fwidth`, so a mowing line stays a line right
  under the camera.
- *The cut seam.* Long grass standing against short throws a thin shadow along
  every boundary. It's a small effect that does more for the golf-course read
  than any amount of colour difference.

The cart path gets the same treatment: concrete with aggregate speckle, tyre
tracks and weathered edges in the bake, plus crisp slab edges and expansion
joints drawn per-pixel — joints are a few inches wide, which no practical
texture resolution could hold.

The putting green is left completely clean — no stripes, no mottle, no grain,
and only a trace of undulation. It's the shortest, most uniform cut on the
course, and leaving it bare is what makes it read that way against the patchy
rough and striped fairway around it.

That needs *two* separate masks in the `aCourse` attribute, not one. The green
wants no grooves and no grain; the rough wants no grooves but maximum grain.
Driving both from a single "is this mown" value silently gives the green full
rough-strength texture — which is exactly the bug that shipped in an earlier
pass here.

**Cool shadows.** The hemisphere fill is blue, so shadows read blue rather than
grey — and because that fill is the only light reaching shadowed surfaces, its
colour *is* the shadow colour. The sun is off to the left, so shadows fall right
and toward the camera.

**Stylised water.** The pond is deliberately *unlit*. Toon lighting on a
rippling surface gives you bands that follow the wave normals, which reads as
shiny plastic; cartoon water wants flat shapes drawn *on* the surface instead.
So the colour is authored directly in the shader — a depth gradient from
turquoise shallows to deep teal, hard-thresholded crest highlights drifting
across it, and a foam line hugging the shore whose width wobbles around the
perimeter so it never looks like a stroked ellipse. Fragments outside the pond
ellipse are discarded, so the waterline is the real shore rather than the
plane's square edge. Everything animates from one `uTime` uniform, so there's
no per-frame vertex work and no normal recomputation at all.

**Rough that reads as rough.** Three things stacked, each covering a distance
band the others can't. Colour patches baked into the course texture survive to
any distance. Real relief in `heightAt` makes the rough genuinely lumpy so it
catches the ramp's bands and shades itself — one long-wavelength octave only,
since anything shorter than about four vertices per bump facets on the ~3 yard
terrain grid. And per-pixel turf grain in the shader supplies the tuft-scale
detail a 0.76 yard-per-texel bake can never hold, at three scales that each
fade out at their own Nyquist limit so the rough never boils as the camera
moves. Mown surfaces get a trace of the same grain, just enough that the
fairway doesn't look like plastic.

**Downhill composition.** An elevated tee drops ~15 yards over the first
hundred, so the hole falls away from you and opens up the view — the reference's
looking-down-the-slope framing.

### Two ideas do most of the work

**`course.js` is the single source of truth.** The baked fairway texture, the
sculpted heightfield, and the ball's friction, bounce and penalties all read
from the same `heightAt` / `surfaceAt` functions. The ball therefore always
behaves the way the ground *looks* like it should — if you can see stripes,
you're on the fairway, and the ball knows it.

**Flight is parametric, not simulated.** `ball.js` decides up front where a
shot is going and traces a graceful arc to get there: horizontal progress
decays exponentially, the apex sits just past halfway, and any curve builds
late. Only when the ball lands does a small, gently-tuned integrator take over
for bounce and roll. The arc gets the poetry; the integrator gets the last
twenty yards right.

Everything else is damping. `damp(current, target, lambda, dt)` in `util.js` is
frame-rate independent exponential smoothing, and it drives the camera, the
club during the backswing, the aim ribbon's fade and the character's idle
motion. Nothing in the game snaps.

### The swing

The whole animation is one number, `theta`, in `golfer.js`:

```
theta < 0   backswing
theta = 0   impact — the club head sits exactly on the ball
theta > 0   follow-through
```

Coil, wrist hinge, weight shift and head rotation are all derived from it,
which is why the motion reads as one connected body rather than parts moving
independently. The rig is built with the ball at the origin and the target at
-Z, so the swing plane naturally contains the target line. The downswing
follows `t^1.75` — slowest at the top, fastest exactly at impact — and the
wrists release late, which is what gives it snap.

## Tuning

Most of the feel lives in a handful of constants:

- `ball.js` → `CLUBS` (carry, apex ratio, run-out), `SURF` (friction and
  bounce per surface), `GRAVITY`
- `golfer.js` → `BACK_MAX`, `DOWN_DUR`, `THROUGH_DUR`, `HOLD_DUR`
- `input.js` → `RELEASE_DIST`, `RELEASE_VEL`, `chargePixels`
- `camerarig.js` → the per-mode `back` / `up` / `lamPos` / `lamLook` values
- `terrain.js` → `makeToonRamp` steps (band count and separation), and the
  groove `period` / strength in the shader patch
- `course.js` → `MOW_PERIOD`: yards between mowing passes. Bigger = wider,
  fewer stripes. Drives both the baked bands and the shader grooves
- `scenery.js` → `createLights` intensities (see the note there before changing
  them — hemi and sun trade off against band crispness), and the `LAYERS` array
  in `createBackdrop`: ring radius, silhouette height and colour per forest layer
- `course.js` → `PATH_POINTS`, `fairwayHalfWidth`, `BUNKERS`, `POND`, and the
  `C` colour palette

Reshaping the hole is a matter of moving `PATH_POINTS` — the texture, the
terrain, the tree line and the ball physics all follow automatically.
