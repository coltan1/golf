/**
 * kit.js — the "change your golfer" panel.
 *
 * Built in script rather than markup because it is entirely derived from what
 * the golfer says it supports: the colour rows come from `options.colours`, the
 * style rows from the rest. Adding a new customisable field to DEFAULT_LOOK
 * puts a new row in this panel with no work here, which is the point of having
 * done the model as regions in the first place.
 */

/** A spread of choices per region — enough to pick from without a colour wheel. */
const SWATCHES = {
  skin: [0xffdcc0, 0xf0bd93, 0xd99668, 0xb87545, 0x8d5a3b, 0x5c3a26],
  shirt: [0xfbfbf9, 0xe8433f, 0x2f6fd0, 0x1f7a4d, 0xffd05c, 0x9b59b6, 0x22262c, 0xf4744e],
  trim: [0xf4744e, 0x1f7a4d, 0xfbfbf9, 0x2f6fd0, 0xffd05c, 0x22262c],
  trousers: [0x3d4652, 0x22262c, 0xfbfbf9, 0xcdb98e, 0x2f4f4f, 0x6b4a2c],
  shoes: [0xfafafa, 0x22262c, 0xe8433f, 0x2f6fd0, 0xcdb98e],
  cap: [0x24384f, 0x1f7a4d, 0xe8433f, 0xffd05c, 0xfbfbf9, 0x22262c],
  hair: [0x1e1a17, 0x3b2a1d, 0x5c3d29, 0x8b5a2b, 0xc9a86b, 0xa33b2a, 0x8e8e8e],
  glove: [0xf6f8fa, 0x22262c, 0xe8433f],
};

const LABEL = {
  skin: 'Skin', shirt: 'Shirt', trim: 'Trim', trousers: 'Trousers',
  shoes: 'Shoes', cap: 'Hat', hair: 'Hair', glove: 'Glove',
  headwear: 'Headwear', hairStyle: 'Hair style', shades: 'Sunglasses',
};

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function styleTag() {
  if (document.getElementById('kitStyle')) return;
  const el = document.createElement('style');
  el.id = 'kitStyle';
  el.textContent = `
  #btnKit{
    pointer-events:auto; cursor:pointer; user-select:none;
    width:38px; height:38px; padding:0; display:grid; place-items:center; font-size:15px;
    transition:transform .25s cubic-bezier(.22,1,.36,1);
  }
  #btnKit:active{transform:scale(.92)}
  #kit{
    position:fixed; right:14px; top:64px; z-index:40; width:270px; max-width:calc(100vw - 28px);
    max-height:calc(100vh - 120px); overflow-y:auto;
    background:var(--pill); border:1px solid var(--pill-line); border-radius:18px;
    box-shadow:var(--shadow); backdrop-filter:blur(12px) saturate(1.15);
    -webkit-backdrop-filter:blur(12px) saturate(1.15);
    padding:14px 15px 16px; display:none;
  }
  #kit.open{display:block}
  #kit h4{margin:0 0 9px; font-size:13px; font-weight:800; letter-spacing:.2px; opacity:.85}
  .kitRow{margin-bottom:11px}
  .kitRow .kitLabel{font-size:11px; font-weight:700; opacity:.55; margin-bottom:5px; letter-spacing:.3px}
  .kitSwatches{display:flex; flex-wrap:wrap; gap:6px; align-items:center}
  .kitSw{
    width:22px; height:22px; border-radius:50%; cursor:pointer;
    border:2px solid rgba(255,255,255,.75); box-shadow:0 1px 3px rgba(0,0,0,.25);
    transition:transform .12s ease;
  }
  .kitSw:hover{transform:scale(1.14)}
  .kitSw.on{border-color:#2b3a44; transform:scale(1.14)}
  .kitSw input{opacity:0; width:0; height:0; position:absolute; pointer-events:none}
  .kitAny{display:grid; place-items:center; font-size:12px; background:
    conic-gradient(#e8433f,#ffd05c,#1f7a4d,#2f6fd0,#9b59b6,#e8433f)}
  .kitChips{display:flex; flex-wrap:wrap; gap:5px}
  .kitChip{
    font-size:11.5px; font-weight:700; padding:5px 10px; border-radius:999px; cursor:pointer;
    background:rgba(255,255,255,.55); border:1px solid rgba(40,70,90,.16); text-transform:capitalize;
  }
  .kitChip:hover{background:rgba(255,255,255,.8)}
  .kitChip.on{background:#2b3a44; color:#fff; border-color:#2b3a44}
  #kit hr{border:0; border-top:1px solid rgba(40,70,90,.14); margin:12px 0}
  `;
  document.head.appendChild(el);
}

/**
 * Build the panel and the button that opens it.
 *
 * `api` is the golfer facade from main.js: { look, presets, options, set, preset }.
 */
export function createKitPanel(api) {
  styleTag();

  const topRight = document.getElementById('topRight');
  const btn = document.createElement('div');
  btn.className = 'pill';
  btn.id = 'btnKit';
  btn.title = 'Customise your golfer';
  btn.textContent = '👕';
  if (topRight) topRight.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'kit';
  document.body.appendChild(panel);

  // Everything below re-reads api.look, so the panel can never drift out of
  // step with the figure — including when a preset changes six fields at once.
  const rows = [];
  const refresh = () => {
    const look = api.look;
    for (const r of rows) r(look);
  };

  const h = (tag, cls, parent) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    (parent ?? panel).appendChild(el);
    return el;
  };

  const title = h('h4');
  title.textContent = 'Your golfer';

  // ---- presets ----
  const presetRow = h('div', 'kitRow');
  h('div', 'kitLabel', presetRow).textContent = 'PRESET';
  const presetChips = h('div', 'kitChips', presetRow);
  for (const name of api.presets) {
    const chip = h('div', 'kitChip', presetChips);
    chip.textContent = name;
    chip.onclick = () => { api.preset(name); refresh(); };
  }

  h('hr');

  // ---- colours ----
  for (const key of api.options.colours) {
    const row = h('div', 'kitRow');
    h('div', 'kitLabel', row).textContent = (LABEL[key] ?? key).toUpperCase();
    const wrap = h('div', 'kitSwatches', row);

    const swatches = [];
    for (const c of SWATCHES[key] ?? []) {
      const sw = h('div', 'kitSw', wrap);
      sw.style.background = hex(c);
      sw.onclick = () => { api.set({ [key]: c }); refresh(); };
      swatches.push({ el: sw, colour: c });
    }

    // Anything not on the row: a real colour picker behind a swatch.
    const any = h('label', 'kitSw kitAny', wrap);
    any.title = 'Any colour';
    const picker = document.createElement('input');
    picker.type = 'color';
    any.appendChild(picker);
    picker.oninput = () => {
      api.set({ [key]: parseInt(picker.value.slice(1), 16) });
      refresh();
    };

    rows.push((look) => {
      let matched = false;
      for (const s of swatches) {
        const on = s.colour === look[key];
        s.el.classList.toggle('on', on);
        matched ||= on;
      }
      any.classList.toggle('on', !matched);
      picker.value = hex(look[key] ?? 0);
    });
  }

  h('hr');

  // ---- styles ----
  const styleRow = (key, values, render) => {
    const row = h('div', 'kitRow');
    h('div', 'kitLabel', row).textContent = (LABEL[key] ?? key).toUpperCase();
    const chips = h('div', 'kitChips', row);
    const made = values.map((v) => {
      const chip = h('div', 'kitChip', chips);
      chip.textContent = render ? render(v) : v;
      chip.onclick = () => { api.set({ [key]: v }); refresh(); };
      return { chip, value: v };
    });
    rows.push((look) => {
      for (const m of made) m.chip.classList.toggle('on', m.value === look[key]);
    });
  };

  styleRow('headwear', api.options.headwear);
  styleRow('hairStyle', api.options.hairStyle);
  styleRow('shades', api.options.shades, (v) => (v ? 'on' : 'off'));

  // ---- open / close ----
  const setOpen = (open) => panel.classList.toggle('open', open);
  btn.onclick = () => { setOpen(!panel.classList.contains('open')); refresh(); };
  // Anywhere else closes it — including the canvas, so a stray tap while the
  // panel is open does not also start a swing behind it. The button and the
  // panel are excluded by hit-testing rather than by stopping propagation:
  // pointerdown fires before click, so a bare listener here would close the
  // panel a moment before the button's own click reopened it, and the button
  // would never appear to close anything.
  document.addEventListener('pointerdown', (e) => {
    if (btn.contains(e.target) || panel.contains(e.target)) return;
    setOpen(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  refresh();
  return { refresh, setOpen };
}
