let segs = [], sents = [], warnEl, pickEl;
const style = document.createElement('style');
style.textContent = '::highlight(rf-hl){background:#ffe066;color:#000}::highlight(rf-pick){background:#bfdbfe;color:#000}@keyframes rf-fade{from{opacity:0}}@keyframes rf-in{from{opacity:0;transform:translate(-50%,-12px)}}';
document.documentElement.append(style);

const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,div,td,th,tr,blockquote,section,article,pre,dd,dt,figcaption,summary';

function capture() {
  const sel = getSelection();
  segs = []; sents = [];
  // always read the whole page; a selection only says where to start
  const sr = sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
  let rootEl = document.querySelector('article, main, [role=main]') || document.body;
  if (sr && !rootEl.contains(sr.startContainer)) rootEl = document.body;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let text = '', lastBlock;
  for (let n; (n = walker.nextNode()); ) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,noscript,textarea,nav,header,footer,aside,form,button,[role=navigation]') || !el.checkVisibility()) continue;
    const t = n.data;
    if (!t.trim()) continue;
    // a new block (heading, paragraph, list item...) always ends the previous sentence
    const block = el.closest(BLOCKS);
    if (text) text += block !== lastBlock ? '\n' : /\s$/.test(text) ? '' : ' ';
    lastBlock = block;
    segs.push({ n, s: 0, at: text.length, len: t.length });
    text += t.replace(/\s/g, ' '); // source line breaks are not sentence breaks (same length keeps offsets valid)
  }
  for (const m of text.matchAll(/[^.!?。！？\n]+[.!?。！？]*/g)) {
    const t = m[0].trim();
    if (t.length < 25) continue;
    const a = m.index + m[0].length - m[0].trimStart().length;
    sents.push({ t, a, b: m.index + m[0].trimEnd().length });
  }
  let start = sr ? idxAt(sr.startContainer, sr.startOffset) : -1;
  if (start < 0) start = sents.findIndex((_, i) => rangeOf(i)?.getBoundingClientRect().top >= 0); // first sentence on screen
  return { sents: sents.map((s) => s.t), start: Math.max(start, 0) };
}

// index of the sentence at a DOM position, or -1 if it isn't in the captured text
function idxAt(node, off) {
  const g = segs.find((g) => g.n === node);
  if (!g) return -1;
  const pos = g.at + Math.min(Math.max(off - g.s, 0), g.len - 1);
  const i = sents.findIndex((s) => s.b > pos);
  return i < 0 ? sents.length - 1 : i;
}

// map a position in the joined text back to (text node, offset)
const pt = (p, end) => {
  const q = end ? p - 1 : p;
  const g = segs.find((g) => q >= g.at && q < g.at + g.len);
  return g && [g.n, g.s + (q - g.at) + (end ? 1 : 0)];
};

function rangeOf(i) {
  const s = sents[i];
  const a = s && pt(s.a), b = s && pt(s.b, true);
  if (!a || !b) return null;
  const r = new Range();
  r.setStart(...a); r.setEnd(...b);
  return r;
}

function highlight(i) {
  const r = rangeOf(i);
  if (!r) return CSS.highlights.delete('rf-hl');
  CSS.highlights.set('rf-hl', new Highlight(r));
  r.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function warn(on) {
  if (!warnEl) {
    warnEl = document.createElement('div');
    warnEl.textContent = '👀 Are you still focusing? Keep reading aloud!';
    warnEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;color:#fff;font:600 16px/1.3 system-ui,sans-serif;padding:12px 22px;border-radius:99px;box-shadow:0 8px 28px #0005;animation:rf-in .25s ease-out;background:linear-gradient(135deg,#f43f5e,#f97316)';
    document.documentElement.append(warnEl);
  }
  warnEl.style.display = on ? 'block' : 'none';
}

// let the user click where reading should begin
function pick() {
  capture();
  pickEl ||= Object.assign(document.createElement('div'), { textContent: '📍 Click where you want to start reading (Esc to cancel)' });
  pickEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;color:#fff;font:600 16px/1.3 system-ui,sans-serif;padding:12px 22px;border-radius:99px;box-shadow:0 8px 28px #0005;animation:rf-in .25s ease-out;background:linear-gradient(135deg,#5b5bf0,#8b5cf6)';
  document.documentElement.append(pickEl);
  document.documentElement.style.cursor = 'crosshair';
  const done = () => {
    pickEl.remove();
    document.documentElement.style.cursor = '';
    CSS.highlights.delete('rf-pick');
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => e.key === 'Escape' && done();
  const at = (e) => {
    const cp = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    const cr = cp ? null : document.caretRangeFromPoint(e.clientX, e.clientY);
    let i = idxAt(cp?.offsetNode ?? cr?.startContainer, cp?.offset ?? cr?.startOffset);
    if (i < 0) i = sents.findIndex((_, k) => rangeOf(k)?.getBoundingClientRect().bottom >= e.clientY); // clicked outside text: next sentence below
    return i < 0 ? sents.length - 1 : i;
  };
  let raf;
  const onMove = (e) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { // preview the sentence a click would start from
      const r = rangeOf(at(e));
      r ? CSS.highlights.set('rf-pick', new Highlight(r)) : CSS.highlights.delete('rf-pick');
    });
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    done();
    const i = at(e);
    chrome.runtime.sendMessage({ type: 'picked', i, sents: sents.map((s) => s.t) });
  };
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
}

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m.type === 'capture') reply(capture());
  else if (m.type === 'pick') pick();
  else if (m.type === 'highlight') highlight(m.i);
  else if (m.type === 'warn') warn(m.on);
  else if (m.type === 'clear') { CSS.highlights.delete('rf-hl'); warn(false); segs = []; sents = []; }
});
