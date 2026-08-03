/**
 * kit.js — the "change your golfer" controls.
 *
 * Built in script rather than markup because they are entirely derived from
 * what the golfer says it supports: the colour rows come from `options.colours`,
 * the style rows from the rest. Adding a new customisable field to DEFAULT_LOOK
 * puts a new row here with no work in this file, which is the point of having
 * done the model as regions in the first place.
 *
 * This builds the controls into a container someone else owns, and nothing
 * else. It used to be a floating panel with its own button, its own fixed
 * position and its own outside-click-to-close — all of which existed because it
 * opened over the game. It no longer does: customising happens on its own
 * screen in the menu, so the screen owns the layout and the way out.
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
  .kitRow{margin-bottom:16px}
  .kitRow .kitLabel{font-size:11px; font-weight:900; letter-spacing:1px;
    opacity:.55; margin-bottom:8px; color:var(--ink)}
  .kitSwatches{display:flex; flex-wrap:wrap; gap:9px; align-items:center}
  .kitSw{
    width:30px; height:30px; border-radius:9px; cursor:pointer;
    border:3px solid var(--ink);
    box-shadow:0 3px 0 rgba(61,39,22,.5), inset 0 2px 0 rgba(255,255,255,.35);
    transition:transform .12s ease;
  }
  .kitSw:hover{transform:translateY(-1px)}
  .kitSw.on{transform:translateY(-2px); box-shadow:0 5px 0 rgba(61,39,22,.55),
    0 0 0 3px var(--gold), inset 0 2px 0 rgba(255,255,255,.35)}
  .kitSw:active{transform:translateY(2px); box-shadow:0 1px 0 rgba(61,39,22,.5)}
  .kitSw input{opacity:0; width:0; height:0; position:absolute; pointer-events:none}
  .kitAny{display:grid; place-items:center; font-size:12px; background:
    conic-gradient(#e8433f,#ffd05c,#1f7a4d,#2f6fd0,#9b59b6,#e8433f)}
  .kitChips{display:flex; flex-wrap:wrap; gap:7px}
  .kitChip{
    font-size:12px; font-weight:900; padding:8px 14px; border-radius:11px; cursor:pointer;
    text-transform:uppercase; letter-spacing:.4px; color:var(--ink);
    background:var(--wood-board) repeat 50% 50% / 200px 100px,
      linear-gradient(180deg,#fdf6e6,#ecd9b0);
    border:3px solid var(--ink);
    box-shadow:0 3px 0 rgba(61,39,22,.45), inset 0 2px 0 rgba(255,255,255,.6);
  }
  .kitChip:active{transform:translateY(2px); box-shadow:0 1px 0 rgba(61,39,22,.45)}
  .kitChip.on{
    background:linear-gradient(180deg,#ffd970,var(--orange-d)); color:#fff;
    text-shadow:0 2px 0 rgba(0,0,0,.28);
    box-shadow:0 3px 0 var(--orange-lip), inset 0 2px 0 rgba(255,255,255,.45);
  }
  /* A groove cut in the board rather than a drawn line: a dark score with a
     lit edge under it, which is what a chisel leaves. */
  .kitSplit{
    border:0; height:3px; margin:18px 0; border-radius:2px;
    background:linear-gradient(180deg, rgba(61,39,22,.42) 0 2px, rgba(255,255,255,.55) 2px 3px);
  }
  `;
  document.head.appendChild(el);
}

/**
 * Build the controls into `host`.
 *
 * `api` is the golfer facade from main.js: { look, presets, options, set, preset }.
 */
export function createKitControls(api, host) {
  styleTag();
  const panel = host;

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

  // ---- presets ----
  const presetRow = h('div', 'kitRow');
  h('div', 'kitLabel', presetRow).textContent = 'PRESET';
  const presetChips = h('div', 'kitChips', presetRow);
  for (const name of api.presets) {
    const chip = h('div', 'kitChip', presetChips);
    chip.textContent = name;
    chip.onclick = () => { api.preset(name); refresh(); };
  }

  h('hr', 'kitSplit');

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

  h('hr', 'kitSplit');

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

  refresh();
  return { refresh };
}
