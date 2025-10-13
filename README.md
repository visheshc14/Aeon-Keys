#  Aeon Keys - Serum-Like Web Synth (Rust + WebAssembly + Web Audio API)

A browser-based **Software Synthesizer** Inspired by Xfer Serum, Built using **Rust (Compiled to WebAssembly)** and the **Web Audio API**. 
It Provides a **Modern Synth UI** with **Oscillators, Filters, Envelopes, LFOs, Effects, Modulation Matrix, Wavetable Editor, Presets, MIDI Input, and Spectrum Analyzers** — All Running **Directly in Your Browser**.

<img width="637" height="1006" alt="Screenshot 2025-10-09 at 2 56 29 PM" src="https://github.com/user-attachments/assets/2c267efa-891a-4479-a0eb-4b334a9c8e39" />

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




