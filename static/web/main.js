

import initWasm, { Synthesizer } from "../pkg/serum_wasm_backend.js";

const BUFFER_SIZE = 1024;

let audioCtx = null;
let synth = null;
let scriptNode = null;
let analyserNode = null;
let fxNodes = null;
let isAudioInitialized = false;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Status UI (no markup changes) 
const statusTextEl = document.getElementById("status-text");
const audioDotEl   = document.getElementById("audio-status");
const wasmStatusEl = document.getElementById("wasm-status");

function setAudioInitializing() {
  statusTextEl && (statusTextEl.textContent = "Initializing audio engine...");
  audioDotEl && audioDotEl.classList.remove("active");
}
function setAudioReady() {
  statusTextEl && (statusTextEl.textContent = "Audio engine ready - play some notes!");
  audioDotEl && audioDotEl.classList.add("active");
}
function setWasmState(state, msg) {
  if (!wasmStatusEl) return;
  wasmStatusEl.textContent = `WebAssembly: ${msg}`;
  wasmStatusEl.classList.remove("ready", "loading", "error");
  wasmStatusEl.classList.add(state); // 'ready' | 'loading' | 'error'
}

// FX chain (delay + reverb + analyser + master) 
function createEffectsChain(ctx) {
  const input = ctx.createGain();
  const master = ctx.createGain();
  master.gain.value = 1.0;

  // Delay
  const delay = ctx.createDelay(5.0);
  delay.delayTime.value = 0.5;
  const fb = ctx.createGain(); fb.gain.value = 0.35;
  const delayWet = ctx.createGain(); delayWet.gain.value = 0.35;
  delay.connect(fb); fb.connect(delay);

  // Convolver reverb
  const convolver = ctx.createConvolver();
  convolver.buffer = makeIR(ctx, 2.0, 2.0);
  const reverbWet = ctx.createGain(); reverbWet.gain.value = 0.25;

  // Analyser
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  // Routing
  input.connect(master);                     // dry
  input.connect(delay); delay.connect(delayWet); delayWet.connect(master);
  input.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(master);
  master.connect(analyser);

  return {
    inputNode: input,
    masterNode: master,
    analyserNode: analyser,
    setDelayEnabled: (v) => toggleConn(v, input, delay, delayWet, master),
    setReverbEnabled: (v) => toggleConn(v, input, convolver, reverbWet, master),
    setDelayTime: (t) => { delay.delayTime.value = clamp(t, 0, 5.0); },
    setDelayFeedback: (v) => { fb.gain.value = clamp(v, 0, 0.99); },
    setDelayWet: (v) => { delayWet.gain.value = clamp(v, 0, 1.0); },
    setReverbWet: (v) => { reverbWet.gain.value = clamp(v, 0, 1.0); },
    setMasterGain: (v) => { master.gain.value = clamp(v, 0, 2.0); }
  };
}
function toggleConn(on, a, b, wet, master) {
  try { on ? (a.connect(b), b.connect(wet), wet.connect(master))
           : (a.disconnect(b), b.disconnect(wet), wet.disconnect(master)); } catch {}
}
function makeIR(ctx, dur = 2.0, decay = 2.0) {
  const sr = ctx.sampleRate, len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const n = len - i;
      d[i] = (Math.random() * 2 - 1) * Math.pow(n / len, decay);
    }
  }
  return buf;
}

//  Start synth (WASM + WebAudio) 
export async function startSynth() {
  if (isAudioInitialized) return { audioCtx, analyserNode };

  try {
    setWasmState("loading", "Loading...");
    await initWasm(); // loads wasm glue & module
    setWasmState("ready", "Loaded successfully");
  } catch (e) {
    console.error("WASM init failed:", e);
    setWasmState("error", `Failed to load - ${e?.message || e}`);
    throw e;
  }

  setAudioInitializing();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  synth = new Synthesizer(audioCtx.sampleRate);

  fxNodes = createEffectsChain(audioCtx);

  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 0, 1);
  scriptNode.onaudioprocess = (evt) => {
    const out = evt.outputBuffer.getChannelData(0);
    try { out.set(synth.render_audio(out.length)); }
    catch (err) { console.error("WASM render error:", err); out.fill(0); }
  };

  scriptNode.connect(fxNodes.inputNode);
  analyserNode = fxNodes.analyserNode;
  analyserNode.connect(audioCtx.destination);

  // reflect AudioContext state → header status
  audioCtx.onstatechange = () => {
    (audioCtx.state === "running") ? setAudioReady() : setAudioInitializing();
  };
  if (audioCtx.state === "running") setAudioReady();

  isAudioInitialized = true;
  return { audioCtx, analyserNode };
}

// Start on first user gesture (also resumes if suspended)
document.addEventListener("click", async function firstTouch() {
  try { if (!isAudioInitialized) await startSynth(); } catch {}
  try { if (audioCtx && audioCtx.state !== "running") await audioCtx.resume(); } catch {}
  if (audioCtx && audioCtx.state === "running") setAudioReady();
  document.removeEventListener("click", firstTouch);
}, { once: true });

// UI wiring 
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

window.addEventListener("DOMContentLoaded", async () => {
  try { await startSynth(); } catch {}

  // Waveform buttons
  $$('.waveform-button[data-waveform]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const parent = btn.closest('.waveform-display');
      parent?.querySelectorAll('.waveform-button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const osc = parseInt(btn.getAttribute('data-osc')||'0',10);
      const wf = btn.getAttribute('data-waveform');
      const map = { sine:0, saw:1, square:2, triangle:3, noise:4, wavetable:5 };
      synth?.set_parameter(`osc${osc}_waveform`, map[wf] ?? 0);
    });
  });

  // Filter type (UI highlight only; engine is lowpass)
  $$('[data-filter]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const parent = btn.closest('.waveform-display');
      parent?.querySelectorAll('[data-filter]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Knobs
  $$('.knob-control').forEach(knob=>{
    let drag=false, startY=0, startRot=0, rot=0;
    knob.addEventListener('pointerdown', e=>{ drag=true; startY=e.clientY; startRot=rot; knob.setPointerCapture(e.pointerId); knob.style.cursor='grabbing'; });
    knob.addEventListener('pointermove', e=>{
      if(!drag) return;
      const dy = startY - e.clientY;
      rot = Math.max(-135, Math.min(135, startRot + dy*0.5));
      knob.style.transform = `rotate(${rot}deg)`;
      const t = (rot+135)/270; // 0..1
      const label = knob.closest('.knob')?.querySelector('.knob-value');
      const param = knob.getAttribute('data-param');
      const oscIdx = knob.getAttribute('data-osc');

      if (oscIdx !== null && oscIdx !== undefined && oscIdx !== "") {
        const oi = parseInt(oscIdx,10);
        if (param === 'detune'){
          const cents = t*100 - 50;
          label && (label.textContent = cents>=0? `+${cents.toFixed(1)}`:cents.toFixed(1));
          synth?.set_parameter(`osc${oi}_detune`, cents);
        } else if (param === 'volume' || param === 'gain'){
          label && (label.textContent = t.toFixed(2));
          synth?.set_parameter(`osc${oi}_gain`, t);
        }
      } else {
        if (param === 'cutoff'){
          const hz = Math.exp(Math.log(20) + t*(Math.log(20000)-Math.log(20)));
          label && (label.textContent = `${Math.round(hz)} Hz`);
          synth?.set_parameter('filter_cutoff', hz);
        } else if (param === 'resonance'){
          label && (label.textContent = t.toFixed(2));
          synth?.set_parameter('filter_resonance', t);
        } else if (param === 'attack'){
          const s = t*2; label && (label.textContent = `${Math.round(s*1000)}ms`);
          synth?.set_parameter('env_attack', s);
        } else if (param === 'decay'){
          const s = t*2; label && (label.textContent = `${Math.round(s*1000)}ms`);
          synth?.set_parameter('env_decay', s);
        } else if (param === 'sustain'){
          label && (label.textContent = t.toFixed(2));
          synth?.set_parameter('env_sustain', t);
        } else if (param === 'release'){
          const s = t*2; label && (label.textContent = `${Math.round(s*1000)}ms`);
          synth?.set_parameter('env_release', s);
        } else if (param === 'lfoRate'){
          const hz = t*10; label && (label.textContent = `${hz.toFixed(2)} Hz`);
          synth?.set_parameter('lfo0_rate', hz);
        } else if (param === 'lfoAmount'){
          label && (label.textContent = t.toFixed(2));
          synth?.set_parameter('lfo0_amount', t);
        } else if (param === 'delayTime'){
          label && (label.textContent = t.toFixed(2));
          fxNodes?.setDelayTime(t*2.0);
          synth?.set_parameter('fx_delay_time', t*2.0);
        } else if (param === 'delayFeedback'){
          label && (label.textContent = t.toFixed(2));
          fxNodes?.setDelayFeedback(t);
          synth?.set_parameter('fx_delay_feedback', t);
        } else if (param === 'reverbAmount'){
          label && (label.textContent = t.toFixed(2));
          fxNodes?.setReverbWet(t);
          synth?.set_parameter('fx_reverb_wet', t);
        }
      }
    });
    knob.addEventListener('pointerup', e=>{ drag=false; knob.releasePointerCapture?.(e.pointerId); knob.style.cursor='grab'; });
  });

  // Toggles
  $$('.toggle-switch input').forEach(t=>{
    t.addEventListener('change', function(){
      const param = this.getAttribute('data-param');
      const oscIdx = this.getAttribute('data-osc');
      if (oscIdx !== null && oscIdx !== undefined && oscIdx !== "") {
        const oi = parseInt(oscIdx,10);
        synth?.set_parameter(`osc${oi}_${param}`, this.checked ? 1.0 : 0.0);
      } else {
        if (param === 'reverbEnabled') fxNodes?.setReverbEnabled(this.checked);
        if (param === 'delayEnabled')  fxNodes?.setDelayEnabled(this.checked);
        if (param === 'filterEnv')     synth?.set_parameter('filter_env', this.checked ? 1.0 : 0.0);
        if (param === 'lfoRetrigger')  synth?.set_parameter('lfo0_retrigger', this.checked ? 1.0 : 0.0);
      }
    });
  });

  // Mod matrix (filter routes)
  $$('.modulation-matrix input[type="range"]').forEach(r=>{
    r.addEventListener('input', ()=>{
      const tr = r.closest('tr'); if(!tr) return;
      const src = tr.children[0]?.textContent?.trim().toLowerCase() || '';
      const td = r.closest('td'); const row = td.parentElement;
      const ths = Array.from(document.querySelectorAll('.modulation-matrix thead th')).map(th=>th.textContent.trim());
      const idx = Array.prototype.indexOf.call(row.children, td);
      const tgt = ths[idx];
      const v = parseFloat(r.value);
      if (src.includes('lfo 1') && tgt.includes('Filter')) synth?.set_parameter('mod_lfo0_to_cutoff', v);
      if (src.includes('lfo 2') && tgt.includes('Filter')) synth?.set_parameter('mod_lfo1_to_cutoff', v);
      if (src.includes('env 1') && tgt.includes('Filter')) synth?.set_parameter('mod_env_to_cutoff', v);
    });
  });

  // Screen keyboard
  $$('.key').forEach(key=>{
    key.addEventListener('mousedown', function(){ this.classList.add('active'); const n=parseInt(this.getAttribute('data-note')); synth?.note_on(n, 1.0); });
    key.addEventListener('mouseup',   function(){ this.classList.remove('active'); const n=parseInt(this.getAttribute('data-note')); synth?.note_off(n); });
    key.addEventListener('mouseleave',function(){ if(this.classList.contains('active')){ this.classList.remove('active'); const n=parseInt(this.getAttribute('data-note')); synth?.note_off(n); }});
  });

  // Presets
  const presetSelect = document.querySelector('.preset-manager select');
  const [saveBtn, loadBtn] = Array.from(document.querySelectorAll('.preset-manager button'));
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
    const json = synth?.export_preset(); const str = (typeof json==='string')? json : json?.toString?.() ?? '{}';
    localStorage.setItem(`preset_${name}`, str); refreshList(); alert(`Saved: ${name}`);
  });
  loadBtn?.addEventListener('click', ()=>{
    const name = presetSelect?.value; if(!name) return alert('Pick a preset');
    const raw = localStorage.getItem(`preset_${name}`); if(!raw) return alert('Empty preset');
    const ok = synth?.import_preset(raw); alert(ok? `Loaded: ${name}`: 'Import failed');
  });

  // Wavetable editor → osc0
  setupWavetableEditor();

  // Spectrum analyzer
  const specCanvas = document.querySelector('.spectrum-canvas');
  if (specCanvas && analyserNode){
    const ctx = specCanvas.getContext('2d');
    const freq = new Uint8Array(analyserNode.frequencyBinCount);
    (function draw(){
      requestAnimationFrame(draw);
      analyserNode.getByteFrequencyData(freq);
      const w=specCanvas.width,h=specCanvas.height, bw=w/freq.length;
      ctx.fillStyle='#000'; ctx.fillRect(0,0,w,h);
      for(let i=0;i<freq.length;i++){
        const v=freq[i]/255, bh=v*h;
        ctx.fillStyle='#6af'; ctx.fillRect(i*bw, h-bh, bw-1, bh);
      }
    })();
  }
});

// --- Wavetable editor (inline) ---
function setupWavetableEditor(){
  const canvas = document.querySelector('.wavetable-canvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const N = 2048;
  let table = new Float32Array(N); for(let i=0;i<N;i++) table[i]=2*(i/N)-1; // default saw

  const panel = document.createElement('div');
  panel.style.display='flex'; panel.style.gap='8px'; panel.style.marginTop='8px'; panel.style.flexWrap='wrap';
  const freeBtn = btn('Freehand',true), addBtn = btn('Additive');
  const normBtn = btn('Normalize'), clrBtn = btn('Clear'), saveBtn=btn('Save Slot');
  const loadSel = document.createElement('select'); loadSel.innerHTML='<option value="">--Load Slot--</option>';
  panel.append(freeBtn, addBtn, normBtn, clrBtn, saveBtn, loadSel);
  canvas.parentElement.insertBefore(panel, canvas.nextSibling);

  const preview=document.createElement('canvas'); preview.width=300; preview.height=80; preview.style.border='1px solid #222';
  panel.appendChild(preview); const pctx=preview.getContext('2d');

  let mode='freehand';
  freeBtn.onclick=()=>{ mode='freehand'; freeBtn.disabled=true; addBtn.disabled=false; harmonicPanel.style.display='none'; };
  addBtn.onclick =()=>{ mode='additive'; freeBtn.disabled=false; addBtn.disabled=true; harmonicPanel.style.display='block'; };

  normBtn.onclick=()=>{ let m=0; for(let i=0;i<N;i++) m=Math.max(m,Math.abs(table[i])); if(m>0) for(let i=0;i<N;i++) table[i]/=m; render(); push(); };
  clrBtn.onclick =()=>{ table = new Float32Array(N); render(); push(); };
  saveBtn.onclick=()=>{ const slot = prompt('Slot 0-9:'); if(slot==null) return; const i=Math.max(0,Math.min(9,parseInt(slot))); localStorage.setItem(`wavetable_slot_${i}`, JSON.stringify(Array.from(table))); refreshSlots(); alert('Saved'); };
  function refreshSlots(){ loadSel.innerHTML='<option value="">--Load Slot--</option>'; for(let i=0;i<10;i++){ const raw=localStorage.getItem(`wavetable_slot_${i}`); const o=document.createElement('option'); o.value=String(i); o.textContent=raw?`Slot ${i} (saved)`:`Slot ${i}`; loadSel.appendChild(o);} }
  refreshSlots();
  loadSel.onchange=()=>{ const v=loadSel.value; if(v==='')return; const raw=localStorage.getItem(`wavetable_slot_${v}`); if(!raw) return alert('Empty'); table=Float32Array.from(JSON.parse(raw)); render(); push(); };

  const harmonicPanel=document.createElement('div'); harmonicPanel.style.display='none'; harmonicPanel.style.marginTop='8px'; canvas.parentElement.insertBefore(harmonicPanel, panel.nextSibling);
  const H=32; const row=document.createElement('div'); row.style.display='flex'; row.style.flexWrap='wrap'; row.style.gap='6px';
  harmonicPanel.appendChild(row);
  const harmonics=new Float32Array(H); harmonics[0]=1.0;
  for(let i=0;i<H;i++){ const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.flexDirection='column'; wrap.style.alignItems='center';
    const s=document.createElement('input'); s.type='range'; s.min='0'; s.max='1'; s.step='0.01'; s.value= i===0? '1.0':'0.0'; s.style.width='60px';
    const l=document.createElement('div'); l.style.fontSize='10px'; l.textContent=String(i+1);
    wrap.append(s,l); row.appendChild(wrap);
    s.oninput=()=>{ harmonics[i]=parseFloat(s.value); table = tableFromHarmonics(harmonics, N); render(); push(); };
  }
  const resetH = btn('Reset Harmonics'); resetH.onclick=()=>{ row.querySelectorAll('input').forEach((s,idx)=>s.value= idx===0?'1.0':'0.0'); harmonics.fill(0); harmonics[0]=1; table=tableFromHarmonics(harmonics,N); render(); push(); };
  harmonicPanel.appendChild(resetH);

  let drawing=false, pts=[];
  canvas.style.touchAction='none';
  canvas.addEventListener('pointerdown',e=>{ drawing=true; pts=[]; const r=canvas.getBoundingClientRect(); pts.push({x:e.clientX-r.left,y:e.clientY-r.top}); });
  canvas.addEventListener('pointermove',e=>{ if(!drawing) return; const r=canvas.getBoundingClientRect(); const x=Math.max(0,Math.min(canvas.width-1, e.clientX-r.left)); const y=Math.max(0,Math.min(canvas.height-1, e.clientY-r.top)); pts.push({x,y});
    ctx.strokeStyle='#0f0'; ctx.lineWidth=2; ctx.beginPath(); const p0=pts[pts.length-2]||pts[0]; ctx.moveTo(p0.x,p0.y); ctx.lineTo(x,y); ctx.stroke(); });
  canvas.addEventListener('pointerup',()=>{ if(!drawing) return; drawing=false; if(mode==='freehand'){ table = tableFromFreehand(pts, canvas, N); render(); push(); }});

  function render(){
    const w=canvas.width,h=canvas.height; ctx.clearRect(0,0,w,h);
    ctx.strokeStyle='#111'; ctx.lineWidth=1; for(let i=0;i<4;i++){ ctx.beginPath(); ctx.moveTo(0,i*(h/3)); ctx.lineTo(w,i*(h/3)); ctx.stroke(); }
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath();
    for(let x=0;x<w;x++){ const idx=Math.floor((x/w)*N); const v=table[idx]; const y=(1 - (v+1)/2) * h; x===0? ctx.moveTo(x,y) : ctx.lineTo(x,y); }
    ctx.stroke();
  }
  function push(){ try{ synth?.set_wavetable(0, new Float32Array(table)); synth?.set_parameter('osc0_waveform', 5); drawFFTPreview(table, pctx, preview.width, preview.height);}catch(e){console.error(e)} }
  function btn(text, disabled=false){ const b=document.createElement('button'); b.textContent=text; b.disabled=disabled; return b; }
  function tableFromHarmonics(h, size){
    const o=new Float32Array(size); for(let n=1;n<=h.length;n++){ const a=h[n-1]; if(Math.abs(a)<1e-6) continue; for(let i=0;i<size;i++){ const ph=(i/size)*2*Math.PI; o[i]+= a*Math.sin(n*ph); } }
    let m=0; for(let i=0;i<size;i++) m=Math.max(m,Math.abs(o[i])); if(m>0) for(let i=0;i<size;i++) o[i]/=m; return o;
  }
  function tableFromFreehand(points, cvs, size){
    const w=cvs.width, h=cvs.height; const s=new Float32Array(w), c=new Uint16Array(w);
    for(const p of points){ const x=Math.max(0,Math.min(w-1, Math.round(p.x))); const v=1-(p.y/h); const val=v*2-1; s[x]+=val; c[x]+=1; }
    for(let x=0;x<w;x++) s[x]= c[x]? s[x]/c[x] : 0.0;
    let last=s[0]; for(let x=0;x<w;x++){ if(c[x]===0){ let nx=x+1; while(nx<w&&c[nx]===0) nx++; const nv= nx<w? s[nx]: last; const span=nx-x+1; for(let k=0;k<(nx-x);k++) s[x+k]= last + (nv-last)*((k+1)/span); x=nx; last=nv; } else last=s[x]; }
    const out=new Float32Array(size); for(let i=0;i<size;i++){ const idx=(i/size)*w; const i0=Math.floor(idx), i1=Math.min(w-1,i0+1); const frac=idx-i0; out[i]= s[i0]*(1-frac)+s[i1]*frac; } return out;
  }
  function drawFFTPreview(arr, pctx, w, h){
    const N=256, mags=new Float32Array(N);
    for(let k=0;k<N;k++){ let re=0,im=0; for(let n=0;n<arr.length;n+=Math.floor(arr.length/N)){ const ph=2*Math.PI*k*n/arr.length; re+=arr[n]*Math.cos(ph); im-=arr[n]*Math.sin(ph); } mags[k]=Math.hypot(re,im); }
    let m=0; for(let i=0;i<N;i++) m=Math.max(m,mags[i]); pctx.clearRect(0,0,w,h); pctx.fillStyle='#111'; pctx.fillRect(0,0,w,h);
    if(m===0) return; for(let i=0;i<N;i++){ const v=mags[i]/m; const x=(i/N)*w; const bar=v*h; pctx.fillStyle='#0f0'; pctx.fillRect(x, h-bar, w/N-1, bar); }
  }
  (function init(){ render(); push(); })();
}