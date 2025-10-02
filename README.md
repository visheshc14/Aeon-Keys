#  Aeon Keys - Serum-Like Web Synth (Rust + WebAssembly + Web Audio API)

A browser-based **software synthesizer** inspired by Xfer Serum, built using **Rust (compiled to WebAssembly)** and the **Web Audio API**.  
It provides a **modern synth UI** with **oscillators, filters, envelopes, LFOs, effects, modulation matrix, wavetable editor, presets, MIDI input, and spectrum analyzers** — all running **directly in your browser**.

<img width="624" height="1008" alt="Screenshot 2025-10-02 at 10 47 55 PM" src="https://github.com/user-attachments/assets/a3025138-615f-425c-970c-145abfb43ce1" />

---

##  Features

###  Oscillators
- Dual oscillator setup (OSC A / OSC B)
- Waveforms: **Sine, Saw, Square, Triangle, Noise, Wavetable**
- Per-oscillator **detune** and **gain**
- Wavetable loading with custom editor

###  Wavetable Editor
- **Freehand drawing** mode  
- **Additive synthesis** mode (harmonic sliders)  
- Normalize, Clear, Save & Load slots  
- Real-time **FFT preview**  

###  Filters & Envelopes
- **Filter types:** (Low-pass, HP, BP, etc. – extensible)  
- **Cutoff & Resonance knobs**  
- **ADSR Envelopes** (Attack, Decay, Sustain, Release)  
- Envelope modulation to filter cutoff  

###  LFOs
- Waveforms: Sine, Saw, Square, Triangle, Random  
- Adjustable **rate & depth**  
- Retrigger toggle  
- Routable via modulation matrix  

###  Modulation Matrix
- Route **LFOs / Envelopes** to filter cutoff  
- Extensible for more destinations  

###  Effects
- **Delay**: time, feedback, wet/dry  
- **Convolution Reverb**: IR-based space simulation  
- **Master Gain**  

###  MIDI Integration
- Full **WebMIDI support** (Chrome/Edge, Safari experimental)  
- Play with your **MIDI keyboard** in real-time  

###  Visualizers
- **Spectrum Analyzer** (real-time FFT)  
- **Wavetable waveform + frequency preview**  

###  Presets
- Save/load presets with **LocalStorage**  
- Quick recall of custom patches  
---

##  Getting Started

### 1. Build Rust → WASM
```bash
# Install wasm-pack if missing
cargo install wasm-pack

# Build the Rust synth backend
wasm-pack build --target web --out-dir ./static/pkg
```

### 2. Run a Local Dev Server 
```bash
# Using Python
cd static
python3 -m http.server 8000

# OR using Node
npx serve static
```
---




