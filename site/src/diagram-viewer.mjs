// 다이어그램 크게 보기. 본문에서는 다이어그램을 화면 한 장에 들어오게 줄여 보여 주고(app.css),
// 다이어그램을 누르거나 "크게 보기"를 누르면 이 창에서 확대(휠·버튼·키)와 이동(끌기)을 한다.
const MIN = 0.1;
const MAX = 8;
const STEP = 1.25;
const FIT_MAX = 2; // 맞춤으로 작은 다이어그램을 과하게 키우지 않는다
const PAD = 24;

const clamp = (s) => Math.min(MAX, Math.max(MIN, s));

/** svg의 원래 크기(viewBox). 없으면 그려진 크기 */
function naturalSize(svg) {
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 1, h: r.height || 1 };
}

export function createDiagramViewer(w) {
  const doc = w.document;
  let ui = null;
  const view = { s: 1, x: 0, y: 0, w: 1, h: 1 };

  const hide = () => {
    if (ui.dialog.open) (ui.dialog.close ? ui.dialog.close() : ui.dialog.removeAttribute('open'));
    ui.canvas.replaceChildren();
  };

  function button(label, title, onclick) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onclick);
    return b;
  }

  function build() {
    const dialog = doc.createElement('dialog');
    dialog.className = 'task-dialog diagram-dialog';
    dialog.setAttribute('aria-label', '다이어그램 크게 보기');
    const bar = doc.createElement('div');
    bar.className = 'dialog-bar';
    const title = doc.createElement('span');
    title.className = 'dialog-title';
    title.textContent = '다이어그램';
    const level = doc.createElement('span');
    level.className = 'diagram-level';
    const actions = doc.createElement('span');
    actions.className = 'dialog-actions';
    actions.append(
      button('−', '축소 (-)', () => zoomAtCenter(1 / STEP)),
      button('+', '확대 (+)', () => zoomAtCenter(STEP)),
      button('맞춤', '화면에 맞춤 (0)', fit),
      button('100%', '원래 크기 (1)', actual),
    );
    const close = button('✕', '닫기', hide);
    close.className = 'icon';
    bar.append(title, level, actions, close);
    const stage = doc.createElement('div');
    stage.className = 'diagram-stage';
    const canvas = doc.createElement('div');
    canvas.className = 'diagram-canvas';
    stage.append(canvas);
    dialog.append(bar, stage);
    doc.body.append(dialog);

    dialog.addEventListener('click', (e) => { if (e.target === dialog) hide(); }); // 바깥 클릭
    dialog.addEventListener('close', () => canvas.replaceChildren());
    dialog.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const act = { '+': () => zoomAtCenter(STEP), '=': () => zoomAtCenter(STEP), '-': () => zoomAtCenter(1 / STEP), 0: fit, 1: actual }[e.key];
      if (act) { e.preventDefault(); act(); }
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY / 400), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
      stage.setPointerCapture?.(e.pointerId);
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      view.x = e.clientX - drag.x;
      view.y = e.clientY - drag.y;
      apply();
    });
    const end = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', (e) => {
      const r = stage.getBoundingClientRect();
      zoomAt(STEP * STEP, e.clientX - r.left, e.clientY - r.top);
    });
    return { dialog, stage, canvas, level };
  }

  function apply() {
    ui.canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    ui.level.textContent = `${Math.round(view.s * 100)}%`;
  }

  function stageSize() {
    const r = ui.stage.getBoundingClientRect();
    return { sw: r.width || w.innerWidth || 800, sh: r.height || w.innerHeight || 600 };
  }

  function center(s) {
    const { sw, sh } = stageSize();
    view.s = s;
    view.x = (sw - view.w * s) / 2;
    view.y = (sh - view.h * s) / 2;
    apply();
  }

  function fit() {
    const { sw, sh } = stageSize();
    center(clamp(Math.min((sw - PAD * 2) / view.w, (sh - PAD * 2) / view.h, FIT_MAX)));
  }

  function actual() { center(1); }

  /** (px, py) 지점이 제자리에 있도록 k배 한다 */
  function zoomAt(k, px, py) {
    const s = clamp(view.s * k);
    view.x = px - ((px - view.x) * s) / view.s;
    view.y = py - ((py - view.y) * s) / view.s;
    view.s = s;
    apply();
  }

  function zoomAtCenter(k) {
    const { sw, sh } = stageSize();
    zoomAt(k, sw / 2, sh / 2);
  }

  function open(svg) {
    ui ??= build();
    const { w: nw, h: nh } = naturalSize(svg);
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', nw);
    copy.setAttribute('height', nh);
    copy.style.maxWidth = 'none';
    copy.style.maxHeight = 'none';
    ui.canvas.replaceChildren(copy);
    Object.assign(view, { w: nw, h: nh });
    if (!ui.dialog.open) (ui.dialog.showModal ? ui.dialog.showModal() : ui.dialog.setAttribute('open', ''));
    fit();
  }

  /** mermaid가 그린 pre.mermaid에 크게 보기를 붙인다 */
  function attach(pre) {
    const svg = pre.querySelector(':scope > svg');
    if (!svg || pre.querySelector(':scope > .diagram-zoom')) return;
    pre.classList.add('zoomable');
    svg.addEventListener('click', () => open(svg));
    const b = button('⤢', '크게 보기', () => open(svg));
    b.className = 'diagram-zoom';
    pre.append(b);
  }

  return { attach, open };
}
