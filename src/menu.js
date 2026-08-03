/**
 * menu.js — the lobby.
 *
 * Four full screens rather than one panel with tabs: Home, Customise, Solo,
 * Multiplayer. Each fills the window and you move between them with a back
 * arrow. Tabs were fine while there were two short lists; a customise screen
 * with forty swatches on it is not something to squeeze into a sidebar, and a
 * half-page card surrounded by empty gradient was never using the space it had.
 *
 * The golfer preview has its own renderer, scene and light rather than
 * borrowing the game's. That costs a second WebGL context and is worth it: the
 * game's scene is a whole golf course whose lighting is tuned for a course, and
 * posing a figure inside it would mean either building the world before the
 * menu (slow, and the menu exists partly to cover that) or lighting the menu
 * with whatever the course happens to have. A tiny scene with one key light and
 * a turntable is independent of all of it.
 *
 * There is one preview canvas, moved between the screens that want it, because
 * two WebGL contexts for the same figure is one too many.
 */

import * as THREE from 'three';
import { Golfer } from './golfer.js';
import { makeToonRamp } from './terrain.js';
import { COURSES } from './courses.js';
import { TIMES } from './scenery.js';

const css = `
#menu{
  position:fixed;inset:0;z-index:60;overflow:hidden;
  background:linear-gradient(170deg,#bfe4f7 0%,#dff1f8 46%,#e9f5ec 100%);
  transition:opacity .4s ease;
  font-variant-numeric:tabular-nums;
}
#menu.hide{opacity:0;pointer-events:none}

.screen{
  position:absolute;inset:0;display:none;flex-direction:column;
  padding:22px max(22px,calc((100vw - 1040px)/2)) 26px;overflow-y:auto;
}
.screen.on{display:flex}
.screen.on > *{animation:menuIn .34s cubic-bezier(.22,1,.36,1) both}
@keyframes menuIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.sHead{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex:none}
.sBack{
  width:38px;height:38px;flex:none;border:none;font:inherit;font-size:17px;font-weight:800;
  border-radius:50%;cursor:pointer;color:#26424f;background:rgba(255,255,255,.72);
  border:1px solid rgba(40,70,90,.14);display:grid;place-items:center;
}
.sBack:active{transform:scale(.92)}
.sTitle{font-size:27px;font-weight:800;letter-spacing:-.5px;margin:0}
.sSub{font-size:12.5px;font-weight:700;opacity:.5;margin-top:2px}

/* ---------- home ---------- */
#home{align-items:center;justify-content:center;text-align:center}
#homeTitle{font-size:44px;font-weight:800;letter-spacing:-1.2px;margin:0}
#homeSub{font-size:13px;font-weight:700;opacity:.5;margin:2px 0 14px}
#homeStage{
  width:min(300px,72vw);height:min(340px,42vh);border-radius:26px;overflow:hidden;
  background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.18));
  border:1px solid rgba(255,255,255,.7);box-shadow:0 16px 40px rgba(25,70,95,.16);
  flex:none;
}
#homeName{
  width:min(300px,72vw);margin-top:14px;text-align:center;font:inherit;font-size:15px;
  font-weight:800;padding:10px 12px;border-radius:999px;
  border:1px solid rgba(40,70,90,.18);background:rgba(255,255,255,.72);color:#22333d;
}
#homeName:focus{outline:2px solid rgba(70,150,110,.5);outline-offset:1px}
#homeBtns{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;justify-content:center;
  width:min(420px,88vw)}
#homeBtns .bigBtn{flex:1 1 160px;margin:0}

/* ---------- customise ---------- */
#custBody{display:flex;gap:26px;flex:1;min-height:0}
#custStage{
  /* Capped rather than stretched: the preview frames to fit, so a stage the
     full height of a desktop window just pushes the golfer far away. */
  flex:0 0 340px;border-radius:24px;overflow:hidden;align-self:flex-start;
  height:min(560px,calc(100vh - 130px));min-height:320px;
  background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.18));
  border:1px solid rgba(255,255,255,.7);box-shadow:0 16px 40px rgba(25,70,95,.16);
}
#custOpts{
  flex:1;min-width:0;overflow-y:auto;padding:18px 20px;border-radius:24px;
  background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.8);
  box-shadow:0 16px 40px rgba(25,70,95,.14);
}
#previewWrap{width:100%;height:100%}
#previewWrap canvas{width:100%;height:100%;display:block}

/* ---------- shared bits ---------- */
.mLabel{font-size:11px;font-weight:800;opacity:.5;letter-spacing:.4px;margin:18px 0 8px}
.mLabel:first-child{margin-top:0}
.cards{display:flex;gap:10px;flex-wrap:wrap}
.card{
  flex:1 1 260px;text-align:left;padding:14px 16px;border-radius:16px;cursor:pointer;
  background:rgba(255,255,255,.62);border:1.5px solid rgba(40,70,90,.14);
}
.card.on{border-color:#2f7d55;background:rgba(47,125,85,.10)}
.card b{display:block;font-size:15px;font-weight:800;margin-bottom:3px}
.card span{font-size:12px;font-weight:600;opacity:.6;line-height:1.4;display:block}
.chips{display:flex;gap:7px;flex-wrap:wrap}
.chip{
  font-size:13px;font-weight:800;padding:9px 17px;border-radius:999px;cursor:pointer;
  background:rgba(255,255,255,.62);border:1px solid rgba(40,70,90,.14);
}
.chip.on{background:#2b3a44;color:#fff;border-color:#2b3a44}

.bigBtn{
  width:100%;margin-top:20px;border:none;font:inherit;font-weight:800;font-size:15px;
  color:#fff;background:linear-gradient(180deg,#63c46f,#48ab5b);
  padding:15px 20px;border-radius:16px;cursor:pointer;
  box-shadow:0 10px 24px rgba(60,150,90,.34);
  transition:transform .2s cubic-bezier(.22,1,.36,1);
}
.bigBtn:hover{transform:translateY(-1px)}
.bigBtn:active{transform:scale(.98)}
.bigBtn.ghost{background:rgba(255,255,255,.72);color:#26424f;box-shadow:none;
  border:1px solid rgba(40,70,90,.16);margin-top:10px}

#lobbies{margin-top:4px;display:flex;flex-direction:column;gap:7px}
.lobby{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 15px;border-radius:14px;background:rgba(255,255,255,.65);
  border:1px solid rgba(40,70,90,.12);
}
.lobby .who{font-size:14px;font-weight:800}
.lobby .what{font-size:11.5px;font-weight:700;opacity:.55}
.lobby button{
  border:none;font:inherit;font-weight:800;font-size:13px;color:#fff;cursor:pointer;
  background:#2f7d55;padding:9px 19px;border-radius:999px;
}
#lobbyNone{font-size:13px;font-weight:700;opacity:.45;padding:12px 2px}
#mpNote{font-size:12px;font-weight:700;opacity:.5;margin-top:14px;line-height:1.5}
#mpLive{font-size:13px;font-weight:800;color:#2f7d55;margin-top:12px;min-height:17px}

@media (max-width:820px){
  .screen{padding:16px 16px 22px}
  .sTitle{font-size:23px}
  #homeTitle{font-size:34px}
  #custBody{flex-direction:column;gap:14px}
  #custStage{flex:none;height:34vh;min-height:200px}
  #custOpts{flex:none;overflow:visible;padding:16px}
  .card{flex:1 1 100%}
}
`;

export function createMenu({ getLook, getName, buildKit, onStart, onHost, onQuick, onJoin, onBrowse }) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'menu';
  root.innerHTML = `
    <div class="screen on" id="home">
      <h1 id="homeTitle">Sunny Links</h1>
      <div id="homeSub">Arcade golf, one hole at a time.</div>
      <div id="homeStage"></div>
      <input id="homeName" maxlength="18" placeholder="Your name">
      <div id="homeBtns">
        <button class="bigBtn" data-go="solo">Solo</button>
        <button class="bigBtn" data-go="mp">Multiplayer</button>
        <button class="bigBtn ghost" data-go="cust" style="flex:1 1 100%">Customise golfer</button>
      </div>
    </div>

    <div class="screen" id="cust">
      <div class="sHead">
        <button class="sBack" data-go="home">←</button>
        <div><h2 class="sTitle">Customise</h2>
          <div class="sSub">Changes save, and your opponent sees them.</div></div>
      </div>
      <div id="custBody">
        <div id="custStage"></div>
        <div id="custOpts"></div>
      </div>
    </div>

    <div class="screen" id="solo">
      <div class="sHead">
        <button class="sBack" data-go="home">←</button>
        <div><h2 class="sTitle">Solo round</h2>
          <div class="sSub">Just you and the course.</div></div>
      </div>
      <div class="mLabel">COURSE</div>
      <div class="cards" id="soloCourses"></div>
      <div class="mLabel">TIME OF DAY</div>
      <div class="chips" id="soloTimes"></div>
      <button class="bigBtn" id="btnSolo">Start round</button>
    </div>

    <div class="screen" id="mp">
      <div class="sHead">
        <button class="sBack" data-go="home">←</button>
        <div><h2 class="sTitle">Multiplayer</h2>
          <div class="sSub">Alternating shots — you watch them play theirs.</div></div>
      </div>
      <div class="mLabel">COURSE</div>
      <div class="cards" id="mpCourses"></div>
      <div class="mLabel">TIME OF DAY</div>
      <div class="chips" id="mpTimes"></div>
      <div class="mLabel">OPEN LOBBIES</div>
      <div id="lobbies"><div id="lobbyNone">Looking…</div></div>
      <div id="mpLive"></div>
      <button class="bigBtn" id="btnHost">Create lobby</button>
      <button class="bigBtn ghost" id="btnQuick">Quick match instead</button>
      <div id="mpNote">Whoever creates the lobby picks the course and the light —
        joining adopts theirs, so you both play the same round.</div>
    </div>`;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector('#' + id);

  // ---------------------------------------------------------- screens
  const screens = [...root.querySelectorAll('.screen')];
  let at = 'home';

  const go = (id) => {
    at = id;
    screens.forEach((s) => s.classList.toggle('on', s.id === id));
    // The preview belongs to whichever screen is showing it, and only one of
    // them can hold it at a time.
    if (id === 'home') $('homeStage').appendChild(wrap);
    else if (id === 'cust') $('custStage').appendChild(wrap);
    if (id === 'home' || id === 'cust') { fit(); rebuild(getLook()); }
    // Only reach for the network when someone actually asks for it.
    if (id === 'mp') onBrowse?.();
  };

  root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });

  // ---------------------------------------------------------- choices
  const state = { course: COURSES[0].id, time: 'day' };

  const buildCards = (host) => {
    host.innerHTML = '';
    const made = COURSES.map((c) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `<b>${c.name}</b><span>${c.holes.length} holes · par ${
        c.holes.reduce((s, h) => s + h.par, 0)}<br>${c.blurb}</span>`;
      el.onclick = () => { state.course = c.id; refresh(); };
      host.appendChild(el);
      return { el, id: c.id };
    });
    return () => made.forEach((m) => m.el.classList.toggle('on', m.id === state.course));
  };

  const buildTimes = (host) => {
    host.innerHTML = '';
    const made = Object.entries(TIMES).map(([key, t]) => {
      const el = document.createElement('div');
      el.className = 'chip';
      el.textContent = t.label;
      el.onclick = () => { state.time = key; refresh(); };
      host.appendChild(el);
      return { el, key };
    });
    return () => made.forEach((m) => m.el.classList.toggle('on', m.key === state.time));
  };

  const refreshers = [];
  const refresh = () => refreshers.forEach((f) => f());
  refreshers.push(buildCards($('soloCourses')), buildTimes($('soloTimes')),
                  buildCards($('mpCourses')), buildTimes($('mpTimes')));
  refresh();

  // ---------------------------------------------------------- name
  // Seeded from the same place the match reads it, so what you see here is
  // what an opponent sees — including the one the game made up for you.
  const nameEl = $('homeName');
  nameEl.value = getName?.() ?? '';
  const readName = () => nameEl.value.trim() || 'Player';
  nameEl.oninput = () => {
    try { localStorage.setItem('sunnylinks.name', readName()); } catch { /* private mode */ }
  };

  // ---------------------------------------------------------- preview
  const wrap = document.createElement('div');
  wrap.id = 'previewWrap';
  $('homeStage').appendChild(wrap);

  const preview = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  preview.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  preview.shadowMap.enabled = false;
  preview.toneMapping = THREE.NoToneMapping;
  wrap.appendChild(preview.domElement);

  const pScene = new THREE.Scene();
  const pCam = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  pScene.add(new THREE.HemisphereLight(0xdcefff, 0x9ec489, 1.5));
  const key = new THREE.DirectionalLight(0xfff2da, 1.9);
  key.position.set(-3, 4, 3.4);
  pScene.add(key);

  const ramp = makeToonRamp();
  // Two groups, not one: `turn` spins, `centre` holds the offset that puts the
  // figure on the spin axis. Rotating a group whose contents sit off to one
  // side swings them round the empty middle instead of turning them on the
  // spot, which is what one group did.
  const turn = new THREE.Group();
  const centre = new THREE.Group();
  turn.add(centre);
  turn.rotation.y = 0.55;      // three-quarter view; square on reads as a mugshot
  pScene.add(turn);
  let figure = null;

  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const mid = new THREE.Vector3();

  const rebuild = (look) => {
    if (!wrap.clientWidth) return;
    if (figure) centre.remove(figure.root);
    figure = new Golfer(ramp, look);
    figure.forceIdle();
    centre.add(figure.root);

    // Frame from what is actually there. The figure is posed at address beside
    // a ball, so where it ends up depends on the club and the stance — guessing
    // an offset got it wrong, and would get it wrong again the next time the
    // rig changed.
    //
    // Measured square on, with the offset cleared. setFromObject reports a
    // world-space box, and `centre` sits under the turntable — so measuring
    // mid-spin and then feeding the result back as a local offset mixes the two
    // spaces, and the framing drifts with whatever angle it happened to catch.
    const yaw = turn.rotation.y;
    turn.rotation.y = 0;
    centre.position.set(0, 0, 0);
    turn.updateMatrixWorld(true);
    box.setFromObject(figure.root);
    box.getSize(size);
    box.getCenter(mid);
    centre.position.set(-mid.x, -box.min.y, -mid.z);
    turn.rotation.y = yaw;

    // Fill the frame with a little air. Width is measured square on but shown
    // at three-quarters, where the figure is wider, so the margin is generous.
    const fov = (pCam.fov * Math.PI) / 180;
    const need = Math.max(size.y / 2, (size.x / 2) / pCam.aspect);
    const dist = (need * 1.42) / Math.tan(fov / 2);
    pCam.position.set(0, size.y * 0.55, dist);
    pCam.lookAt(0, size.y * 0.5, 0);
  };

  const fit = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    preview.setSize(w, h, false);
    pCam.aspect = w / h;
    pCam.updateProjectionMatrix();
  };
  fit();
  rebuild(getLook());
  window.addEventListener('resize', () => { fit(); rebuild(getLook()); });

  let t = 0, raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    // Nothing to draw unless a screen with the stage on it is up.
    if (root.classList.contains('hide') || (at !== 'home' && at !== 'cust')) return;
    if (!figure) { fit(); rebuild(getLook()); return; }
    t += 1 / 60;
    turn.rotation.y = 0.55 + Math.sin(t * 0.35) * 0.42;
    figure.update(1 / 60, t);
    preview.render(pScene, pCam);
  };
  tick();

  // ---------------------------------------------------------- kit controls
  buildKit?.($('custOpts'));

  // ---------------------------------------------------------- lobbies
  const lobbyHost = $('lobbies');
  const showLobbies = (list) => {
    lobbyHost.innerHTML = '';
    if (!list || !list.length) {
      const none = document.createElement('div');
      none.id = 'lobbyNone';
      none.textContent = 'No open lobbies. Create one, or try a quick match.';
      lobbyHost.appendChild(none);
      return;
    }
    for (const l of list) {
      const course = COURSES.find((c) => c.id === l.course);
      const el = document.createElement('div');
      el.className = 'lobby';
      el.innerHTML = '<div><div class="who"></div><div class="what"></div></div>';
      el.querySelector('.who').textContent = l.name;
      el.querySelector('.what').textContent =
        `${course?.name ?? 'Unknown course'} · ${TIMES[l.time]?.label ?? 'Day'}`;
      const b = document.createElement('button');
      b.textContent = 'Join';
      b.onclick = () => onJoin?.(l.id, { course: l.course, time: l.time });
      el.appendChild(b);
      lobbyHost.appendChild(el);
    }
  };

  // ---------------------------------------------------------- buttons
  const round = () => ({ course: state.course, time: state.time, name: readName() });
  $('btnSolo').onclick = () => onStart?.(round());
  $('btnHost').onclick = () => onHost?.(round());
  $('btnQuick').onclick = () => onQuick?.(round());

  return {
    show(screen) {
      root.classList.remove('hide');
      go(screen ?? 'home');
    },
    hide() { root.classList.add('hide'); },
    get visible() { return !root.classList.contains('hide'); },
    /**
     * Re-dress the preview after the kit controls change something. setLook
     * rather than rebuild: a swatch click is one colour, and rebuilding the
     * whole figure for it would also re-run the framing on every drag of a
     * colour picker.
     */
    refreshLook() { figure?.setLook(getLook()); },
    showLobbies,
    setStatus(text) { $('mpLive').textContent = text ?? ''; },
    dispose() { cancelAnimationFrame(raf); preview.dispose(); },
  };
}
