/**
 * admin.js — the mod menu.
 *
 * Hidden until you type ADMIN. There is no button for it anywhere, which is
 * the point: it exists to jump around the course while working on it, and a
 * visible control for that would be one more thing a player can press by
 * accident in the middle of a round.
 *
 * The sequence is matched against a rolling buffer of the last few keys rather
 * than a state machine, so a mistyped letter costs you nothing — carry on and
 * the correct five in a row still fire. Typing into a text field never counts,
 * or naming yourself "Vladimir" would open it.
 */

const OPEN_SEQ = 'admin';

const css = `
#admin{
  position:fixed;inset:0;z-index:80;display:none;place-items:center;
  background:rgba(20,14,7,.55);
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
}
#admin.open{display:grid}
#adminCard{
  width:min(560px,calc(100vw - 36px));max-height:calc(100vh - 60px);overflow-y:auto;
  padding:20px 22px 22px;border-radius:22px;text-align:left;color:var(--ink);
  background:linear-gradient(180deg,#fbf1d9,#ecd9b0);
  border:5px solid var(--wood);
  box-shadow:0 0 0 3px var(--ink),0 20px 50px rgba(0,0,0,.6),
             inset 0 3px 0 rgba(255,255,255,.6);
}
#adminHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}
#adminCard h3{
  margin:0;font-size:19px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;
  color:#fff;text-shadow:0 3px 0 rgba(0,0,0,.32);
  background:linear-gradient(180deg,#e07b5b,#b34627);
  border:3px solid var(--ink);border-radius:12px;padding:7px 18px;
  box-shadow:0 4px 0 #8a331a,inset 0 2px 0 rgba(255,255,255,.3);
}
#adminClose{
  width:38px;height:38px;flex:none;font:inherit;font-size:16px;font-weight:900;
  border:3px solid var(--ink);border-radius:11px;cursor:pointer;color:#fff;
  background:linear-gradient(180deg,#f6a824,#cf7c0d);
  box-shadow:0 4px 0 #9d5c07,inset 0 2px 0 rgba(255,255,255,.4);
}
#adminClose:active{transform:translateY(3px);box-shadow:0 1px 0 #9d5c07}
#adminWhere{font-size:12.5px;font-weight:800;opacity:.55;margin:2px 0 4px}
.adminLabel{
  font-size:11px;font-weight:900;letter-spacing:1px;opacity:.5;margin:16px 0 8px;
}
.adminGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(58px,1fr));gap:7px}
.adminHole{
  font:inherit;font-size:14px;font-weight:900;padding:11px 4px;border-radius:11px;
  cursor:pointer;color:var(--ink);border:3px solid var(--ink);
  background:linear-gradient(180deg,#fdf6e6,#ecd9b0);
  box-shadow:0 4px 0 rgba(61,39,22,.45),inset 0 2px 0 rgba(255,255,255,.6);
}
.adminHole:active{transform:translateY(3px);box-shadow:0 1px 0 rgba(61,39,22,.45)}
.adminHole.on{
  background:linear-gradient(180deg,#9ad966,#4f9330);color:#fff;
  text-shadow:0 2px 0 rgba(0,0,0,.28);
  box-shadow:0 4px 0 #3a6f22,inset 0 2px 0 rgba(255,255,255,.4);
}
.adminHole small{display:block;font-size:9.5px;font-weight:800;opacity:.6;margin-top:2px}
.adminHole.on small{opacity:.85}
.adminRow{display:flex;gap:7px;flex-wrap:wrap}
.adminChip{
  font:inherit;font-size:12.5px;font-weight:900;padding:9px 16px;border-radius:11px;
  cursor:pointer;text-transform:uppercase;letter-spacing:.4px;color:var(--ink);
  border:3px solid var(--ink);
  background:linear-gradient(180deg,#fdf6e6,#ecd9b0);
  box-shadow:0 4px 0 rgba(61,39,22,.45),inset 0 2px 0 rgba(255,255,255,.6);
}
.adminChip:active{transform:translateY(3px);box-shadow:0 1px 0 rgba(61,39,22,.45)}
.adminChip.on{
  background:linear-gradient(180deg,#ffd970,#cf7c0d);color:#fff;
  text-shadow:0 2px 0 rgba(0,0,0,.28);
  box-shadow:0 4px 0 #9d5c07,inset 0 2px 0 rgba(255,255,255,.45);
}
#adminNote{font-size:11.5px;font-weight:700;opacity:.5;margin-top:16px;line-height:1.5}
`;

/**
 * `api` is what the game is willing to let this poke at:
 *   holes()      the current course's hole list
 *   current()    which one we are on, or -1 before a round starts
 *   goHole(i)    jump to it
 *   times()      the time-of-day table
 *   time()       which one is active
 *   setTime(k)   rebuild the world under a different sun
 *   playing()    whether a round has started at all
 */
export function createAdminMenu(api) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'admin';
  root.innerHTML = `
    <div id="adminCard">
      <div id="adminHead">
        <h3>Mod menu</h3>
        <button id="adminClose">✕</button>
      </div>
      <div id="adminWhere"></div>
      <div class="adminLabel">JUMP TO HOLE</div>
      <div class="adminGrid" id="adminHoles"></div>
      <div class="adminLabel">TIME OF DAY</div>
      <div class="adminRow" id="adminTimes"></div>
      <div id="adminNote">Type ADMIN to open this again. Changing the time
        rebuilds the hole, so the ball goes back to the tee.</div>
    </div>`;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector('#' + id);

  const render = () => {
    const holes = api.holes();
    const at = api.current();
    const playing = api.playing();

    $('adminWhere').textContent = playing
      ? `${api.courseName()} · hole ${at + 1} of ${holes.length}`
      : 'No round in progress — start one first.';

    const grid = $('adminHoles');
    grid.innerHTML = '';
    holes.forEach((h, i) => {
      const b = document.createElement('button');
      b.className = 'adminHole' + (i === at ? ' on' : '');
      b.innerHTML = `${h.n}<small>PAR ${h.par}</small>`;
      b.title = h.name;
      b.disabled = !playing;
      b.style.opacity = playing ? '' : '.45';
      b.onclick = () => { api.goHole(i); close(); };
      grid.appendChild(b);
    });

    const times = $('adminTimes');
    times.innerHTML = '';
    for (const [key, t] of Object.entries(api.times())) {
      const c = document.createElement('button');
      c.className = 'adminChip' + (key === api.time() ? ' on' : '');
      c.textContent = t.label;
      c.disabled = !playing;
      c.style.opacity = playing ? '' : '.45';
      c.onclick = () => { api.setTime(key); close(); };
      times.appendChild(c);
    }
  };

  const open = () => { render(); root.classList.add('open'); };
  const close = () => root.classList.remove('open');

  $('adminClose').onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };

  // ---------------------------------------------------------- the sequence
  let buf = '';
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) { close(); return; }
    // Never while someone is typing into something.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.key.length !== 1) return;
    buf = (buf + e.key.toLowerCase()).slice(-OPEN_SEQ.length);
    if (buf === OPEN_SEQ) {
      buf = '';
      if (root.classList.contains('open')) close(); else open();
    }
  });

  return { open, close, get visible() { return root.classList.contains('open'); } };
}
