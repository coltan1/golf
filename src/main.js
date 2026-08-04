/**
 * main.js — bootstrap, game state machine, and the frame loop.
 *
 * Flow of a shot:
 *   ready → charging → swinging → watching → settling → ready
 * Every transition is driven either by the swipe gesture or by the ball
 * coming to rest, and every one of them is unhurried on purpose.
 */

import * as THREE from 'three';
import { clamp, lerp } from './util.js';
import {
  heightAt, surfaceAt, distToHole, aimPointAhead,
  HOLE_POS, TEE, PAR, HOLE_LENGTH, HOLE, setHole, POND, CREEK, OCEAN,
} from './course.js';
import { createTerrain, createWater, createOcean, createCreek, makeToonRamp, makeGroundRamp } from './terrain.js';
import { createSky, createLights, createClouds, createBackdrop, FOG_COLOR, timeOfDay, setTimeOfDay, TIMES } from './scenery.js';
import {
  createTrees, createGrass, createClubhouse, createFlag, createTeeMarkers, createBridge,
  createSeaStacks, createLavaRocks,
  treeMapTexture,
} from './props.js';
import { Golfer, DEFAULT_LOOK, LOOK_PRESETS } from './golfer.js';
import { Ball, CLUBS, pickClub } from './ball.js';
import { SwipeSwing } from './input.js';
import { CameraRig } from './camerarig.js';
import { AimLine } from './aimline.js';
import { Cart, createCartControls, HIT_RADIUS } from './cart.js';
import { createSunRays, createButterflies, createSeagulls, createMotes, createSpray } from './ambience.js';
import { FreeCam } from './freecam.js';
import { Audio } from './audio.js';
import { Hud, scoreName } from './hud.js';
import { createKitControls } from './kit.js';
import { createMenu } from './menu.js';
import { createAdminMenu } from './admin.js';
import { installWoodVars } from './woodtex.js';

// Drawn before anything asks for them. The loading screen is the first thing
// anyone sees and it is made of the same wood as the rest, so the textures
// have to exist by the time it paints rather than a frame later.
installWoodVars();
import { Match } from './match.js';
import { COURSES, COURSE, HOLES, TOTAL_PAR, setCourse } from './courses.js';

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Starting point only — adaptResolution() below takes over from here.
const MAX_SCALE = Math.min(window.devicePixelRatio, 2);
const MIN_SCALE = 0.7;
renderer.setPixelRatio(MAX_SCALE);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// No tone curve. A filmic response is the enemy of cel shading — it rolls off
// exactly the top end where the brightest two bands live, smearing them back
// into each other. With it off, output is albedo × light/π directly, so the
// ramp's steps land on screen as authored. Peak light is ~0.9 of albedo, so
// nothing clips.
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Pulled well back on purpose. Heavy fog was washing every backdrop layer to
// the same pale value as the course and collapsing the depth — the ridges now
// carry their own recession in colour, and fog only softens the far edge.
scene.fog = new THREE.Fog(FOG_COLOR, 450, 2600);

const camera = new THREE.PerspectiveCamera(53, window.innerWidth / window.innerHeight, 0.5, 3000);

const hud = new Hud();
const audio = new Audio();

// ---------------------------------------------------------------- world
let cart, cartCtl, driveT = 0;
let terrain, water, ocean, spray, creek, clouds, flag, clubhouse, golfer, ball, rig, aimLine, input, lights, freeCam;
let sunRays, fliers, motes;
let match = null;

// Everything belonging to the current hole hangs off this, so switching holes
// is a matter of disposing one subtree rather than tracking every object.
let worldGroup = null;

/** Release GPU memory for a subtree. Geometries and materials are per-hole. */
function disposeWorld() {
  if (!worldGroup) return;
  worldGroup.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'gradientMap', 'alphaMap']) if (m[k]) m[k].dispose();
      m.dispose();
    }
  });
  scene.remove(worldGroup);
  worldGroup = null;
}

/**
 * Lights hang off the scene rather than the world group — they outlive a hole
 * change on purpose — so disposeWorld never sees them, and a new time of day
 * would otherwise stack a second sun on top of the first.
 */
function disposeLights() {
  if (!lights) return;
  for (const l of [lights.hemi, lights.sun, lights.sun?.target, lights.rim]) {
    if (l) scene.remove(l);
  }
  lights.sun?.shadow?.map?.dispose();
  lights = null;
}

/**
 * The player's look, kept outside the world so it survives a hole change —
 * buildWorld throws the whole subtree away and makes a new Golfer each time —
 * and outside the session, because having to restyle every visit would make
 * the whole feature a toy.
 */
// Versioned. A look saved before the figure was redesigned would load over the
// new default and the redesign would simply not appear for anyone who had ever
// opened the customiser — so the key moves with the design.
const LOOK_KEY = 'sunnylinks.look.v2';

function loadLook() {
  try {
    const raw = localStorage.getItem(LOOK_KEY);
    return raw ? { ...DEFAULT_LOOK, ...JSON.parse(raw) } : { ...DEFAULT_LOOK };
  } catch { return { ...DEFAULT_LOOK }; }
}

function saveLook(look) {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* private mode */ }
}

let playerLook = loadLook();
let menu = null;
let kitPanel = null;

function buildWorld() {
  const ramp = makeToonRamp();
  const groundRamp = makeGroundRamp();
  worldGroup = new THREE.Group();
  worldGroup.name = 'world';
  scene.add(worldGroup);
  const add = (o) => { worldGroup.add(o); return o; };

  add(createSky());
  if (!lights) lights = createLights(scene);   // lights persist across holes
  // createLights settles FOG_COLOR for the chosen time of day; the scene's fog
  // was built at module load, before any of that was known.
  scene.fog.color.set(timeOfDay().fog);
  add(createBackdrop(ramp));
  clouds = add(createClouds());

  // Trees first. The terrain shader draws its pine straw beds from a map of
  // where they actually landed, so they have to exist before it is built.
  const trees = createTrees(ramp);

  terrain = add(createTerrain(renderer, groundRamp, treeMapTexture()));

  // Most holes have no water at all, and the constructors read their feature's
  // dimensions, so neither may be called when that feature is absent.
  water = POND ? add(createWater()) : null;
  ocean = OCEAN ? add(createOcean()) : null;
  if (OCEAN) {
    add(createSeaStacks(ramp));
    add(createLavaRocks(ramp));
    spray = add(createSpray());
  } else spray = null;
  creek = CREEK ? add(createCreek()) : null;
  if (CREEK) { const b = createBridge(ramp); if (b) add(b); }

  add(trees);
  add(createGrass(ramp));
  sunRays = add(createSunRays());
  // Gulls where there is a sea to wheel over, butterflies where there are
  // azaleas. Same slot, same tick contract, different place.
  fliers = add(COURSE.gulls ? createSeagulls() : createButterflies());
  motes = add(createMotes());
  clubhouse = add(createClubhouse(ramp));
  add(createTeeMarkers(ramp));

  flag = add(createFlag(ramp));

  golfer = new Golfer(ramp, playerLook);
  add(golfer.root);

  // The cart lives in the world group, so a hole change throws it away with
  // everything else and the next hole gets a clean one at the tee.
  cart = new Cart(worldGroup, { colour: 0xf4f6f8, ramp });

  ball = new Ball(worldGroup, ramp);
  aimLine = new AimLine(worldGroup);
}

/**
 * One-time setup. The rig, the swipe input and the freecam each attach window
 * listeners, so they are built once and outlive any single hole — as are the
 * lights and the HUD buttons.
 */
function initOnce() {
  rig = new CameraRig(camera);
  input = new SwipeSwing(renderer.domElement);
  cartCtl = createCartControls();
  freeCam = new FreeCam(camera, renderer.domElement);
  wireInput();
}

// ---------------------------------------------------------------- freecam
const _tmpDir = new THREE.Vector3();

/**
 * The game keeps simulating while the freecam is flying, so you can hit a
 * shot and go watch it from anywhere. On the way out we hand the rig the
 * camera's current pose so it eases back into framing instead of cutting.
 */
function toggleFreeCam(force) {
  if (!freeCam) return false;
  const want = force === undefined ? !freeCam.active : !!force;
  if (want === freeCam.active) return freeCam.active;

  if (want) {
    freeCam.enable();
    hud.hint('');
  } else {
    rig.pos.copy(camera.position);
    camera.getWorldDirection(_tmpDir);
    rig.look.copy(camera.position).addScaledVector(_tmpDir, 20);
    freeCam.disable();
  }
  hud.setFreecam(freeCam.active, freeCam.status());
  return freeCam.active;
}

/**
 * Run `fn` once the browser has actually painted.
 *
 * A long synchronous build has to be deferred past a paint or whatever was
 * put on screen to cover it never appears — the frame it would have been
 * drawn in is the frame that is busy. Two animation frames is the reliable
 * way to wait for one, and the timer covers a background tab, which is
 * given no animation frames at all.
 */
function afterPaint(fn) {
  let done = false;
  const go = () => { if (done) return; done = true; fn(); };
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 60);
}

// ---------------------------------------------------------------- game state
const game = {
  state: 'intro',      // intro | ready | charging | swinging | watching | settling | done
  strokes: 0,
  aim: 0,
  club: CLUBS.driver,
  lie: 'fairway',
  pending: { lateral: 0, tempo: 0 },
  shotDir: new THREE.Vector3(0, 0, -1),
  shotFrom: new THREE.Vector3(),
  settleTimer: 0,
  onTee: true,
  holeIndex: 0,
  total: 0,     // strokes relative to par across the round
};

/**
 * Point the player down the hole: at the pin if it's in range, otherwise at
 * the spot on the centreline this club can actually reach.
 *
 * `reach` matters on a dogleg. Aiming a fixed distance down the line fires
 * straight through the corner and into the trees; aiming at where the ball
 * will finish keeps it on the short grass.
 */
function defaultAim(x, z, reach) {
  const d = distToHole(x, z);
  let tx = HOLE_POS.x, tz = HOLE_POS.z;
  if (d > reach) { const p = aimPointAhead(x, z, reach); tx = p.x; tz = p.z; }
  return Math.atan2(tx - x, -(tz - z));
}

function refreshShot({ pop = false, keepAim = false } = {}) {
  const { x, z } = ball.pos;
  game.lie = surfaceAt(x, z);
  const toPin = distToHole(x, z);
  // Where a straight shot of a given carry would finish, so the caddie can
  // decline to club us into a hazard.
  // Two passes: a provisional aim to judge the hazards by, then a final aim
  // once we know which club — the club decides how far down the dogleg to look.
  const aimNow = keepAim ? game.aim : defaultAim(x, z, 225);
  const landsWet = (carry, roll) => {
    // Sweep the whole landing-and-run-out band, not just the pitch mark.
    const runout = carry * 0.16 * roll;
    for (let d = carry - 4; d <= carry + runout; d += 6) {
      if (surfaceAt(x + Math.sin(aimNow) * d, z - Math.cos(aimNow) * d) === 'water') return true;
    }
    return false;
  };
  game.club = pickClub(toPin, game.lie, game.onTee, landsWet);
  // The putter has no carry, so asking where it "reaches" would aim at the
  // centreline beside the ball instead of at the hole. On the green, always
  // aim at the hole.
  if (!keepAim) {
    const reach = game.club === CLUBS.putter ? Infinity : game.club.carry * 0.97;
    game.aim = defaultAim(x, z, reach);
  }

  golfer.forceIdle();
  golfer.place(x, heightAt(x, z), z, game.aim, pop);
  golfer.visible = true;

  aimLine.layout(x, z, game.aim);
  aimLine.setVisible(true);

  hud.setStatus(game.strokes + 1, game.club.name, toPin);
}

function setAim(a) {
  game.aim = a;
  golfer.setAim(a);
  aimLine.layout(ball.pos.x, ball.pos.z, a);
}

// ---------------------------------------------------------------- shot flow
/** Tear the world down, load a new hole, and build it again. */
function loadHole(index) {
  game.holeIndex = ((index % HOLES.length) + HOLES.length) % HOLES.length;
  setHole(HOLES[game.holeIndex]);
  disposeWorld();
  buildWorld();
  wireHole();
  beginHole();
}

function beginHole() {
  cartCtl?.setActive(false);
  game.strokes = 0;
  game.onTee = true;
  game.state = 'intro';
  ball.mesh.visible = true;
  ball.placeAt(TEE.x, TEE.z);
  refreshShot();
  // Put them on the tee too, so the first turn of the hole has someone to watch
  // rather than an empty fairway.
  match?.placeAtTee(TEE.x, TEE.z);
  hud.hideCard();
  hud.setHole(HOLE.n, HOLE.name, PAR, HOLE_LENGTH);
  refreshScore();
  rig.setMode('intro');
  rig.introT = 0;
  rig.update(0.016, camCtx());
  rig.snap();
}

function launchShot(power) {
  game.strokes++;
  game.onTee = false;
  game.shotFrom.copy(ball.pos);

  ball.launch({
    aim: game.aim,
    power,
    club: game.club,
    lateral: game.pending.lateral,
    surface: game.lie,
  });

  game.shotDir.copy(ball.dir);
  game.state = 'watching';
  rig.setMode('flight');
  aimLine.setVisible(false);

  if (game.club === CLUBS.putter) audio.putt(power);
  else if (game.lie === 'sand') audio.sand(power);
  else {
    audio.impact(power);
    // Brush of the club through what it is standing in, on top of the strike.
    if (game.lie === 'rough') audio.brush(0.5 + power * 0.5);
  }

  const label = game.pending.tempo > 0.62 ? 'Pure strike' : power > 0.9 ? 'Big one' : null;
  if (label) hud.shot(label, 1.6);
  hud.setStatus(game.strokes, game.club.name, distToHole(ball.pos.x, ball.pos.z));
}

/**
 * Get in the cart and go.
 *
 * The cart starts where the golfer was standing rather than beside the ball,
 * because that is where you left it — the whole point of the mechanic is that
 * the distance between two shots is a real distance, and starting at the
 * destination would give the game away.
 */
function beginDrive() {
  game.state = 'driving';
  driveT = 0;
  golfer.visible = false;
  aimLine.setVisible(false);
  hud.showPower(false);

  const from = game.shotFrom;
  // Pointed at the ball, so the first thing you see is where you are going.
  const face = Math.atan2(ball.pos.x - from.x, -(ball.pos.z - from.z));
  cart.place(from.x, from.z, face);
  cart.visible = true;

  rig.setMode('drive');
  cartCtl.setActive(true);
  hud.hint('Drive to your ball', 0);
}

/** Park, get out, and play. */
function arriveAtBall() {
  cartCtl.setActive(false);
  cart.speed = 0;
  refreshShot({ pop: true });

  // Moved clear before the shot rather than left where it stopped.
  //
  // Parked at the ball it sat in the middle of the address camera and in the
  // line of half the swings. The obvious fix — putting it behind the ball — is
  // the worst place of all, because behind the ball is exactly where the
  // camera is. So it goes to the side: seven yards along the perpendicular to
  // the aim, on whichever side it was already nearer, facing down the
  // fairway.
  const perp = game.aim + Math.PI / 2;
  const px = Math.sin(perp), pz = -Math.cos(perp);
  const side = (cart.pos.x - ball.pos.x) * px + (cart.pos.z - ball.pos.z) * pz >= 0 ? 1 : -1;
  cart.place(ball.pos.x + px * 7 * side, ball.pos.z + pz * 7 * side, game.aim);
  match?.reportCart(cart);

  game.state = 'ready';
  rig.setMode('address');
  const toPin = distToHole(ball.pos.x, ball.pos.z);
  audio.step(game.lie === 'green' ? 1 : game.lie === 'fairway' ? 0.7 : 0.25);
  setTimeout(() => audio.step(game.lie === 'green' ? 1 : 0.6), 260);
  if (game.onTee) setTimeout(() => audio.tee(), 620);
  if (game.club === CLUBS.putter) hud.hint(`${Math.round(toPin * 3)} feet to the cup`, 3);
  else if (game.lie === 'sand') hud.hint('In the sand — swing a little harder', 3);
  else hud.hint('', 0);
}

function onBallRest() {
  if (game.state !== 'watching') return;
  game.state = 'settling';
  game.settleTimer = 0;
  rig.setMode('settle');

  const travelled = Math.hypot(ball.pos.x - game.shotFrom.x, ball.pos.z - game.shotFrom.z);
  const toPin = distToHole(ball.pos.x, ball.pos.z);
  const lie = surfaceAt(ball.pos.x, ball.pos.z);
  const where = { green: 'on the green', sand: 'in the bunker', rough: 'in the rough', deep: 'in the deep stuff' }[lie];

  hud.shot(
    `${Math.round(travelled)} yds${where ? ` · ${where}` : ''} · ${Math.round(toPin)} to pin`,
    3.6
  );
  audio.land();
}

function onHoled() {
  game.state = 'done';
  rig.setMode('holed');
  rig.time = 0;
  aimLine.setVisible(false);
  audio.holed();
  hud.showPower(false);
  hud.hint('');
  // Held, so it can be called off.
  //
  // In a match the hole can end between the ball dropping and this firing —
  // whoever holes out last completes the pair, and the match advances the
  // moment they do. A second and a half later this used to wake up on the
  // *next* hole, read game.holeIndex as it now was, and offer a card for the
  // hole after that. Pressing it skipped one. Only the slower player ever saw
  // it, because the faster one's card is dismissed by the same advance.
  clearTimeout(game.cardTimer);
  game.cardTimer = setTimeout(() => {
    game.total += game.strokes - PAR;
    refreshScore();
    const rel = game.total === 0 ? 'level' : game.total > 0 ? `+${game.total}` : `${game.total}`;
    const last = game.holeIndex === HOLES.length - 1;
    hud.card(
      scoreName(game.strokes, PAR),
      `${game.strokes} stroke${game.strokes === 1 ? '' : 's'} · par ${PAR}  ·  ${rel} thru ${game.holeIndex + 1}`,
      last ? 'Start again' : `Hole ${HOLES[game.holeIndex + 1].n} →`
    );
  }, 1400);
}

function penalty(kind) {
  if (game.state === 'done') return;
  game.strokes++;
  hud.shot(kind === 'splash' ? 'In the water · +1 stroke' : 'Out of play · +1 stroke', 3.2);
  const from = game.shotFrom;
  ball.dropNear(lerp(from.x, ball.pos.x, 0.55), lerp(from.z, ball.pos.z, 0.55) + 6);
  // onRest never fires after a penalty, and the turn is handed over on rest —
  // so without this, going in the water would stall the match for both players.
  match?.reportRest(game.holeIndex, ball.pos, game.strokes);
  game.state = 'settling';
  game.settleTimer = 0.6;
  rig.setMode('settle');
}

// ---------------------------------------------------------------- input wiring
function wireInput() {
  input.onStart = () => {
    audio.start();
    // Any touch during the opening move skips gracefully to the end of it.
    if (game.state === 'intro') rig.skipIntro();
  };

  input.onAim = (d) => {
    if (game.state !== 'ready') return;
    setAim(game.aim + d);
  };

  // Bar up on touch. The charge callbacks below still own everything else;
  // this only decides when it is on screen.
  const showBar = () => {
    hud.showPower(true);
    hud.setPower(0);
    hud.setSwingCurve(0);
    hud.setPowerTarget(game.club === CLUBS.putter ? 0.5 : null);
  };

  input.onPress = () => { if (game.state === 'ready') showBar(); };
  input.onAimBegin = () => hud.showPower(false);
  input.onPressEnd = () => { if (game.state === 'ready') hud.showPower(false); };

  input.onChargeBegin = () => {
    if (game.state !== 'ready') return;
    game.state = 'charging';
    golfer.beginBackswing();
    // On a putt the meter is a fraction of the distance to the hole, so the
    // midpoint is dead weight and worth marking. On a full shot it is absolute
    // and a notch would mean nothing.
    showBar();
    hud.hint('');
  };

  input.onCharge = (p) => {
    if (game.state !== 'charging') return;
    golfer.setCharge(p);
    hud.setPower(p);
  };

  input.onDriveBegin = () => {
    if (game.state !== 'charging') return;
    game.pending.whooshed = false;
    golfer.beginDrive();
  };

  // The club follows the thumb the whole way down. Nothing here decides when
  // the ball is struck — the golfer does, when the club reaches it — so this
  // only keeps the shot shape up to date and shows the speed being generated.
  input.onDrive = ({ progress, lateral }) => {
    if (game.state !== 'charging') return;
    golfer.driveTo(progress);
    // The bar bends one way and the ball has to bend the same way, or the bar
    // is worse than useless — it would be actively lying while you swing. The
    // sign flip is here rather than in the HUD because the bar's direction is
    // the one that was specified; the flight follows it.
    game.pending.lateral = -lateral;
    hud.setPower(golfer.livePower);
    hud.setSwingCurve(lateral);
    // The club has to be heard coming *before* it arrives. Firing this at
    // impact, as it used to, put the swish and the strike in the same instant
    // and the swing had no approach at all.
    if (!game.pending.whooshed && progress > 0.30) {
      game.pending.whooshed = true;
      audio.whoosh(golfer.livePower);
    }
  };

  input.onDriveEnd = ({ auto, lateral } = {}) => {
    if (game.state !== 'charging') return;
    if (lateral !== undefined) game.pending.lateral = -lateral;
    // A keyboard swing has no gesture behind it, so it gets a speed from the
    // charge it built instead.
    golfer.coastDrive(auto !== undefined ? lerp(6, 17, auto) : Math.abs(golfer._thetaVel));
  };

  input.onCancel = () => {
    if (game.state !== 'charging') return;
    hud.setSwingCurve(0);
    golfer.cancel();
    game.state = 'ready';
    hud.showPower(false);
    hud.setPower(0);
    hud.hint('Swipe down to load, then swing back up through the ball', 3);
  };

  hud.onAgain(() => {
    // In a match the hole ends when both players are in, not when one of them
    // presses a button — so the button only reports readiness.
    if (match?.waitingForOpponent) return;
    const last = game.holeIndex === HOLES.length - 1;
    goToHole(last ? 0 : game.holeIndex + 1, last);
  });

  hud.onSound((on) => audio.setEnabled(on));

}

/**
 * Push the round score to the scoreboard.
 *
 * Relative to par in both modes, so the number means the same thing whether or
 * not there is an opponent. Par is summed here rather than in match.js because
 * this is where the hole definitions live, and both players computing it from
 * the same table is what keeps the two scoreboards agreeing.
 */
function refreshScore() {
  if (match?.active) {
    let par = 0;
    for (let i = 0; i < match.hole && i < HOLES.length; i++) par += HOLES[i].par;
    hud.setScore({
      me: match.myTotal - par,
      them: match.oppTotal - par,
      themName: match.net.opponent ?? 'Opponent',
      state: match.lead,
    });
  } else {
    hud.setScore({ me: game.total });
  }
}

/** The one path that changes hole, shared by the scorecard and by a match. */
function goToHole(next, resetTotal) {
  // Any scorecard still on its way belongs to the hole we are leaving.
  clearTimeout(game.cardTimer);
  hud.hideCard();
  if (resetTotal) game.total = 0;
  // Building a hole blocks for well over a second, most of it baking the
  // course texture. Put the loader up first so that time reads as loading
  // rather than as the game having frozen.
  hud.showLoader(`${HOLES[next].n}. ${HOLES[next].name}`);
  afterPaint(() => { loadHole(next); hud.hideLoader(); });
}

/** Callbacks that belong to this hole's golfer and ball. */
function wireHole() {
  golfer.onImpact = (power) => {
    // Impact is the moment the swing stops being an input and becomes a shot.
    game.state = 'swinging';
    game.pending.tempo = power;
    hud.showPower(false);
    // Tell the opponent to play the same swing, before the ball result follows.
    // Order matters: they see the strike, then where it finished.
    match?.reportSwing(game.holeIndex, power);
    launchShot(power);
  };
  ball.onRest = () => { match?.reportRest(game.holeIndex, ball.pos, game.strokes); onBallRest(); };
  ball.onHoled = () => { match?.reportHoled(game.holeIndex, game.strokes); onHoled(); };
  ball.onEvent = (type, payload) => {
    if (type === 'bounce') audio.bounce(clamp(payload.impact / 14, 0, 1));
    else if (type === 'splash') { audio.splash(); penalty('splash'); }
    else if (type === 'ob') penalty('ob');
  };
}

// ---------------------------------------------------------------- camera ctx
/**
 * What the camera is looking at.
 *
 * While it is the opponent's turn this hands the rig their ball instead of
 * ours, and every mode the rig has then frames them rather than us. That is the
 * whole of spectating: no second camera, no separate mode, just a different
 * point of interest fed to the same rig.
 */
function camCtx() {
  const watch = match?.spectating ? match.watchPos : null;
  const p = watch ?? ball.pos;
  const gy = heightAt(p.x, p.z);
  return {
    ball: p,
    // Their aim is theirs; the best we can honestly say is "toward the hole".
    aim: watch ? Math.atan2(HOLE_POS.x - p.x, -(HOLE_POS.z - p.z)) : game.aim,
    charge: watch ? 0 : golfer.charge,
    shotDir: !watch && game.state === 'watching' ? game.shotDir : null,
    cart,
    ballHeight: Math.max(0, p.y - gy),
    travelled: watch ? 0 : Math.hypot(ball.pos.x - game.shotFrom.x, ball.pos.z - game.shotFrom.z),
    holePos: HOLE_POS,
  };
}

// ------------------------------------------------------ adaptive resolution
/**
 * Give back resolution when frames run long, take it back when they don't.
 *
 * Every other optimisation here is a guess about someone else's hardware —
 * triangle counts and draw calls were tuned against one machine, and a machine
 * with half the fill rate is bottlenecked somewhere else entirely. Render scale
 * is the one lever that always works, and unlike a quality preset it does not
 * need anyone to know what their GPU is: if frames are long, there are too many
 * pixels, whatever the reason.
 *
 * Deliberately sluggish. A slow average and a cooldown after each change mean
 * it responds to the machine rather than to one bad frame, and never sits
 * oscillating between two scales.
 */
let wasSpectating = false;
const perf = { avg: 16.7, scale: MAX_SCALE, cooldown: 0, pinned: false };

function adaptResolution(dt) {
  // Synthetic frames (the screenshot hook drives frame() by hand) have a dt of
  // essentially zero and would otherwise read as an infinitely fast machine.
  if (perf.pinned || dt < 0.002) return;
  perf.avg += (dt * 1000 - perf.avg) * 0.05;
  perf.cooldown -= dt;
  if (perf.cooldown > 0) return;

  let want = perf.scale;
  if (perf.avg > 23 && perf.scale > MIN_SCALE) want = Math.max(MIN_SCALE, perf.scale - 0.25);
  else if (perf.avg < 13 && perf.scale < MAX_SCALE) want = Math.min(MAX_SCALE, perf.scale + 0.25);
  if (want === perf.scale) return;

  perf.scale = want;
  renderer.setPixelRatio(want);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Judge the new scale on its own frames, not on the old ones.
  perf.avg = 16.7;
  perf.cooldown = 1.5;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let time = 0;
let fcReadout = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  adaptResolution(dt);
  input.update(dt);
  golfer.update(dt, time);
  ball.update(dt);
  ball.updateScale(camera);
  aimLine.update(dt);
  clouds.userData.tick(dt);
  sunRays.userData.tick(dt, camera);
  fliers.userData.tick(dt);
  motes.userData.tick(dt);
  match?.update(dt);
  if (water) water.userData.tick(time);
  if (ocean) ocean.userData.tick(time);
  if (spray) spray.userData.tick(dt);
  if (creek) creek.userData.tick(time);
  flag.userData.tick(time);
  clubhouse.userData.tick(dt);

  // --- state transitions -------------------------------------------------
  const spectating = !!match?.spectating;

  // The opening fly-in ends early if it is not our shot: the rig is about to be
  // pointed at the opponent instead, so the intro can never finish on its own,
  // and waiting for it would leave the hole stuck in 'intro' for ever.
  if (game.state === 'intro' && (rig.introDone || spectating)) {
    game.state = 'ready';
    hud.hint(spectating
      ? `Watching ${match.net.opponent ?? 'your opponent'}…`
      : 'Swipe down to load — then swing back up through the ball');
    rig.setMode('address');
  }

  if (game.state === 'settling') {
    game.settleTimer += dt;
    // Nobody drives while the other player is still over the ball.
    //
    // Shots alternate, so your ball coming to rest hands them the turn — and
    // without this you would be tearing off down the fairway while they were
    // trying to hit. Worse, the two of you would be doing it in each other's
    // way: their camera is on their own ball, and a cart wandering through
    // that shot is somebody else's turn intruding on yours.
    //
    // So the drive waits for the turn to come back. Spectating is already
    // running here — the camera is on them and the swing is locked out — so
    // the wait costs nothing and shows you the shot you are waiting for.
    if (game.settleTimer > 1.2) {
      if (match?.active && !match.myTurn) game.state = 'waiting';
      else beginDrive();
    }
  }

  // The turn came back, or the match ended while we were waiting for it.
  if (game.state === 'waiting' && (!match?.active || match.myTurn)) beginDrive();

  // --- the drive ---
  //
  // Stepped before the arrival test, so a cart that reaches the ball this
  // frame is already parked when the test runs and does not glide the last
  // yard after the game has decided you are there.
  if (game.state === 'driving') {
    driveT += dt;
    cart.update(dt, cartCtl.read());
    cartCtl.setFuel(cart.boost);
    if (match?.active && match.oppCart) {
      const hit = cart.collide(match.oppCart);
      if (hit > 2.2 && time - (game.lastRam ?? -9) > 0.6) {
        game.lastRam = time;
        audio.bounce(clamp(hit / 9, 0.25, 1));
        hud.shot('Contact!', 1.4);
      }
    }
    match?.reportCart(cart);

    const d = Math.hypot(cart.pos.x - ball.pos.x, cart.pos.z - ball.pos.z);
    // Near enough, slow enough. Requiring a full stop made every arrival end
    // in a fiddle; requiring only proximity meant you flew past at speed and
    // the shot began facing backwards.
    if (d < 4.2 && Math.abs(cart.speed) < 2.6) arriveAtBall();
    // And a way out for anyone who does not want to drive today.
    else if (driveT > 90) arriveAtBall();
  }

  // Freecam owns the pointer while it's flying, so the swing must stand down —
  // and so does it on the opponent's turn, which is the whole point of taking
  // turns. Aiming is blocked with it: lining up a shot you cannot take yet,
  // while the camera is somewhere else entirely, is worse than nothing.
  input.enabled = !freeCam.active && !spectating
    && (game.state === 'ready' || game.state === 'charging');
  // The pad only exists while driving, and never while the freecam has the
  // pointer or the menu is up over the top of it.
  if (game.state !== 'driving' && cartCtl) cartCtl.setActive(false);
  if (spectating !== wasSpectating) {
    wasSpectating = spectating;
    aimLine.setVisible(!spectating && game.state === 'ready');
    // Frame their ball from behind, the way a hole starts, rather than leaving
    // the rig in whatever mode our own last shot finished in.
    if (spectating) rig.setMode('address');
    else if (game.state === 'ready') { rig.setMode('address'); refreshShot({ keepAim: true }); }
  }

  // Keep the (deliberately tight) shadow camera centred on the action — or on
  // the freecam, so wherever you fly still has shadows.
  let focusX, focusZ;
  if (freeCam.active) {
    focusX = freeCam.pos.x; focusZ = freeCam.pos.z;
  } else if (game.state === 'driving') {
    focusX = cart.pos.x; focusZ = cart.pos.z;
  } else if (match?.spectating) {
    focusX = match.watchPos.x; focusZ = match.watchPos.z;
  } else if (game.state === 'watching') {
    focusX = ball.pos.x; focusZ = ball.pos.z;
  } else {
    focusX = golfer.root.position.x; focusZ = golfer.root.position.z;
  }
  const focusY = heightAt(focusX, focusZ);
  lights.sun.target.position.set(focusX, focusY, focusZ);
  // Offset read from the time-of-day table rather than copied, so re-aiming
  // the sun at the player each frame cannot drift from where it was created.
  const sunOff = timeOfDay().sun;
  lights.sun.position.set(focusX + sunOff[0], focusY + sunOff[1], focusZ + sunOff[2]);
  lights.sun.target.updateMatrixWorld();

  if (freeCam.active) {
    freeCam.update(dt);
    // Refresh the readout a few times a second rather than every frame.
    fcReadout += dt;
    if (fcReadout > 0.12) { fcReadout = 0; hud.setFreecam(true, freeCam.status()); }
  } else {
    rig.update(dt, camCtx());
  }

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- multiplayer
/**
 * The 1v1 button and its status line.
 *
 * Built here rather than in markup for the same reason the kit panel is: it is
 * three elements and one callback, and keeping it beside the wiring it depends
 * on is easier to follow than splitting it across two files.
 */
/** A name that persists, so an opponent sees the same person twice. */
function mpName() {
  let name = localStorage.getItem('sunnylinks.name');
  if (!name) {
    name = 'Player ' + Math.floor(1000 + Math.random() * 9000);
    try { localStorage.setItem('sunnylinks.name', name); } catch { /* private mode */ }
  }
  return name;
}

function setupMatch() {
  match = new Match(scene);
  match.myLook = playerLook;

  const style = document.createElement('style');
  style.textContent = `
    #btnOpts{pointer-events:auto;cursor:pointer;user-select:none;width:38px;height:38px;
      padding:0;display:grid;place-items:center;font-size:16px}
    #btnOpts:active{transform:scale(.92)}
    #mpStatus{position:absolute;top:max(62px,calc(env(safe-area-inset-top,0px) + 62px));
      right:16px;max-width:min(280px,60vw);text-align:right;font-size:12.5px;font-weight:700;
      opacity:0;transition:opacity .3s ease;pointer-events:none}
    #mpStatus.on{opacity:1}
    #mpStatus.good{color:#1f7a4d}#mpStatus.bad{color:#c0392b}#mpStatus.error{color:#c0392b}
    #mpStatus.busy{opacity:.7}
    /* Under the menu (60) and under the loader (50): this is a pause screen,
       and both of those replace the game outright. */
    #opts{position:fixed;inset:0;z-index:45;display:none;place-items:center;
      background:rgba(24,16,8,.58);backdrop-filter:blur(5px);
      -webkit-backdrop-filter:blur(5px)}
    #opts.open{display:grid}
    #optsCard{width:min(330px,calc(100vw - 40px));padding:22px;border-radius:22px;
      background:var(--wood-board) repeat 50% 50% / 320px 160px,
        linear-gradient(180deg,#fbf1d9,#ecd9b0);
      border:5px solid var(--wood);text-align:center;color:var(--ink);
      box-shadow:0 0 0 3px var(--ink),0 18px 44px rgba(0,0,0,.55),
                 inset 0 3px 0 rgba(255,255,255,.6)}
    #optsCard h3{margin:0 0 10px;font-size:21px;font-weight:900;letter-spacing:.6px;
      text-transform:uppercase;color:#fff;text-shadow:0 3px 0 rgba(0,0,0,.32);
      background:linear-gradient(180deg,#8fd05c,#4f9330);
      border:3px solid var(--ink);border-radius:12px;padding:7px 20px;display:inline-block;
      box-shadow:0 4px 0 var(--green-lip),inset 0 2px 0 rgba(255,255,255,.35)}
    #optsCard p{margin:0 0 16px;font-size:12.5px;font-weight:800;opacity:.6}
    #optsCard button{width:100%;margin-top:11px;font:inherit;font-weight:900;
      font-size:15px;padding:14px 18px;border-radius:15px;cursor:pointer;
      text-transform:uppercase;letter-spacing:.8px;color:#fff;
      border:3px solid var(--ink);text-shadow:0 2px 0 rgba(0,0,0,.3);
      background:linear-gradient(180deg,#9ad966,var(--green-d));
      box-shadow:0 5px 0 var(--green-lip),inset 0 2px 0 rgba(255,255,255,.4)}
    #optsCard button.ghost{background:linear-gradient(180deg,#e3945f,var(--red-d));
      box-shadow:0 5px 0 var(--red-lip),inset 0 2px 0 rgba(255,255,255,.35)}
    #optsCard button:active{transform:translateY(4px);box-shadow:0 1px 0 rgba(0,0,0,.35)}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('div');
  btn.className = 'pill';
  btn.id = 'btnOpts';
  btn.title = 'Options';
  btn.textContent = '⚙';
  document.getElementById('topRight')?.appendChild(btn);

  const status = document.createElement('div');
  status.id = 'mpStatus';
  status.className = 'pill';
  document.getElementById('hud')?.appendChild(status);

  // The pause screen. Small on purpose: the only two things anyone wants from
  // it mid-round are "carry on" and "get me out".
  const opts = document.createElement('div');
  opts.id = 'opts';
  opts.innerHTML = `<div id="optsCard">
      <h3>Paused</h3><p id="optsSub"></p>
      <button id="optsResume">Resume</button>
      <button class="ghost" id="optsLeave">Back to lobby</button>
    </div>`;
  document.body.appendChild(opts);

  const setOpts = (open) => {
    opts.classList.toggle('open', open);
    if (open) {
      opts.querySelector('#optsSub').textContent = match.active
        ? `Leaving forfeits the match against ${match.net.opponent ?? 'your opponent'}.`
        : `${HOLES[game.holeIndex].name} · hole ${game.holeIndex + 1} of ${HOLES.length}`;
    }
  };
  btn.onclick = () => setOpts(!opts.classList.contains('open'));
  opts.querySelector('#optsResume').onclick = () => setOpts(false);
  opts.querySelector('#optsLeave').onclick = () => { setOpts(false); showMenu('home'); };
  opts.onclick = (e) => { if (e.target === opts) setOpts(false); };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && started && !menu?.visible) setOpts(!opts.classList.contains('open'));
  });

  match.onStatus = (text, kind) => {
    status.textContent = text ?? '';
    status.className = 'pill ' + (kind || '') + (text ? ' on' : '');
    // The HUD is underneath the menu, so anything said while it is up has to
    // be said there as well or it is said to nobody.
    if (menu?.visible && text) menu.setStatus(text);
    refreshScore();
  };
  // Both players are in: move on together, from wherever either of them was.
  match.onAdvance = () => goToHole(match.hole % HOLES.length, match.hole === 0);
  // Whose shot it is now. The camera and the swing both follow this.
  match.onTurn = (mine) => {
    if (!started) return;
    hud.hint(mine ? 'Your shot' : `Watching ${match.net.opponent ?? 'your opponent'}…`, mine ? 2 : 0);
  };

  window.addEventListener('beforeunload', () => match.leave());
}

// ---------------------------------------------------------------- freecam API
// Bound at module load rather than inside boot, so the key and the console
// handle work from the first frame and don't depend on the world having
// finished building. Both no-op until it has.
window.addEventListener('keydown', (e) => {
  // Match physical key or produced character: `code` is absent on synthetic
  // events and unreliable on non-QWERTY layouts.
  const isF = e.code === 'KeyF' || e.key === 'f' || e.key === 'F';
  if (isF && !e.repeat && !e.metaKey && !e.ctrlKey) toggleFreeCam();
});

/**
 * Customising the golfer.
 *
 *   golfer.set({ shirt: 0xff0000 })   any subset of DEFAULT_LOOK
 *   golfer.preset('masters')          one of the ready-made looks
 *   golfer.look                       what it currently is
 *   golfer.options                    what can be changed, and to what
 *
 * Changes apply to the figure on screen straight away and are remembered.
 */
window.golfer = {
  get look() { return { ...playerLook }; },
  get presets() { return Object.keys(LOOK_PRESETS); },
  options: {
    colours: ['skin', 'shirt', 'trim', 'trousers', 'shoes', 'cap', 'hair', 'glove'],
    headwear: ['bucket', 'cap', 'visor', 'none'],
    hairStyle: ['short', 'long', 'none'],
    shades: [true, false],
  },
  set(partial) {
    playerLook = { ...playerLook, ...partial };
    if (golfer) golfer.setLook(playerLook);
    menu?.refreshLook();
    kitPanel?.refresh();
    match?.sendLook(playerLook);
    saveLook(playerLook);
    return { ...playerLook };
  },
  preset(name) {
    if (!LOOK_PRESETS[name]) return 'unknown preset — try ' + Object.keys(LOOK_PRESETS).join(', ');
    playerLook = { ...DEFAULT_LOOK, ...LOOK_PRESETS[name] };
    if (golfer) golfer.setLook(playerLook);
    menu?.refreshLook();
    kitPanel?.refresh();
    kitPanel?.refresh();
    match?.sendLook(playerLook);
    saveLook(playerLook);
    return { ...playerLook };
  },
  reset() { return this.preset('classic'); },
};

/** freecam() toggles · freecam.goto(x,y,z) · freecam.lookAt(x,y,z) · freecam.off() */
window.freecam = Object.assign(
  (on) => (freeCam ? (toggleFreeCam(on), freeCam.status()) : 'still loading'),
  {
    goto: (x, y, z) => {
      if (!freeCam) return 'still loading';
      toggleFreeCam(true); freeCam.goto(x, y, z); return freeCam.status();
    },
    lookAt: (x, y, z) => {
      if (!freeCam) return 'still loading';
      toggleFreeCam(true); freeCam.lookAt(x, y, z); return freeCam.status();
    },
    off: () => { toggleFreeCam(false); return 'freecam off'; },

    /** Pin the render scale, or pass nothing to hand it back to the adapter. */
    quality: (v) => {
      if (v === undefined) { perf.pinned = false; return 'auto (' + perf.scale.toFixed(2) + 'x)'; }
      perf.pinned = true;
      perf.scale = Math.max(0.4, Math.min(3, v));
      renderer.setPixelRatio(perf.scale);
      renderer.setSize(window.innerWidth, window.innerHeight);
      return 'pinned at ' + perf.scale.toFixed(2) + 'x';
    },

    /** Live handles on the render objects, for automated shading audits. */
    dbg: () => ({ renderer, scene, camera, lights, terrain, game, golfer, ball, cart, input, rig, hud, match, THREE }),

    /** Jump straight to a hole by number (1-18), skipping the scorecard. */
    hole: (n) => {
      if (!freeCam) return 'still loading';
      hud.hideCard();
      loadHole(n - 1);
      return `hole ${HOLES[game.holeIndex].n} — ${HOLES[game.holeIndex].name}`;
    },

    /**
     * Render right now and hand back a JPEG data URL.
     *
     * A background tab gets no animation frames at all, so the loop stalls and
     * the canvas holds whatever it last drew — which makes it impossible to
     * look at the game from a tool that can't put the page on screen. Driving
     * `frame()` by hand sidesteps that entirely: it runs the normal update and
     * render path, just on our clock instead of the compositor's.
     *
     * Two frames, because the freecam eases toward its target rather than
     * snapping; one frame after a goto() still shows the camera in transit.
     */
    shot: (w = 560, q = 0.72) => {
      if (!freeCam) return 'still loading';
      frame(); frame();
      const src = renderer.domElement;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.round((w * src.height) / src.width);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    },
  }
);
console.log(
  '%cSunny Links%c  ·  press F for freecam, or call freecam() / freecam.goto(x, y, z)',
  'font-weight:700', 'color:#678'
);

// ---------------------------------------------------------------- boot
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

let booted = false;
let started = false;   // has a round ever been built?
let looping = false;

/**
 * Build the chosen round and drop into it.
 *
 * The course and the time have to be settled before anything is built, because
 * both are baked in: the routing decides the terrain, and the sun decides the
 * sky, the fog and the light. Changing either afterwards would mean rebuilding
 * the world anyway, so this is the one place they are set.
 */
function startRound({ course, time }) {
  setCourse(course);
  setTimeOfDay(time);
  disposeLights();            // the sun may have moved; buildWorld makes a new one
  menu?.hide();
  if (!started) { started = true; initOnce(); }
  loadHole(0);
  hud.hideLoader();
  clock.getDelta();           // discard the long pause spent building
  if (!looping) { looping = true; frame(); }
}

/** Back to the front screen. Leaves any match, because you are leaving it. */
function showMenu(tab) {
  if (match.active || match.net.state === 'waiting') match.leave();
  menu?.show(tab);
}

function boot() {
  if (booted) return;
  booted = true;
  setupMatch();
  menu = createMenu({
    getLook: () => playerLook,
    getName: mpName,
    // The customise screen owns the layout; kit.js only fills it in.
    buildKit: (host) => { kitPanel = createKitControls(window.golfer, host); },
    // Starting a solo round means you are no longer looking for anyone.
    onStart: (opts) => { match.leave(); startRound(opts); },
    onBrowse: () => {
      // Reconnecting would tear down a lobby we are already sitting in.
      const s = match.net.state;
      if (s === 'idle' || s === 'closed') match.browse(mpName());
    },
    // Only the course and the time travel with a lobby. The name rides on the
    // advertisement itself, and duplicating it here just gave two answers.
    onHost: ({ course, time }) => match.host({ course, time }),
    onQuick: ({ course, time }) => match.quick({ course, time }),
    onJoin: (id) => match.join(id),
  });
  match.onLobbies = (list) => menu.showLobbies(list);
  // Both sides build the host's course, so the world waits until we know what
  // it is — which is only once the pairing has actually happened.
  match.onMatched = (meta) => startRound({
    course: meta?.course ?? COURSES[0].id,
    time: meta?.time ?? 'day',
  });
  // The mod menu. Built at boot rather than on demand so its key listener is
  // live from the first frame — it is the only way in, and one that only works
  // after something else has happened is not a way in.
  createAdminMenu({
    holes: () => HOLES,
    courseName: () => COURSE.name,
    current: () => game.holeIndex,
    playing: () => started && !menu?.visible,
    goHole: (i) => { hud.hideCard(); loadHole(i); },
    times: () => TIMES,
    time: () => timeOfDay().key,
    // Rebuilds the world, which is the only way the sun can move: the sky, the
    // fog and the light are all baked from it.
    setTime: (k) => {
      setTimeOfDay(k);
      disposeLights();
      hud.hideCard();
      loadHole(game.holeIndex);
    },
  });

  hud.hideLoader();
}

// Build on the next frame so the loading screen actually paints first.
//
// A tab that starts in the background is never given that frame, though —
// browsers withhold animation frames from hidden pages entirely — so opening
// the game in a new tab and switching to it later would leave it sitting on
// the loader forever. The timer is the backstop; whichever fires first wins.
requestAnimationFrame(boot);
setTimeout(boot, 250);
