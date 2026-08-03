/**
 * menu.js — the front screen.
 *
 * Your golfer on the left, the round you are about to play on the right.
 *
 * The preview has its own renderer, scene and light rather than borrowing the
 * game's. That costs a second WebGL context and is worth it: the game's scene
 * is a whole golf course whose lighting is tuned for a course, and posing a
 * figure inside it would mean either building the world before the menu (slow,
 * and the menu exists partly to cover that) or lighting the menu with whatever
 * the course happens to have. A tiny scene with one key light and a turntable
 * is independent of all of it.
 */

import * as THREE from 'three';
import { Golfer } from './golfer.js';
import { makeToonRamp } from './terrain.js';
import { COURSES } from './courses.js';
import { TIMES } from './scenery.js';

const css = `
#menu{
  position:fixed;inset:0;z-index:60;display:grid;place-items:center;
  background:linear-gradient(170deg,#bfe4f7 0%,#dff1f8 46%,#e9f5ec 100%);
  transition:opacity .45s ease;
}
#menu.hide{opacity:0;pointer-events:none}
#menuInner{
  display:flex;gap:34px;align-items:stretch;
  width:min(880px,calc(100vw - 40px));max-height:calc(100vh - 40px);
  transition:transform .3s cubic-bezier(.22,1,.36,1);
}
/* The kit panel is docked to the right edge; slide out from under it so the
   golfer you are dressing stays in sight while you dress him. */
#menu.withKit #menuInner{transform:translateX(-152px)}
@media (max-width:1000px){#menu.withKit #menuInner{transform:none}}
#menuLeft{display:flex;flex-direction:column;align-items:center;gap:14px;flex:0 0 268px}
#previewWrap{
  /* flex:none, or the flex parent shrinks it — down the main axis on mobile,
     where it collapsed to a sliver. */
  width:268px;height:330px;flex:none;border-radius:24px;overflow:hidden;position:relative;
  background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.2));
  border:1px solid rgba(255,255,255,.7);box-shadow:0 14px 36px rgba(25,70,95,.16);
}
#previewWrap canvas{width:100%;height:100%;display:block}
#menuName{
  width:100%;text-align:center;font:inherit;font-size:15px;font-weight:800;
  padding:9px 12px;border-radius:999px;border:1px solid rgba(40,70,90,.18);
  background:rgba(255,255,255,.72);color:#22333d;
}
#menuName:focus{outline:2px solid rgba(70,150,110,.5);outline-offset:1px}

#menuRight{
  flex:1;min-width:0;display:flex;flex-direction:column;
  background:rgba(255,255,255,.68);border:1px solid rgba(255,255,255,.8);
  border-radius:26px;box-shadow:0 18px 46px rgba(25,70,95,.18);
  backdrop-filter:blur(14px) saturate(1.15);-webkit-backdrop-filter:blur(14px) saturate(1.15);
  padding:18px 20px 20px;overflow:hidden;
}
#menuTitle{font-size:26px;font-weight:800;letter-spacing:-.4px;margin:0 0 2px}
#menuSub{font-size:12.5px;font-weight:700;opacity:.5;margin-bottom:14px}

#tabs{display:flex;gap:6px;margin-bottom:14px}
.tab{
  flex:1;text-align:center;font-size:13px;font-weight:800;padding:9px 10px;
  border-radius:12px;cursor:pointer;background:rgba(255,255,255,.55);
  border:1px solid rgba(40,70,90,.14);
}
.tab.on{background:#2f7d55;color:#fff;border-color:#2f7d55}

#panes{flex:1;min-height:0;overflow-y:auto;padding-right:4px}
.pane{display:none}
.pane.on{display:block}
.mLabel{font-size:11px;font-weight:800;opacity:.5;letter-spacing:.4px;margin:14px 0 7px}
.mLabel:first-child{margin-top:0}

.cards{display:flex;gap:8px;flex-wrap:wrap}
.card{
  flex:1 1 190px;text-align:left;padding:11px 13px;border-radius:14px;cursor:pointer;
  background:rgba(255,255,255,.6);border:1.5px solid rgba(40,70,90,.14);
}
.card.on{border-color:#2f7d55;background:rgba(47,125,85,.10)}
.card b{display:block;font-size:14px;font-weight:800;margin-bottom:2px}
.card span{font-size:11.5px;font-weight:600;opacity:.6;line-height:1.35;display:block}

.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{
  font-size:12.5px;font-weight:800;padding:8px 14px;border-radius:999px;cursor:pointer;
  background:rgba(255,255,255,.6);border:1px solid rgba(40,70,90,.14);
}
.chip.on{background:#2b3a44;color:#fff;border-color:#2b3a44}

.bigBtn{
  width:100%;margin-top:18px;border:none;font:inherit;font-weight:800;font-size:15px;
  color:#fff;background:linear-gradient(180deg,#63c46f,#48ab5b);
  padding:14px 20px;border-radius:16px;cursor:pointer;
  box-shadow:0 10px 24px rgba(60,150,90,.34);
  transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s;
}
.bigBtn:hover{transform:translateY(-1px)}
.bigBtn:active{transform:scale(.98)}
.bigBtn.ghost{background:rgba(255,255,255,.7);color:#26424f;box-shadow:none;
  border:1px solid rgba(40,70,90,.16);margin-top:8px}

#lobbies{margin-top:4px;display:flex;flex-direction:column;gap:6px;
  max-height:190px;overflow-y:auto}
.lobby{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 12px;border-radius:12px;background:rgba(255,255,255,.62);
  border:1px solid rgba(40,70,90,.12);
}
.lobby .who{font-size:13px;font-weight:800}
.lobby .what{font-size:11px;font-weight:700;opacity:.55}
.lobby button{
  border:none;font:inherit;font-weight:800;font-size:12px;color:#fff;cursor:pointer;
  background:#2f7d55;padding:7px 14px;border-radius:999px;
}
#lobbyNone{font-size:12.5px;font-weight:700;opacity:.45;padding:10px 2px}
#mpNote{font-size:11.5px;font-weight:700;opacity:.5;margin-top:10px;line-height:1.45}
#mpLive{font-size:12.5px;font-weight:800;color:#2f7d55;margin-top:10px;min-height:16px}

@media (max-width:760px){
  #menuInner{flex-direction:column;gap:14px;overflow-y:auto;padding:4px 0}
  #menuLeft{flex:none;gap:10px}
  #previewWrap{width:152px;height:188px}
  #menuRight{padding:16px 16px 18px;border-radius:22px}
  #menuTitle{font-size:22px}
  #menuSub{margin-bottom:12px}
  .card{flex:1 1 100%}
  .bigBtn{padding:13px 18px}
  /* One scrolling region, not two nested ones — otherwise Start round sits
     below the fold of an inner scroller nobody knows is there. */
  #menuRight,#panes{overflow:visible}
  #lobbies{max-height:none}
}
`;

export function createMenu({ getLook, getName, onCustomise, onStart, onHost, onQuick, onJoin, onBrowse }) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'menu';
  root.innerHTML = `
    <div id="menuInner">
      <div id="menuLeft">
        <div id="previewWrap"></div>
        <button class="bigBtn ghost" id="btnCustomise">Customise golfer</button>
        <input id="menuName" maxlength="18" placeholder="Your name">
      </div>
      <div id="menuRight">
        <h1 id="menuTitle">Sunny Links</h1>
        <div id="menuSub">Pick a course, pick your light, and play.</div>
        <div id="tabs">
          <div class="tab on" data-tab="solo">Solo</div>
          <div class="tab" data-tab="mp">Multiplayer</div>
        </div>
        <div id="panes">
          <div class="pane on" data-pane="solo">
            <div class="mLabel">COURSE</div>
            <div class="cards" id="soloCourses"></div>
            <div class="mLabel">TIME OF DAY</div>
            <div class="chips" id="soloTimes"></div>
            <button class="bigBtn" id="btnSolo">Start round</button>
          </div>
          <div class="pane" data-pane="mp">
            <div class="mLabel">COURSE</div>
            <div class="cards" id="mpCourses"></div>
            <div class="mLabel">TIME OF DAY</div>
            <div class="chips" id="mpTimes"></div>
            <div class="mLabel">OPEN LOBBIES</div>
            <div id="lobbies"><div id="lobbyNone">Looking…</div></div>
            <div id="mpLive"></div>
            <button class="bigBtn" id="btnHost">Create lobby</button>
            <button class="bigBtn ghost" id="btnQuick">Quick match instead</button>
            <div id="mpNote">Whoever creates the lobby picks the course and the
              light — joining adopts theirs, so you both play the same round.</div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  // ---------------------------------------------------------- choices
  const state = { course: COURSES[0].id, time: 'day', tab: 'solo' };

  const buildCards = (host, onPick) => {
    host.innerHTML = '';
    const made = COURSES.map((c) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `<b>${c.name}</b><span>${c.holes.length} holes · par ${
        c.holes.reduce((s, h) => s + h.par, 0)}<br>${c.blurb}</span>`;
      el.onclick = () => { state.course = c.id; onPick(); };
      host.appendChild(el);
      return { el, id: c.id };
    });
    return () => made.forEach((m) => m.el.classList.toggle('on', m.id === state.course));
  };

  const buildTimes = (host, onPick) => {
    host.innerHTML = '';
    const made = Object.entries(TIMES).map(([key, t]) => {
      const el = document.createElement('div');
      el.className = 'chip';
      el.textContent = t.label;
      el.onclick = () => { state.time = key; onPick(); };
      host.appendChild(el);
      return { el, key };
    });
    return () => made.forEach((m) => m.el.classList.toggle('on', m.key === state.time));
  };

  const refreshers = [];
  const refresh = () => refreshers.forEach((f) => f());
  const $ = (id) => root.querySelector('#' + id);

  refreshers.push(buildCards($('soloCourses'), refresh));
  refreshers.push(buildTimes($('soloTimes'), refresh));
  refreshers.push(buildCards($('mpCourses'), refresh));
  refreshers.push(buildTimes($('mpTimes'), refresh));
  refresh();

  // ---------------------------------------------------------- tabs
  const tabs = [...root.querySelectorAll('.tab')];
  const panes = [...root.querySelectorAll('.pane')];
  tabs.forEach((t) => {
    t.onclick = () => {
      state.tab = t.dataset.tab;
      tabs.forEach((x) => x.classList.toggle('on', x === t));
      panes.forEach((p) => p.classList.toggle('on', p.dataset.pane === state.tab));
      // Only reach for the network when someone actually asks for it.
      if (state.tab === 'mp') onBrowse?.();
    };
  });

  // ---------------------------------------------------------- name
  // Seeded from the same place the match reads it, so what you see here is
  // what an opponent sees — including the one the game made up for you.
  const nameEl = $('menuName');
  nameEl.value = getName?.() ?? '';
  const readName = () => nameEl.value.trim() || 'Player';
  nameEl.oninput = () => {
    try { localStorage.setItem('sunnylinks.name', readName()); } catch { /* private mode */ }
  };

  // ---------------------------------------------------------- preview
  const wrap = $('previewWrap');
  const preview = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  preview.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  preview.setSize(wrap.clientWidth, wrap.clientHeight, false);
  preview.shadowMap.enabled = false;
  preview.toneMapping = THREE.NoToneMapping;
  wrap.appendChild(preview.domElement);

  const pScene = new THREE.Scene();
  const pCam = new THREE.PerspectiveCamera(34, wrap.clientWidth / wrap.clientHeight, 0.1, 40);
  pCam.position.set(0, 1.05, 3.5);
  pCam.lookAt(0, 0.86, 0);
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
  rebuild(getLook());

  let t = 0, raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (root.classList.contains('hide')) return;
    t += 1 / 60;
    turn.rotation.y = 0.55 + Math.sin(t * 0.35) * 0.42;
    figure?.update(1 / 60, t);
    preview.render(pScene, pCam);
  };
  tick();

  const fit = () => {
    if (!wrap.clientWidth) return;
    preview.setSize(wrap.clientWidth, wrap.clientHeight, false);
    pCam.aspect = wrap.clientWidth / wrap.clientHeight;
    pCam.updateProjectionMatrix();
    rebuild(getLook());   // the framing distance depends on the aspect
  };
  window.addEventListener('resize', fit);

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
      el.innerHTML = `<div><div class="who"></div><div class="what"></div></div>`;
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
  $('btnCustomise').onclick = () => onCustomise?.();
  $('btnSolo').onclick = () => onStart?.({ ...state, name: readName() });
  $('btnHost').onclick = () => onHost?.({ course: state.course, time: state.time, name: readName() });
  $('btnQuick').onclick = () => onQuick?.({ course: state.course, time: state.time, name: readName() });

  const openTab = (which) => tabs.find((t) => t.dataset.tab === which)?.click();

  return {
    show(tab) {
      root.classList.remove('hide');
      fit();
      rebuild(getLook());
      if (tab) openTab(tab);
    },
    hide() { root.classList.add('hide'); },
    get visible() { return !root.classList.contains('hide'); },
    /**
     * Re-dress the preview after the kit panel changes something. setLook
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
