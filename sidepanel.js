const $ = (id) => document.getElementById(id);
const S = { sents: [], i: 0, running: false, rec: null, tabId: null, last: 0, warned: false, prog: 0, heard: '', shown: new Set(), fails: {}, cnt: 0 };
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => { const n = norm(s); return n.includes(' ') ? n.split(' ') : [...n]; }; // no spaces (CJK) -> chars

// lenient: >=70% of target words heard, any order
function match(target, heard) {
  const T = toks(target), pool = toks(heard);
  if (!T.length) return true;
  let hit = 0;
  for (const w of T) { const k = pool.indexOf(w); if (k >= 0) { hit++; pool.splice(k, 1); } }
  return hit / T.length >= 0.7;
}

// first target word (4+ letters) the user hasn't been heard saying
function unheard(target, heard) {
  const T = toks(target), pool = toks(heard);
  if (!norm(target).includes(' ')) return null; // CJK: no word definitions
  for (const w of T) {
    const k = pool.indexOf(w);
    if (k >= 0) pool.splice(k, 1);
    else if (w.length >= 4) return w;
  }
  return null;
}

const dict = new Map();
// Wiktionary REST: works for many languages; follows "plural of X" style entries once
async function lookup(w, code, depth = 0) {
  const key = code + w;
  if (!dict.has(key)) dict.set(key, fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const j = await dict.get(key);
  const e = (j?.[code] || j?.[Object.keys(j || {})[0]])?.[0];
  const html = e?.definitions?.find((d) => d.definition)?.definition;
  if (!html) return null;
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();
  const lemma = depth < 1 && text.length < 60 && text.match(/\bof ([\p{L}'-]+)$/u)?.[1];
  const base = lemma && (await lookup(lemma, code, depth + 1));
  return { pos: e.partOfSpeech, text: base ? `${text} — ${base.text}` : text };
}

async function define(w) {
  const code = ($('lang').value || navigator.language).split('-')[0];
  const at = S.i;
  const m = await lookup(w, code);
  if (S.i !== at) return; // sentence already advanced
  const b = document.createElement('b'), small = document.createElement('small'), p = document.createElement('p');
  b.textContent = w;
  small.textContent = m?.pos || '';
  p.textContent = m ? m.text : 'No definition found.';
  $('def').replaceChildren(b, small, p);
  $('def').hidden = false;
  $('cur').querySelector(`span:not(.heard)[data-n="${CSS.escape(w)}"]`)?.classList.add('stuck');
  touch(); // time to read it
}

// a failed attempt = you spoke part of this sentence but a word still wasn't heard; 2 fails on the same word -> definition
function attempt(utt) {
  const target = S.sents[S.i];
  const T = toks(target), pool = toks(utt);
  let hits = 0;
  for (const w of T) { const k = pool.indexOf(w); if (k >= 0) { hits++; pool.splice(k, 1); } }
  if (hits < 2) return; // not reading this sentence (other audio)
  const w = unheard(target, S.heard);
  if (!w) return;
  S.fails[w] = (S.fails[w] || 0) + 1;
  const key = S.i + w;
  if (S.fails[w] >= (+$('tries').value || 2) && !S.shown.has(key)) { S.shown.add(key); define(w); }
}

// how many content words (4+ letters) of the target were heard: real reading progress, not just any sound
function progress(target, heard) {
  const pool = toks(heard), cjk = !norm(target).includes(' ');
  let n = 0;
  for (const w of toks(target)) {
    if (!cjk && w.length < 4) continue;
    const k = pool.indexOf(w);
    if (k >= 0) { n++; pool.splice(k, 1); }
  }
  return n;
}

const toTab = (m) => S.tabId && chrome.tabs.sendMessage(S.tabId, m).catch(() => {});
const status = (t) => ($('status').textContent = t || '');
let ctx, siren;
const audio = () => (ctx ||= new AudioContext());
const beep = () => { const c = audio(), o = c.createOscillator(); o.frequency.value = 660; o.connect(c.destination); o.start(); o.stop(c.currentTime + 0.25); };

// siren that rings until you read again (touch) or press Stop (pause/reset)
function startAlarm() {
  if (siren) return;
  const c = audio(), o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; g.gain.value = 0.25;
  o.connect(g); g.connect(c.destination); o.start();
  let hi = false;
  const t = setInterval(() => { o.frequency.value = (hi = !hi) ? 880 : 620; }, 350);
  siren = { o, t };
  status('⏰ Alarm! Read the sentence aloud to stop it, or press Stop.');
}
function stopAlarm() {
  if (!siren) return;
  clearInterval(siren.t); siren.o.stop(); siren = null;
  status('');
}

// show the sentence as word spans so heard words turn green
function showSentence(t) {
  const cjk = !norm(t).includes(' ');
  const parts = cjk ? [...t] : t.split(/(\s+)/);
  $('cur').replaceChildren(...parts.map((p) => {
    if (!p.trim()) return document.createTextNode(p);
    const sp = document.createElement('span');
    sp.textContent = p;
    sp.dataset.n = norm(p);
    if (!sp.dataset.n) sp.className = 'heard'; // punctuation-only
    return sp;
  }));
}

function markHeard(heard) {
  const pool = toks(heard);
  for (const sp of $('cur').querySelectorAll('span:not(.heard)')) {
    const k = pool.indexOf(sp.dataset.n);
    if (k >= 0) { sp.classList.add('heard'); pool.splice(k, 1); }
  }
}

const PILLS = { ready: 'Ready', listening: 'Listening', paused: 'Paused', done: 'Done 🎉' };
function ui() {
  const finished = S.sents.length && S.i >= S.sents.length;
  const st = S.running ? 'listening' : finished ? 'done' : S.sents.length ? 'paused' : 'ready';
  $('pill').textContent = PILLS[st];
  $('pill').className = 'pill ' + st;
  $('toggle').textContent = S.running ? '⏹ Stop' : S.sents.length && !finished ? '▶ Resume' : '▶ Start';
  $('prog').style.width = S.sents.length ? `${(Math.min(S.i, S.sents.length) / S.sents.length) * 100}%` : '0';
  $('count').textContent = S.sents.length ? `Sentence ${Math.min(S.i + 1, S.sents.length)} of ${S.sents.length}` : '';
}

function render() {
  $('def').hidden = true;
  const done = S.sents.length && S.i >= S.sents.length;
  $('cur').className = 'sentence' + (S.sents.length ? '' : ' empty');
  if (done) $('cur').textContent = 'You finished the text. Great work!';
  else if (S.sents.length) showSentence(S.sents[S.i]);
  else $('cur').textContent = 'Open an article, then press Start.';
  ui();
  if (S.i < S.sents.length) toTab({ type: 'highlight', i: S.i });
}

function touch() {
  S.last = Date.now(); S.warned = false;
  stopAlarm();
  toTab({ type: 'warn', on: false });
}

function listen() {
  if (!S.running) return;
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  S.heard = ''; S.cnt = 0;
  const r = (S.rec = new R());
  r.continuous = true; r.interimResults = true; r.lang = $('lang').value || navigator.language;
  r.onresult = (e) => {
    const heard = (S.heard = [...e.results].map((x) => x[0].transcript).join(' '));
    markHeard(heard);
    for (; S.cnt < e.results.length && e.results[S.cnt].isFinal; S.cnt++) attempt(e.results[S.cnt][0].transcript);
    const p = progress(S.sents[S.i], heard);
    if (p > S.prog) { S.prog = p; touch(); } // other audio (e.g. a video) never resets the timer
    if (match(S.sents[S.i], heard)) {
      const missed = unheard(S.sents[S.i], heard);
      if (missed) S.fails[missed] = (S.fails[missed] || 0) + 1;
      S.i++; S.prog = 0; touch();
      render();
      if (S.i >= S.sents.length) return pause('Finished');
      r.abort(); // clean transcript for the next sentence; onend restarts
    }
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      pause('Mic blocked — grant access in the tab that just opened, then press Start.');
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    }
  };
  r.onend = () => { if (S.running && S.rec === r) setTimeout(listen, 300); };
  r.start();
}

function pause(msg) {
  S.running = false;
  stopAlarm();
  S.rec?.abort();
  toTab({ type: 'warn', on: false });
  status(msg || '');
  ui();
}

async function start() {
  if (S.running) return;
  audio().resume(); // unlock sound while we have a user click
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  S.tabId = tab.id;
  if (!S.sents.length) {
    const cap = await chrome.tabs.sendMessage(tab.id, { type: 'capture' }).catch(() => null);
    S.sents = cap?.sents || [];
    S.i = cap?.start || 0; // first sentence on screen
    if (!S.sents.length) return status('No readable text found. Reload the page and try again.');
  }
  run();
}

function run() {
  S.running = true; S.prog = 0; touch();
  status('');
  render(); listen();
}

function reset() {
  pause();
  toTab({ type: 'clear' });
  S.sents = []; S.i = 0; S.shown.clear(); S.fails = {};
  render();
}

function meter(idle) {
  const redir = +$('redir').value || 18, warn = +$('warn').value || 8;
  $('meter').style.width = `${Math.min(idle / redir, 1) * 100}%`;
  $('meter').parentElement.className = 'meter' + (idle >= redir * 0.8 ? ' bad' : idle >= warn ? ' warn' : '');
  $('tickWarn').style.left = `${(warn / redir) * 100}%`;
  $('idle').textContent = S.running ? `${Math.floor(idle)}s of silence` : '—';
}

setInterval(() => {
  const idle = S.running ? (Date.now() - S.last) / 1000 : 0;
  meter(idle);
  if (!S.running) return;
  if (idle >= +$('redir').value) {
    startAlarm();
  } else if (idle >= +$('warn').value) {
    if (!S.warned) { S.warned = true; beep(); toTab({ type: 'warn', on: true }); }
  }
}, 250);

// settings persistence
const KEYS = ['tries', 'warn', 'redir', 'lang'];
chrome.storage.local.get(KEYS).then((v) => KEYS.forEach((k) => v[k] && ($(k).value = v[k])));
KEYS.forEach((k) => $(k).addEventListener('change', () => chrome.storage.local.set({ [k]: $(k).value })));

$('toggle').onclick = () => (S.running ? pause() : start());
render();
$('reset').onclick = reset;
$('pick').onclick = async () => {
  pause();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  S.tabId = tab.id;
  S.shown.clear();
  status('Click the page where you want to start…');
  toTab({ type: 'pick' });
};
chrome.runtime.onMessage.addListener((m, sender) => {
  if (sender.tab?.id !== S.tabId) return;
  if (m.type === 'picked') { S.sents = m.sents; S.i = m.i; run(); }
});

// tap any word in the sentence to look it up
$('cur').addEventListener('click', (e) => e.target.dataset?.n && define(e.target.dataset.n));
