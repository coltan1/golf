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
  HOLE_POS, TEE, PAR, HOLE_LENGTH,
} from './course.js';
import { createTerrain, createWater, makeToonRamp } from './terrain.js';
import { createSky, createLights, createClouds, createBackdrop, FOG_COLOR } from './scenery.js';
import { createTrees, createClubhouse, createFlag, createTeeMarkers } from './props.js';
import { Golfer } from './golfer.js';
import { Ball, CLUBS, pickClub } from './ball.js';
import { SwipeSwing } from './input.js';
import { CameraRig } from './camerarig.js';
import { AimLine } from './aimline.js';
import { Audio } from './audio.js';
import { Hud, scoreName } from './hud.js';

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
let terrain, water, clouds, flag, clubhouse, golfer, ball, rig, aimLine, input, lights;

function buildWorld() {
  const ramp = makeToonRamp();

  scene.add(createSky());
  lights = createLights(scene);
  scene.add(createBackdrop(ramp));
  clouds = createClouds();
  scene.add(clouds);

  terrain = createTerrain(renderer, ramp);
  scene.add(terrain);

  water = createWater();
  scene.add(water);

  scene.add(createTrees(ramp));
  clubhouse = createClubhouse(ramp);
  scene.add(clubhouse);
  scene.add(createTeeMarkers(ramp));

  flag = createFlag(ramp);
  scene.add(flag);

  golfer = new Golfer(ramp);
  scene.add(golfer.root);

  ball = new Ball(scene, ramp);
  aimLine = new AimLine(scene);
  rig = new CameraRig(camera);
  input = new SwipeSwing(renderer.domElement);
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
};

/** Point the player down the hole: at the pin if reachable, else at the dogleg. */
function defaultAim(x, z) {
  const d = distToHole(x, z);
  let tx = HOLE_POS.x, tz = HOLE_POS.z;
  if (d > 235) { const p = aimPointAhead(x, z, 225); tx = p.x; tz = p.z; }
  return Math.atan2(tx - x, -(tz - z));
}

function refreshShot({ pop = false, keepAim = false } = {}) {
  const { x, z } = ball.pos;
  game.lie = surfaceAt(x, z);
  const toPin = distToHole(x, z);
  game.club = pickClub(toPin, game.lie, game.onTee);
  if (!keepAim) game.aim = defaultAim(x, z);

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
function beginHole() {
  game.strokes = 0;
  game.onTee = true;
  game.state = 'intro';
  ball.mesh.visible = true;
  ball.placeAt(TEE.x, TEE.z);
  refreshShot();
  hud.hideCard();
  hud.setHoleLength(HOLE_LENGTH);
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

  if (game.club === CLUBS.putter) audio.putt();
  else audio.impact(power);

  const label = game.pending.tempo > 0.62 ? 'Pure strike' : power > 0.9 ? 'Big one' : null;
  if (label) hud.shot(label, 1.6);
  hud.setStatus(game.strokes, game.club.name, distToHole(ball.pos.x, ball.pos.z));
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
  setTimeout(() => {
    hud.card(scoreName(game.strokes, PAR), `${game.strokes} stroke${game.strokes === 1 ? '' : 's'} · par ${PAR}`);
  }, 1400);
}

function penalty(kind) {
  if (game.state === 'done') return;
  game.strokes++;
  hud.shot(kind === 'splash' ? 'In the water · +1 stroke' : 'Out of play · +1 stroke', 3.2);
  const from = game.shotFrom;
  ball.dropNear(lerp(from.x, ball.pos.x, 0.55), lerp(from.z, ball.pos.z, 0.55) + 6);
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

  input.onChargeBegin = () => {
    if (game.state !== 'ready') return;
    game.state = 'charging';
    golfer.beginBackswing();
    hud.showPower(true);
    hud.hint('');
  };

  input.onCharge = (p) => {
    if (game.state !== 'charging') return;
    golfer.setCharge(p);
    hud.setPower(p);
  };

  input.onRelease = ({ power, lateral, tempo }) => {
    if (game.state !== 'charging') return;
    game.pending.lateral = lateral;
    game.pending.tempo = tempo;
    if (golfer.release(power)) {
      game.state = 'swinging';
      hud.showPower(false);
      audio.whoosh(power);
    }
  };

  input.onCancel = () => {
    if (game.state !== 'charging') return;
    golfer.cancel();
    game.state = 'ready';
    hud.showPower(false);
    hud.setPower(0);
    hud.hint('Swipe down to load, then flick up to swing', 3);
  };

  golfer.onImpact = (power) => launchShot(power);

  ball.onRest = () => onBallRest();
  ball.onHoled = () => onHoled();
  ball.onEvent = (type, payload) => {
    if (type === 'bounce') audio.bounce(clamp(payload.impact / 14, 0, 1));
    else if (type === 'splash') { audio.splash(); penalty('splash'); }
    else if (type === 'ob') penalty('ob');
  };

  hud.onAgain(() => { hud.hideCard(); beginHole(); });
  hud.onSound((on) => audio.setEnabled(on));
}

// ---------------------------------------------------------------- camera ctx
function camCtx() {
  const gy = heightAt(ball.pos.x, ball.pos.z);
  return {
    ball: ball.pos,
    aim: game.aim,
    charge: golfer.charge,
    shotDir: game.state === 'watching' ? game.shotDir : null,
    ballHeight: Math.max(0, ball.pos.y - gy),
    travelled: Math.hypot(ball.pos.x - game.shotFrom.x, ball.pos.z - game.shotFrom.z),
    holePos: HOLE_POS,
  };
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let time = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;

  input.update(dt);
  golfer.update(dt, time);
  ball.update(dt);
  ball.updateScale(camera);
  aimLine.update(dt);
  clouds.userData.tick(dt);
  water.userData.tick(time);
  flag.userData.tick(time);
  clubhouse.userData.tick(dt);

  // --- state transitions -------------------------------------------------
  if (game.state === 'intro' && rig.introDone) {
    game.state = 'ready';
    hud.hint('Hold and swipe down to load — flick up to swing');
    rig.setMode('address');
  }

  if (game.state === 'settling') {
    game.settleTimer += dt;
    if (game.settleTimer > 1.5) {
      refreshShot({ pop: true });
      game.state = 'ready';
      rig.setMode('address');
      const toPin = distToHole(ball.pos.x, ball.pos.z);
      if (game.club === CLUBS.putter) hud.hint(`${Math.round(toPin * 3)} feet to the cup`, 3);
      else if (game.lie === 'sand') hud.hint('In the sand — swing a little harder', 3);
    }
  }

  input.enabled = game.state === 'ready' || game.state === 'charging';

  // Keep the (deliberately tight) shadow camera centred on the action.
  const focusX = game.state === 'watching' ? ball.pos.x : golfer.root.position.x;
  const focusZ = game.state === 'watching' ? ball.pos.z : golfer.root.position.z;
  const focusY = heightAt(focusX, focusZ);
  lights.sun.target.position.set(focusX, focusY, focusZ);
  // ~45° from the left: shadows fall right and toward the camera, roughly as
  // long as their caster. Must match createLights() — see the note there.
  lights.sun.position.set(focusX - 135, focusY + 146, focusZ - 55);
  lights.sun.target.updateMatrixWorld();

  rig.update(dt, camCtx());
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// Build on the next frame so the loading screen actually paints first.
requestAnimationFrame(() => {
  buildWorld();
  wireInput();
  beginHole();
  hud.hideLoader();
  clock.getDelta();
  frame();
});
