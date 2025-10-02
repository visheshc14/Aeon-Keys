// static/web/main.js
// Initializes the UI even if the WASM file is missing or mis-served.
// Falls back to a no-op synth so knobs rotate/update. When WASM loads, sound works.

const BUFFER_SIZE = 1024;

// ---------- tiny no-op synth (UI-safe fallback)
const noopSynth = {
  render_audio: (n) => new Float32Array(n),
  set_parameter: () => {},
  set_wavetable: () => {},
  note_on: () => {},
  note_off: () => {},
  export_preset: () => "{}",
  import_preset: () => true,
};

let audioCtx = null;
let synth = noopSynth;
let scriptNode = null;
let analyserNode = null;
let fxNodes = null;
let isAudioInitialized = false;

let initWasm = null;
let SynthesizerCtor = null;

// ---------- small dom helpers
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------- status UI
const statusTextEl = $("#status-text");
const audioDotEl   = $("#audio-status");
const wasmStatusEl = $("#wasm-status");

function setAudioInitializing() {
  if (statusTextEl) statusTextEl.textContent = "Initializing audio engine...";
  audioDotEl?.classList.remove("active");
}
function setAudioReady() {
  if (statusTextEl) statusTextEl.textContent = "Audio engine ready - play some notes!";
  audioDotEl?.classList.add("active");
}
function setWasmState(state, msg) {
  if (!wasmStatusEl) return;
  wasmStatusEl.textContent = `WebAssembly: ${msg}`;
  wasmStatusEl.classList.remove("ready","loading","error");
  wasmStatusEl.classList.add(state); // "ready" | "loading" | "error"
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- FX chain
function createEffectsChain(ctx) {
  const input = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1.0;
  const master = ctx.createGain(); master.gain.value = 0.9;

  // delay
  const delay = ctx.createDelay(5.0); delay.delayTime.value = 0.5;
  const fb = ctx.createGain(); fb.gain.value = 0.35;
  const delayWet = ctx.createGain(); delayWet.gain.value = 0.35;
  delay.connect(fb); fb.connect(delay);

  // reverb
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = makeIR(ctx, 2.5, 2.2);
  const reverbWet = ctx.createGain(); reverbWet.gain.value = 0.25;

  // analyser
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;

  // routing
  input.connect(dry); dry.connect(master);
  input.connect(delay); delay.connect(delayWet); delayWet.connect(master);
  input.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(master);
  master.connect(analyser);

  function toggleConn(on, a, b, wet, to) {
    try {
      if (on) { a.connect(b); b.connect(wet); wet.connect(to); }
      else { a.disconnect(b); b.disconnect(wet); wet.disconnect(to); }
    } catch {}
  }

  return {
    inputNode: input,
    masterNode: master,
    analyserNode: analyser,
    setDelayEnabled: (v) => toggleConn(!!v, input, delay, delayWet, master),
    setReverbEnabled: (v) => toggleConn(!!v, input, convolver, reverbWet, master),
    setDelayTime: (t) => { delay.delayTime.value = clamp(t, 0, 5.0); },
    setDelayFeedback: (v) => { fb.gain.value = clamp(v, 0, 0.98); },
    setDelayWet: (v) => { delayWet.gain.value = clamp(v, 0, 1.0); },
    setReverbWet: (v) => { reverbWet.gain.value = clamp(v, 0, 1.0); },
    setMasterGain: (v) => { master.gain.value = clamp(v, 0, 2.0); },
  };
}

function makeIR(ctx, dur = 2.0, decay = 2.0) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const n = len - i;
      const noise = (Math.random() * 2 - 1) * 0.5 + (Math.random() * 2 - 1) * 0.25;
      d[i] = noise * Math.pow(n / len, decay);
    }
  }
  return buf;
}

// ---------- WASM loader (RELATIVE paths & explicit .wasm url)
async function ensureWasmLoaded() {
  if (initWasm && SynthesizerCtor) return true;
  try {
    setWasmState("loading", "Loading...");
    // Adjust these two paths if your layout differs.
    // With HTML: <script type="module" src="web/main.js"></script>
    // this resolves to static/pkg/...
    const jsUrl   = new URL("../pkg/serum_wasm_backend.js", import.meta.url);
    const wasmUrl = new URL("../pkg/serum_wasm_backend_bg.wasm", import.meta.url);

    const mod = await import(jsUrl.href);
    initWasm = mod.default;
    SynthesizerCtor = mod.Synthesizer;

    // Pass explicit .wasm URL so bundlers/servers don’t guess incorrectly.
    await initWasm(wasmUrl.href);

    setWasmState("ready", "Loaded successfully");
    return true;
  } catch (e) {
    console.warn("WASM not available (UI will still work):", e);
    setWasmState("error", "Failed to load (UI active; no audio)");
    return false;
  }
}

export async function startSynth() {
  if (isAudioInitialized) return { audioCtx, analyserNode };

  // Try wasm, but don’t block the UI
  const wasmOk = await ensureWasmLoaded();

  setAudioInitializing();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  synth = (wasmOk && SynthesizerCtor) ? new SynthesizerCtor(audioCtx.sampleRate) : noopSynth;

  fxNodes = createEffectsChain(audioCtx);

  // connect script processor
  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
  scriptNode.onaudioprocess = (evt) => {
    const out = evt.outputBuffer.getChannelData(0);
    try { out.set(synth.render_audio(out.length)); }
    catch (err) { out.fill(0); }
  };

  scriptNode.connect(fxNodes.inputNode);
  analyserNode = fxNodes.analyserNode;
  analyserNode.connect(audioCtx.destination);

  audioCtx.onstatechange = () => {
    (audioCtx.state === "running") ? setAudioReady() : setAudioInitializing();
  };
  if (audioCtx.state === "running") setAudioReady();

  isAudioInitialized = true;
  return { audioCtx, analyserNode };
}

// ---------- UI (always attach)
window.addEventListener("DOMContentLoaded", async () => {
  wireWaveformButtons();
  wireLfoButtons();
  wireFilterButtons();
  wireKnobs();
  wireToggles();
  wireModMatrix();
  wireKeyboard();
  setupQwertyKeys();        // NEW: computer keyboard input
  wirePresets();
  setupWavetableEditor();
  setupSpectrum();

  try { await startSynth(); } catch {}
});

// ---------- Controls
function wireWaveformButtons() {
  $$('.waveform-button[data-waveform]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const parent = btn.closest('.waveform-display');
      parent?.querySelectorAll('.waveform-button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');

      const osc = parseInt(btn.getAttribute('data-osc')||'0',10);
      const wf = (btn.getAttribute('data-waveform')||'sine').toLowerCase();
      const map = { sine:0, saw:1, square:2, triangle:3, noise:4, wavetable:5 };
      const idx = map[wf] ?? 0;
      try { synth.set_parameter?.(`osc${osc}_waveform`, idx); } catch {}
    });
  });
}

function wireLfoButtons() {
  $$('.lfo-waveform-button[data-lfo-waveform]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const parent = btn.closest('.lfo-waveform-display') || btn.parentElement;
      parent?.querySelectorAll('.lfo-waveform-button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const wf = (btn.getAttribute('data-lfo-waveform')||'sine').toLowerCase();
      const map = { sine:0, triangle:1, saw:2, square:3, random:4 };
      const idx = map[wf] ?? 0;
      try { synth.set_parameter?.('lfo0_waveform', idx); } catch {}
    });
  });

  // Your current LFO section uses generic .waveform-button without data attributes.
  const lfoButtons = document.querySelectorAll('.lfo-section .waveform-button');
  lfoButtons.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      lfoButtons.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function wireFilterButtons() {
  $$('[data-filter]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const parent = btn.closest('.waveform-display') || btn.parentElement;
      parent?.querySelectorAll('[data-filter]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      // Map to engine param here if supported: synth.set_parameter('filter_type', id)
    });
  });
}

function wireKnobs() {
  $$('.knob-control').forEach(knob => {
    // Optional: smoother rotation
    knob.style.transformOrigin = "50% 50%";

    const axis = (knob.getAttribute('data-axis') || 'both').toLowerCase();
    const uiMin = parseFloat(knob.getAttribute('data-min') ?? '0');
    const uiMax = parseFloat(knob.getAttribute('data-max') ?? '1');

    let dragging = false;
    let startX = 0, startY = 0;
    let startNorm = 0; // [0..1]
    let norm = 0.5;    // [0..1]
    let currentRot = -135 + norm * 270;

    const clamp01 = v => Math.max(0, Math.min(1, v));
    const rotFromNorm = n => -135 + n * 270;

    const valueDisplay = knob.closest('.knob')?.querySelector('.knob-value');
    const param = knob.getAttribute('data-param');
    const oscIdxAttr = knob.getAttribute('data-osc');
    const hasOsc = oscIdxAttr !== null && oscIdxAttr !== '';
    const oi = hasOsc ? parseInt(oscIdxAttr, 10) : 0;

    const defaultNorm = (() => {
      const attr = knob.getAttribute('data-default');
      if (attr !== null) return clamp01(parseFloat(attr));
      if (param === 'detune') return 0.5;
      if (param === 'volume' || param === 'gain' || param === 'sustain') return 0.7;
      if (param === 'cutoff') return 0.6;
      if (param === 'resonance') return 0.15;
      if (param === 'attack' || param === 'decay' || param === 'release') return 0.05;
      if (param === 'lfoRate') return 0.25;
      if (param === 'lfoAmount') return 0.0;
      if (param === 'delayTime') return 0.25;
      if (param === 'delayFeedback') return 0.2;
      if (param === 'reverbAmount') return 0.35;
      return 0.5;
    })();

    function setVisual() { knob.style.transform = `rotate(${currentRot}deg)`; }

    function applyParam(abs) {
      if (!param) return;
      const show = (txt) => { if (valueDisplay) valueDisplay.textContent = txt; };

      if (hasOsc) {
        if (param === 'detune') {
          const cents = abs * 100 - 50;
          show(cents >= 0 ? `+${cents.toFixed(1)}` : cents.toFixed(1));
          try { synth.set_parameter?.(`osc${oi}_detune`, cents); } catch {}
        } else if (param === 'volume' || param === 'gain') {
          show(abs.toFixed(2));
          try { synth.set_parameter?.(`osc${oi}_gain`, abs); } catch {}
        }
        return;
      }

      if (param === 'cutoff') {
        const hz = Math.exp(Math.log(20) + abs * (Math.log(20000) - Math.log(20)));
        show(`${Math.round(hz)} Hz`);
        try { synth.set_parameter?.('filter_cutoff', hz); } catch {}
      } else if (param === 'resonance') {
        show(abs.toFixed(2));
        try { synth.set_parameter?.('filter_resonance', abs); } catch {}
      } else if (param === 'attack') {
        const s = abs * 2.0; show(`${Math.round(s * 1000)}ms`);
        try { synth.set_parameter?.('env_attack', s); } catch {}
      } else if (param === 'decay') {
        const s = abs * 2.0; show(`${Math.round(s * 1000)}ms`);
        try { synth.set_parameter?.('env_decay', s); } catch {}
      } else if (param === 'sustain') {
        show(abs.toFixed(2));
        try { synth.set_parameter?.('env_sustain', abs); } catch {}
      } else if (param === 'release') {
        const s = abs * 2.0; show(`${Math.round(s * 1000)}ms`);
        try { synth.set_parameter?.('env_release', s); } catch {}
      } else if (param === 'lfoRate') {
        const hz = abs * 10.0; show(`${hz.toFixed(2)} Hz`);
        try { synth.set_parameter?.('lfo0_rate', hz); } catch {}
      } else if (param === 'lfoAmount') {
        show(abs.toFixed(2));
        try { synth.set_parameter?.('lfo0_amount', abs); } catch {}
      } else if (param === 'delayTime') {
        const t = abs * 2.0; show(abs.toFixed(2));
        try { fxNodes?.setDelayTime(t); synth.set_parameter?.('fx_delay_time', t); } catch {}
      } else if (param === 'delayFeedback') {
        show(abs.toFixed(2));
        try { fxNodes?.setDelayFeedback(abs); synth.set_parameter?.('fx_delay_feedback', abs); } catch {}
      } else if (param === 'reverbAmount') {
        show(abs.toFixed(2));
        try { fxNodes?.setReverbWet(abs); synth.set_parameter?.('fx_reverb_wet', abs); } catch {}
      }
    }

    function setNorm(n) {
      const clamped = clamp01(n);
      const abs = clamp01((clamped - uiMin) / (uiMax - uiMin));
      norm = clamped;
      currentRot = rotFromNorm(abs);
      setVisual();
      applyParam(abs);
    }

    // init
    setNorm(defaultNorm);

    knob.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startNorm = norm;
      knob.setPointerCapture(e.pointerId);
      knob.style.cursor = 'grabbing';
    });
    knob.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = (e.clientX - startX);
      const dy = (startY - e.clientY);
      const base = e.shiftKey ? 0.002 : 0.01; // fine adjust with Shift
      let delta;
      if (axis === 'x') delta = dx * base;
      else if (axis === 'y') delta = dy * base;
      else delta = (Math.abs(dx) >= Math.abs(dy) ? dx : dy) * base;
      setNorm(startNorm + delta);
    });
    knob.addEventListener('pointerup', (e) => {
      dragging = false;
      knob.releasePointerCapture?.(e.pointerId);
      knob.style.cursor = 'grab';
    });
    knob.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.altKey ? 0.002 : (e.shiftKey ? 0.01 : 0.03);
      const dir = e.deltaY < 0 ? 1 : -1;
      setNorm(norm + dir * step);
    }, { passive: false });
    knob.addEventListener('dblclick', () => setNorm(defaultNorm));
  });
}

function wireToggles() {
  $$('.toggle-switch input').forEach(t=>{
    t.addEventListener('change', function(){
      const param = this.getAttribute('data-param');
      const oscIdx = this.getAttribute('data-osc');
      if (oscIdx !== null && oscIdx !== "") {
        const oi = parseInt(oscIdx,10);
        try { synth.set_parameter?.(`osc${oi}_${param}`, this.checked ? 1.0 : 0.0); } catch {}
      } else {
        if (param === 'reverbEnabled') fxNodes?.setReverbEnabled(this.checked);
        if (param === 'delayEnabled')  fxNodes?.setDelayEnabled(this.checked);
        if (param === 'filterEnv')     try { synth.set_parameter?.('filter_env', this.checked ? 1.0 : 0.0); } catch {}
        if (param === 'lfoRetrigger')  try { synth.set_parameter?.('lfo0_retrigger', this.checked ? 1.0 : 0.0); } catch {}
      }
    });
  });
}

function wireModMatrix() {
  $$('.modulation-matrix input[type="range"]').forEach(r=>{
    r.addEventListener('input', ()=>{
      const tr = r.closest('tr'); if(!tr) return;
      const src = tr.children[0]?.textContent?.trim().toLowerCase() || '';
      const ths = Array.from(document.querySelectorAll('.modulation-matrix thead th')).map(th=>th.textContent.trim());
      const td = r.closest('td'); const idx = Array.prototype.indexOf.call(td.parentElement.children, td);
      const tgt = (ths[idx] || '').toLowerCase();
      const v = parseFloat(r.value);
      try {
        if (src.includes('lfo 1') && tgt.includes('filter')) synth.set_parameter?.('mod_lfo0_to_cutoff', v);
        if (src.includes('lfo 2') && tgt.includes('filter')) synth.set_parameter?.('mod_lfo1_to_cutoff', v);
        if (src.includes('env 1') && tgt.includes('filter')) synth.set_parameter?.('mod_env_to_cutoff', v);
      } catch {}
    });
  });
}

function wireKeyboard() {
  $$('.key').forEach(key=>{
    key.addEventListener('mousedown', function(){
      this.classList.add('active');
      const n = parseInt(this.getAttribute('data-note'));
      try { synth.note_on?.(n, 1.0); } catch {}
    });
    key.addEventListener('mouseup', function(){
      this.classList.remove('active');
      const n = parseInt(this.getAttribute('data-note'));
      try { synth.note_off?.(n); } catch {}
    });
    key.addEventListener('mouseleave', function(){
      if (this.classList.contains('active')) {
        this.classList.remove('active');
        const n = parseInt(this.getAttribute('data-note'));
        try { synth.note_off?.(n); } catch {}
      }
    });
  });
}

function wirePresets() {
  const presetSelect = document.querySelector('.preset-manager select');
  const [saveBtn, loadBtn] = Array.from(document.querySelectorAll('.preset-manager button') || []);

  const refreshList = ()=>{
    if (!presetSelect) return;
    const keys = Object.keys(localStorage).filter(k=>k.startsWith('preset_'));
    presetSelect.innerHTML = '';
    keys.map(k=>k.replace(/^preset_/,'')).forEach(name=>{
      const o=document.createElement('option'); o.value=name; o.textContent=name; presetSelect.appendChild(o);
    });
  };
  refreshList();

  saveBtn?.addEventListener('click', ()=>{
    const name = prompt('Preset name:'); if(!name) return;
    const json = synth.export_preset?.();
    const str = (typeof json==='string') ? json : json?.toString?.() ?? '{}';
    localStorage.setItem(`preset_${name}`, str);
    refreshList();
    alert(`Saved: ${name}`);
  });

  loadBtn?.addEventListener('click', ()=>{
    const name = presetSelect?.value; if(!name) return alert('Pick a preset');
    const raw = localStorage.getItem(`preset_${name}`); if(!raw) return alert('Empty preset');
    const ok = synth.import_preset?.(raw);
    alert(ok? `Loaded: ${name}` : 'Import failed');
  });
}

// ---------- Wavetable editor (osc0)
function setupWavetableEditor(){
  const canvas = document.querySelector('.wavetable-canvas'); if(!canvas) return;

  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.scale(dpr, dpr);

  const width = cssW, height = cssH;

  const N = 2048;
  let table = new Float32Array(N);
  for(let i=0;i<N;i++) table[i]=2*(i/N)-1; // saw

  // small panel
  const panel = document.createElement('div');
  panel.className = 'wt-editor-panel';
  panel.style.display='flex'; panel.style.gap='8px'; panel.style.marginTop='8px'; panel.style.flexWrap='wrap';
  const freeBtn = mkBtn('Freehand', true);
  const addBtn  = mkBtn('Additive');
  const normBtn = mkBtn('Normalize');
  const clrBtn  = mkBtn('Clear');
  const saveBtn = mkBtn('Save Slot');
  const loadSel = document.createElement('select'); loadSel.innerHTML='<option value="">--Load Slot--</option>';
  panel.append(freeBtn, addBtn, normBtn, clrBtn, saveBtn, loadSel);
  canvas.parentElement.insertBefore(panel, canvas.nextSibling);

  const preview = document.createElement('canvas');
  preview.width=300; preview.height=80; preview.style.border='1px solid #222';
  panel.appendChild(preview);
  const pctx = preview.getContext('2d');

  let mode='freehand';
  const harmonicPanel=document.createElement('div'); harmonicPanel.style.display='none'; harmonicPanel.style.marginTop='8px'; harmonicPanel.style.width='100%';
  canvas.parentElement.insertBefore(harmonicPanel, panel.nextSibling);

  freeBtn.onclick=()=>{ mode='freehand'; freeBtn.disabled=true; addBtn.disabled=false; harmonicPanel.style.display='none'; };
  addBtn.onclick =()=>{ mode='additive'; freeBtn.disabled=false; addBtn.disabled=true; harmonicPanel.style.display='block'; };

  normBtn.onclick=()=>{ let m=0; for(let i=0;i<N;i++) m=Math.max(m,Math.abs(table[i])); if(m>0) for(let i=0;i<N;i++) table[i]/=m; render(); push(); };
  clrBtn.onclick =()=>{ table = new Float32Array(N); render(); push(); };
  saveBtn.onclick=()=>{ const slot = prompt('Slot 0-9:'); if(slot==null) return; const i=Math.max(0,Math.min(9,parseInt(slot))); localStorage.setItem(`wavetable_slot_${i}`, JSON.stringify(Array.from(table))); refreshSlots(); alert('Saved'); };
  function refreshSlots(){ loadSel.innerHTML='<option value="">--Load Slot--</option>'; for(let i=0;i<10;i++){ const raw=localStorage.getItem(`wavetable_slot_${i}`); const o=document.createElement('option'); o.value=String(i); o.textContent=raw?`Slot ${i} (saved)`:`Slot ${i}`; loadSel.appendChild(o);} }
  refreshSlots();
  loadSel.onchange=()=>{ const v=loadSel.value; if(v==='')return; const raw=localStorage.getItem(`wavetable_slot_${v}`); if(!raw) return alert('Empty'); table=Float32Array.from(JSON.parse(raw)); render(); push(); };

  // harmonics
  const H=32; const row=document.createElement('div'); row.style.display='flex'; row.style.flexWrap='wrap'; row.style.gap='6px';
  harmonicPanel.appendChild(row);
  const harmonics=new Float32Array(H); harmonics[0]=1.0;
  for(let i=0;i<H;i++){
    const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.flexDirection='column'; wrap.style.alignItems='center';
    const s=document.createElement('input'); s.type='range'; s.min='0'; s.max='1'; s.step='0.01'; s.value= i===0? '1.0':'0.0'; s.style.width='60px';
    const l=document.createElement('div'); l.style.fontSize='10px'; l.textContent=String(i+1);
    wrap.append(s,l); row.appendChild(wrap);
    s.oninput=()=>{ harmonics[i]=parseFloat(s.value); table = tableFromHarmonics(harmonics, N); render(); push(); };
  }
  const resetH = mkBtn('Reset Harmonics');
  resetH.onclick=()=>{ row.querySelectorAll('input').forEach((s,idx)=>s.value= idx===0?'1.0':'0.0'); harmonics.fill(0); harmonics[0]=1; table=tableFromHarmonics(harmonics,N); render(); push(); };
  harmonicPanel.appendChild(resetH);

  // freehand draw
  let drawing=false, pts=[];
  canvas.style.touchAction='none';
  canvas.addEventListener('pointerdown',e=>{
    drawing=true; pts=[];
    const r=canvas.getBoundingClientRect();
    pts.push({x:(e.clientX-r.left), y:(e.clientY-r.top)});
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drawing) return;
    const r=canvas.getBoundingClientRect();
    const x=Math.max(0,Math.min(width-1, e.clientX-r.left));
    const y=Math.max(0,Math.min(height-1, e.clientY-r.top));
    pts.push({x,y});
    // incremental stroke
    ctx.strokeStyle='#0f0'; ctx.lineWidth=2; ctx.beginPath();
    const p0=pts[pts.length-2]||pts[0];
    ctx.moveTo(p0.x,p0.y); ctx.lineTo(x,y); ctx.stroke();
  });
  canvas.addEventListener('pointerup',()=>{
    if(!drawing) return;
    drawing=false;
    if (mode==='freehand'){ table = tableFromFreehand(pts, width, height, N); render(); push(); }
  });

  function render(){
    ctx.clearRect(0,0,width,height);
    // grid
    ctx.strokeStyle='#111'; ctx.lineWidth=1; for(let i=0;i<4;i++){ ctx.beginPath(); ctx.moveTo(0,i*(height/3)); ctx.lineTo(width,i*(height/3)); ctx.stroke(); }
    // waveform
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath();
    for(let x=0;x<width;x++){
      const idx=Math.floor((x/width)*N); const v=table[idx];
      const y=(1- (v+1)/2) * height;
      if (x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  function push(){
    try {
      synth.set_wavetable?.(0, new Float32Array(table));
      synth.set_parameter?.('osc0_waveform', 5); // wavetable
      drawFFTPreview(table, pctx, preview.width, preview.height);
    } catch (e) { /* ignore UI-only mode */ }
  }

  function mkBtn(text, disabled=false){ const b=document.createElement('button'); b.textContent=text; b.disabled=disabled; return b; }

  function tableFromHarmonics(h, size){
    const o=new Float32Array(size);
    for(let n=1;n<=h.length;n++){
      const a=h[n-1]; if(Math.abs(a)<1e-6) continue;
      for(let i=0;i<size;i++){
        const ph=(i/size)*2*Math.PI;
        o[i]+= a*Math.sin(n*ph);
      }
    }
    let m=0; for(let i=0;i<size;i++) m=Math.max(m,Math.abs(o[i]));
    if(m>0) for(let i=0;i<size;i++) o[i]/=m;
    return o;
  }

  function tableFromFreehand(points, w, h, size){
    const s=new Float32Array(w), c=new Uint16Array(w);
    for(const p of points){
      const x=Math.max(0,Math.min(w-1, Math.round(p.x)));
      const v=1-(p.y/h);
      const val=v*2-1;
      s[x]+=val; c[x]+=1;
    }
    for(let x=0;x<w;x++) s[x]= c[x]? s[x]/c[x] : 0.0;
    // fill gaps
    let last=s[0];
    for(let x=0;x<w;x++){
      if(c[x]===0){
        let nx=x+1; while(nx<w && c[nx]===0) nx++;
        const nv = (nx<w)? s[nx] : last;
        const span = nx-x+1;
        for(let k=0;k<(nx-x);k++) s[x+k] = last + (nv-last)*((k+1)/span);
        x=nx; last=nv;
      } else last=s[x];
    }
    // resample
    const out=new Float32Array(size);
    for(let i=0;i<size;i++){
      const idx=(i/size)*w;
      const i0=Math.floor(idx), i1=Math.min(w-1,i0+1);
      const frac=idx-i0;
      out[i]= s[i0]*(1-frac)+s[i1]*frac;
    }
    return out;
  }

  function drawFFTPreview(arr, pctx, w, h){
    const N=256, mags=new Float32Array(N);
    const stride = Math.max(1, Math.floor(arr.length / (N*2)));
    for(let k=0;k<N;k++){
      let re=0,im=0;
      for(let n=0;n<arr.length;n+=stride){
        const ph=2*Math.PI*k*n/arr.length;
        re+=arr[n]*Math.cos(ph);
        im-=arr[n]*Math.sin(ph);
      }
      mags[k]=Math.hypot(re,im);
    }
    let m=0; for(let i=0;i<N;i++) m=Math.max(m,mags[i]);
    pctx.clearRect(0,0,w,h);
    pctx.fillStyle='#111'; pctx.fillRect(0,0,w,h);
    if(m===0) return;
    const bw = w/N;
    pctx.fillStyle='#0f0';
    for(let i=0;i<N;i++){
      const v=mags[i]/m;
      const bar=v*h;
      pctx.fillRect(i*bw, h-bar, Math.max(1, bw-1), bar);
    }
  }

  render(); push();
}

// ---------- Spectrum
function setupSpectrum(){
  const specCanvas = document.querySelector('.spectrum-canvas');
  if (!specCanvas) return;
  const ctx = specCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = specCanvas.clientWidth || specCanvas.width;
  const cssH = specCanvas.clientHeight || specCanvas.height;
  specCanvas.width = Math.floor(cssW * dpr);
  specCanvas.height = Math.floor(cssH * dpr);
  ctx.scale(dpr, dpr);

  const freqData = () => {
    if (!analyserNode) return null;
    const f = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(f);
    return f;
  };

  (function draw(){
    requestAnimationFrame(draw);
    const f = freqData();
    const w = cssW, h = cssH;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h);
    if (!f) return;
    const bw = w / f.length;
    ctx.fillStyle = '#6af';
    for (let i=0;i<f.length;i++) {
      const v = f[i] / 255, bh = v * h;
      ctx.fillRect(i*bw, h-bh, Math.max(1, bw-1), bh);
    }
  })();
}

// ---------- QWERTY row → MIDI (Z/S/X/D/C/V/G/B/H/N/J/M/,)
function setupQwertyKeys() {
  // Map to C4..C5 (matches your on-screen keys)
  const KEY2NOTE = {
    'z':60, 's':61, 'x':62, 'd':63, 'c':64, 'v':65, 'g':66,
    'b':67, 'h':68, 'n':69, 'j':70, 'm':71, ',':72
  };
  const pressed = new Set();

  function press(note) {
    pressed.add(note);
    try { synth.note_on?.(note, 1.0); } catch {}
    const el = document.querySelector(`.key[data-note="${note}"]`);
    el?.classList.add('active');
  }
  function release(note) {
    if (!pressed.has(note)) return;
    pressed.delete(note);
    try { synth.note_off?.(note); } catch {}
    const el = document.querySelector(`.key[data-note="${note}"]`);
    el?.classList.remove('active');
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k in KEY2NOTE) { e.preventDefault(); press(KEY2NOTE[k]); }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k in KEY2NOTE) { e.preventDefault(); release(KEY2NOTE[k]); }
  });
}

// ---------- auto-start audio on first gesture
document.addEventListener("pointerdown", async function firstTouch() {
  try { if (!isAudioInitialized) await startSynth(); } catch {}
  try { if (audioCtx && audioCtx.state !== "running") await audioCtx.resume(); } catch {}
  if (audioCtx && audioCtx.state === "running") setAudioReady();
  document.removeEventListener("pointerdown", firstTouch);
}, { once: true });