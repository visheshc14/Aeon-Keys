// src/lib.rs
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use js_sys::{Float32Array, Array, Object, JSON, JsString};
use std::f32::consts::PI;

const WAVETABLE_SIZE: usize = 2048;
const MAX_VOICES: usize = 64;

#[wasm_bindgen]
pub struct Synthesizer {
    sample_rate: f32,
    osc_settings: [OscSettings; 2],
    wavetables: [Vec<f32>; 2],
    voices: Vec<Voice>,
    env_defaults: ADSRParams,
    filter: StateVarFilter,
    lfos: [LFO; 2],
    mod_matrix: ModMatrix,
    delay: SimpleDelay,
    reverb: SimpleReverb,
    master_gain: f32,
    filter_env_enabled: bool,
    lfo0_retrigger: bool,
}

#[wasm_bindgen]
impl Synthesizer {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Synthesizer {
        set_panic_hook();

        // default sine table
        let mut default = vec![0.0f32; WAVETABLE_SIZE];
        for i in 0..WAVETABLE_SIZE {
            default[i] = (2.0 * PI * (i as f32) / WAVETABLE_SIZE as f32).sin();
        }

        Synthesizer {
            sample_rate,
            osc_settings: [OscSettings::default(), OscSettings::default()],
            wavetables: [default.clone(), default],
            voices: Vec::with_capacity(MAX_VOICES),
            env_defaults: ADSRParams::default(),
            filter: StateVarFilter::new(1200.0, 0.6, sample_rate),
            lfos: [LFO::default(), LFO::default()],
            mod_matrix: ModMatrix::default(),
            delay: SimpleDelay::new(sample_rate, 0.3, 0.35),
            reverb: SimpleReverb::new(sample_rate),
            master_gain: 0.9,
            filter_env_enabled: true,
            lfo0_retrigger: false,
        }
    }

    // ---------- notes ----------
    #[wasm_bindgen]
    pub fn note_on(&mut self, midi_note: u8, velocity: f32) {
        let freq = midi_to_freq(midi_note);
        if self.voices.len() >= MAX_VOICES {
            self.voices.remove(0);
        }
        let mut v = Voice::new(midi_note, freq, velocity, &self.env_defaults);
        v.phase0 = rand_phase();
        v.phase1 = rand_phase();
        if self.lfo0_retrigger {
            self.lfos[0].retrigger();
        }
        self.voices.push(v);
    }

    #[wasm_bindgen]
    pub fn note_off(&mut self, midi_note: u8) {
        for v in &mut self.voices {
            if v.midi_note == midi_note {
                v.env.note_off();
            }
        }
    }

    // ---------- params from JS ----------
    #[wasm_bindgen]
    pub fn set_parameter(&mut self, name: &str, value: f32) {
        match name {
            // osc
            "osc0_waveform" => self.osc_settings[0].waveform = Waveform::from_f32(value),
            "osc1_waveform" => self.osc_settings[1].waveform = Waveform::from_f32(value),
            "osc0_gain" | "osc0_volume" => self.osc_settings[0].gain = value,
            "osc1_gain" | "osc1_volume" => self.osc_settings[1].gain = value,
            "osc0_detune" => self.osc_settings[0].detune_cents = value,
            "osc1_detune" => self.osc_settings[1].detune_cents = value,
            "osc0_sync" | "osc1_sync" => { /* placeholder if you add sync later */ }

            // env
            "env_attack"  => self.env_defaults.attack  = value.max(0.0001),
            "env_decay"   => self.env_defaults.decay   = value.max(0.0001),
            "env_sustain" => self.env_defaults.sustain = value.clamp(0.0, 1.0),
            "env_release" => self.env_defaults.release = value.max(0.0001),

            // filter
            "filter_cutoff"    => self.filter.set_cutoff(value.max(20.0)),
            "filter_resonance" => { self.filter.resonance = value.max(0.0); self.filter.update_coeffs(); }
            "filter_env"       => self.filter_env_enabled = value > 0.5,

            // LFOs
            "lfo0_rate"     => self.lfos[0].rate = value.max(0.0),
            "lfo0_amount"   => self.lfos[0].amount = value,
            "lfo1_rate"     => self.lfos[1].rate = value.max(0.0),
            "lfo1_amount"   => self.lfos[1].amount = value,
            "lfo0_retrigger"=> self.lfo0_retrigger = value > 0.5,

            // FX
            "fx_delay_time"     => self.delay.set_time(value.max(0.0)),
            "fx_delay_feedback" => self.delay.feedback = value.clamp(0.0, 0.99),
            "fx_delay_wet"      => self.delay.wet = value.clamp(0.0, 1.0),
            "fx_reverb_wet"     => self.reverb.wet = value.clamp(0.0, 1.0),

            // master
            "master_gain" => self.master_gain = value,

            // mod matrix
            name if name.starts_with("mod_") => self.mod_matrix.set_by_name(name, value),

            _ => {}
        }
    }

    // ---------- wavetable API ----------
    #[wasm_bindgen]
    pub fn set_wavetable(&mut self, osc: usize, arr: &Float32Array) {
        if osc >= 2 {
            return;
        }
        let len = arr.length() as usize;
        if len == 0 {
            return;
        }
        let mut tmp = vec![0.0f32; len];
        arr.copy_to(&mut tmp);
        let mut out = vec![0.0f32; WAVETABLE_SIZE];
        for i in 0..WAVETABLE_SIZE {
            let x = (i as f32) / (WAVETABLE_SIZE as f32) * (len as f32);
            let i0 = x.floor() as usize % len;
            let i1 = (i0 + 1) % len;
            let frac = x - x.floor();
            out[i] = tmp[i0] * (1.0 - frac) + tmp[i1] * frac;
        }
        self.wavetables[osc] = out;
    }

    #[wasm_bindgen]
    pub fn get_wavetable(&self, osc: usize) -> Float32Array {
        if osc >= 2 {
            return Float32Array::new_with_length(WAVETABLE_SIZE as u32);
        }
        Float32Array::from(self.wavetables[osc].as_slice())
    }

    // ---------- preset I/O ----------
    #[wasm_bindgen]
    pub fn export_preset(&self) -> JsValue {
        let obj = Object::new();
        set(&obj, "master_gain", self.master_gain);
        for i in 0..2 {
            set(&obj, &format!("osc{}_waveform", i), self.osc_settings[i].waveform.to_index() as f32);
            set(&obj, &format!("osc{}_gain", i), self.osc_settings[i].gain);
            set(&obj, &format!("osc{}_detune", i), self.osc_settings[i].detune_cents);
        }
        set(&obj, "env_attack",  self.env_defaults.attack);
        set(&obj, "env_decay",   self.env_defaults.decay);
        set(&obj, "env_sustain", self.env_defaults.sustain);
        set(&obj, "env_release", self.env_defaults.release);
        set(&obj, "filter_cutoff", self.filter.base_cutoff);
        set(&obj, "filter_resonance", self.filter.resonance);
        set(&obj, "mod_lfo0_to_cutoff", self.mod_matrix.lfo0_to_cutoff);
        set(&obj, "mod_lfo1_to_cutoff", self.mod_matrix.lfo1_to_cutoff);
        set(&obj, "mod_env_to_cutoff",  self.mod_matrix.env_to_cutoff);

        // include first 256 samples of each wavetable
        let arrs = Array::new();
        for i in 0..2 {
            let slice = &self.wavetables[i][..256.min(self.wavetables[i].len())];
            arrs.push(&Float32Array::from(slice));
        }
        js_sys::Reflect::set(&obj, &"wavetables".into(), &arrs).ok();

        JSON::stringify(&obj)
            .unwrap_or_else(|_| JsString::from("{}"))
            .into()
    }

    #[wasm_bindgen]
    pub fn import_preset(&mut self, preset_json: &str) -> bool {
        if let Ok(val) = JSON::parse(preset_json) {
            if let Some(obj) = val.dyn_ref::<Object>() {
                get_into(obj, "master_gain").map(|v| self.master_gain = v);
                for i in 0..2 {
                    get_into(obj, &format!("osc{}_waveform", i)).map(|v| self.osc_settings[i].waveform = Waveform::from_f32(v));
                    get_into(obj, &format!("osc{}_gain", i)).map(|v| self.osc_settings[i].gain = v);
                    get_into(obj, &format!("osc{}_detune", i)).map(|v| self.osc_settings[i].detune_cents = v);
                }
                get_into(obj, "env_attack").map(|v| self.env_defaults.attack = v.max(0.0001));
                get_into(obj, "env_decay").map(|v| self.env_defaults.decay = v.max(0.0001));
                get_into(obj, "env_sustain").map(|v| self.env_defaults.sustain = v.clamp(0.0, 1.0));
                get_into(obj, "env_release").map(|v| self.env_defaults.release = v.max(0.0001));
                get_into(obj, "filter_cutoff").map(|v| self.filter.set_cutoff(v.max(20.0)));
                get_into(obj, "filter_resonance").map(|v| { self.filter.resonance = v.max(0.0); self.filter.update_coeffs(); });

                // wavetables optional
                if let Ok(wt) = js_sys::Reflect::get(obj, &"wavetables".into()) {
                    let arr = Array::from(&wt);
                    for i in 0..2 {
                        if let Some(fa) = arr.get(i as u32).dyn_ref::<Float32Array>() {
                            self.set_wavetable(i, fa);
                        }
                    }
                }
                return true;
            }
        }
        false
    }

    // ---------- main render ----------
    #[wasm_bindgen]
    pub fn render_audio(&mut self, frames: usize) -> Float32Array {
        let mut out = vec![0.0f32; frames];
        let dt = 1.0 / self.sample_rate;

        for n in 0..frames {
            // tick LFOs
            for l in &mut self.lfos {
                l.tick(dt);
            }

            // mix voices and retire finished
            let mut mix = 0.0f32;
            self.voices.retain_mut(|voice| {
                let s = voice.render(
                    dt,
                    &self.osc_settings,
                    &self.wavetables,
                    &self.lfos,
                    &self.mod_matrix,
                    self.sample_rate,
                    self.filter_env_enabled,
                );
                mix += s;
                !voice.is_finished()
            });

            // global cutoff modulation
            let lfo_mod = self.lfos[0].value() * self.mod_matrix.lfo0_to_cutoff
                + self.lfos[1].value() * self.mod_matrix.lfo1_to_cutoff
                + self.mod_matrix.env_to_cutoff;
            let cutoff = (self.filter.base_cutoff + lfo_mod * 2000.0)
                .max(20.0)
                .min(self.sample_rate * 0.49);
            self.filter.set_cutoff(cutoff);

            let filtered = self.filter.process(mix);
            let delayed = self.delay.process(filtered);
            let reverbed = self.reverb.process(delayed);

            // gentle soft clip for mix glue / perceived loudness
            out[n] = soft_clip(reverbed * self.master_gain);
        }

        Float32Array::from(out.as_slice())
    }
}

// ---------------- internal DSP ----------------
#[derive(Clone, Copy)]
enum Waveform {
    Sine,
    Saw,
    Square,
    Triangle,
    Noise,
    Wavetable,
}
impl Waveform {
    fn from_f32(v: f32) -> Self {
        match v.round() as i32 {
            0 => Self::Sine,
            1 => Self::Saw,
            2 => Self::Square,
            3 => Self::Triangle,
            4 => Self::Noise,
            5 => Self::Wavetable,
            _ => Self::Sine,
        }
    }
    fn to_index(&self) -> u8 {
        match self {
            Self::Sine => 0,
            Self::Saw => 1,
            Self::Square => 2,
            Self::Triangle => 3,
            Self::Noise => 4,
            Self::Wavetable => 5,
        }
    }
}

#[derive(Clone, Copy)]
struct OscSettings {
    waveform: Waveform,
    detune_cents: f32,
    gain: f32,
}
impl Default for OscSettings {
    fn default() -> Self {
        Self {
            waveform: Waveform::Saw,
            detune_cents: 0.0,
            gain: 0.8,
        }
    }
}

#[derive(Clone, Copy)]
struct ADSRParams {
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
}
impl Default for ADSRParams {
    fn default() -> Self {
        Self {
            attack: 0.01,
            decay: 0.2,
            sustain: 0.8,
            release: 0.3,
        }
    }
}

struct Voice {
    midi_note: u8,
    freq: f32,
    vel: f32,
    phase0: f32,
    phase1: f32,
    env: PerVoiceADSR,
    alive: bool,
}
impl Voice {
    fn new(m: u8, f: f32, vel: f32, env: &ADSRParams) -> Self {
        Self {
            midi_note: m,
            freq: f,
            vel,
            phase0: 0.0,
            phase1: 0.0,
            env: PerVoiceADSR::new(env),
            alive: true,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render(
        &mut self,
        dt: f32,
        osc: &[OscSettings; 2],
        wts: &[Vec<f32>; 2],
        lfos: &[LFO; 2],
        mods: &ModMatrix,
        sr: f32,
        _filter_env_enabled: bool,
    ) -> f32 {
        let mut s = 0.0f32;

        for (i, os) in osc.iter().enumerate() {
            let det = 2f32.powf(os.detune_cents / 1200.0);
            let f = self.freq * det;
            let tabl = &wts[i];
            let tl = tabl.len() as f32;

            // optional "wt position" modulation by LFOs (speed skew)
            let wt_pos_mod = lfos[0].value() * mods.lfo0_to_wtpos + lfos[1].value() * mods.lfo1_to_wtpos;
            let incr = f * (tl / sr) * (1.0 + wt_pos_mod);

            if i == 0 {
                self.phase0 = (self.phase0 + incr) % tl;
            } else {
                self.phase1 = (self.phase1 + incr) % tl;
            }
            let ph = if i == 0 { self.phase0 } else { self.phase1 };

            let sample = match os.waveform {
                Waveform::Sine => ((ph / tl) * 2.0 * PI).sin(),
                Waveform::Saw => 2.0 * ((ph / tl) - 0.5),
                Waveform::Square => {
                    if (ph / tl) < 0.5 { 1.0 } else { -1.0 }
                }
                Waveform::Triangle => {
                    let frac = ph / tl;
                    2.0 * (2.0 * (frac - 0.25).abs() - 0.5)
                }
                Waveform::Noise => rand_range(-1.0, 1.0),
                Waveform::Wavetable => {
                    let i0 = ph.floor() as usize % tabl.len();
                    let i1 = (i0 + 1) % tabl.len();
                    let frac = ph - ph.floor();
                    tabl[i0] * (1.0 - frac) + tabl[i1] * frac
                }
            };

            s += sample * os.gain;
        }

        let env = self.env.tick(dt);
        let amp_lfo = lfos[0].value() * mods.lfo0_to_amp + lfos[1].value() * mods.lfo1_to_amp;
        let amp = (env * (1.0 + amp_lfo)).clamp(0.0, 4.0) * self.vel;

        s * amp
    }

    fn is_finished(&self) -> bool {
        matches!(self.env.state, AdsrState::Idle)
    }
}

struct PerVoiceADSR {
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    state: AdsrState,
    level: f32,
}
#[derive(Clone, Copy)]
enum AdsrState {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}
impl PerVoiceADSR {
    fn new(d: &ADSRParams) -> Self {
        Self {
            attack: d.attack,
            decay: d.decay,
            sustain: d.sustain,
            release: d.release,
            state: AdsrState::Attack,
            level: 0.0,
        }
    }
    fn note_off(&mut self) {
        self.state = AdsrState::Release;
    }
    fn tick(&mut self, dt: f32) -> f32 {
        match self.state {
            AdsrState::Idle => {}
            AdsrState::Attack => {
                self.level += dt / self.attack.max(1e-6);
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.state = AdsrState::Decay;
                }
            }
            AdsrState::Decay => {
                self.level -= dt / self.decay.max(1e-6) * (1.0 - self.sustain);
                if self.level <= self.sustain {
                    self.level = self.sustain;
                    self.state = AdsrState::Sustain;
                }
            }
            AdsrState::Sustain => {}
            AdsrState::Release => {
                self.level -= dt / self.release.max(1e-6);
                if self.level <= 0.0 {
                    self.level = 0.0;
                    self.state = AdsrState::Idle;
                }
            }
        }
        self.level
    }
}

#[derive(Clone, Copy)]
struct LFO {
    rate: f32,
    amount: f32,
    phase: f32,
    waveform: u8, // 0=sine,1=tri,2=square,3=saw
}
impl LFO {
    fn default() -> Self {
        Self { rate: 2.5, amount: 0.0, phase: 0.0, waveform: 0 }
    }
    fn tick(&mut self, dt: f32) {
        self.phase = (self.phase + dt * self.rate * 2.0 * PI) % (2.0 * PI);
    }
    fn retrigger(&mut self) {
        self.phase = 0.0;
    }
    fn value(&self) -> f32 {
        let base = match self.waveform {
            0 => self.phase.sin(),
            1 => (2.0 / PI) * self.phase.asin(),
            2 => if self.phase.sin() >= 0.0 { 1.0 } else { -1.0 },
            3 => {
                let frac = (self.phase / (2.0 * PI)) % 1.0;
                2.0 * (frac - 0.5)
            }
            _ => self.phase.sin(),
        };
        base * self.amount
    }
}

#[derive(Clone, Copy)]
struct ModMatrix {
    lfo0_to_cutoff: f32,
    lfo1_to_cutoff: f32,
    env_to_cutoff: f32,
    lfo0_to_amp: f32,
    lfo1_to_amp: f32,
    lfo0_to_wtpos: f32,
    lfo1_to_wtpos: f32,
}
impl Default for ModMatrix {
    fn default() -> Self {
        Self {
            lfo0_to_cutoff: 0.3,
            lfo1_to_cutoff: 0.0,
            env_to_cutoff: 0.0,
            lfo0_to_amp: 0.0,
            lfo1_to_amp: 0.0,
            lfo0_to_wtpos: 0.0,
            lfo1_to_wtpos: 0.0,
        }
    }
}
impl ModMatrix {
    fn set_by_name(&mut self, name: &str, value: f32) {
        match name {
            "mod_lfo0_to_cutoff" => self.lfo0_to_cutoff = value,
            "mod_lfo1_to_cutoff" => self.lfo1_to_cutoff = value,
            "mod_env_to_cutoff"  => self.env_to_cutoff = value,
            "mod_lfo0_to_amp"    => self.lfo0_to_amp = value,
            "mod_lfo1_to_amp"    => self.lfo1_to_amp = value,
            "mod_lfo0_to_wtpos"  => self.lfo0_to_wtpos = value,
            "mod_lfo1_to_wtpos"  => self.lfo1_to_wtpos = value,
            _ => {}
        }
    }
}

// --- Topology-Preserving Transform SVF (lowpass out) -------------------
struct StateVarFilter {
    pub base_cutoff: f32,
    pub resonance: f32,   // 0..~1.2; musical mapping to Q
    sample_rate: f32,

    // TPT state
    g: f32,
    k: f32,
    ic1eq: f32,
    ic2eq: f32,
}
impl StateVarFilter {
    fn new(c: f32, q: f32, sr: f32) -> Self {
        let mut f = Self {
            base_cutoff: c,
            resonance: q,
            sample_rate: sr,
            g: 0.0, k: 0.0, ic1eq: 0.0, ic2eq: 0.0,
        };
        f.update_coeffs();
        f
    }
    fn set_cutoff(&mut self, c: f32) {
        self.base_cutoff = c.max(20.0).min(self.sample_rate * 0.49);
        self.update_coeffs();
    }
    #[inline]
    fn update_coeffs(&mut self) {
        // bilinear transform prewarp with normalized T=1
        let wc = (std::f32::consts::PI * (self.base_cutoff / self.sample_rate)).tan();
        self.g = wc;

        // Map resonance (0..1.2) to k = 1/Q; lower "resonance" => higher Q (more peak)
        let q = 0.5 + (1.5 * (1.0 - self.resonance.clamp(0.0, 1.2))).max(0.05);
        self.k = 1.0 / q;
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // TPT 2-pole lowpass
        let v0 = x;
        let v1 = (self.ic1eq + self.g * (v0 - self.ic2eq)) / (1.0 + self.g * (self.g + self.k));
        let v2 = self.ic2eq + self.g * v1;

        self.ic1eq = 2.0 * v1 - self.ic1eq;
        self.ic2eq = 2.0 * v2 - self.ic2eq;

        v2
    }
}

// --- Feedback delay with fractional read + damping ---------------------
struct SimpleDelay {
    sample_rate: f32,
    buffer: Vec<f32>,
    write_pos: usize,
    length: usize,
    time_seconds: f32,
    pub feedback: f32,
    pub wet: f32,

    // feedback path lowpass (warmer repeats)
    fb_lp_state: f32,
    fb_lp_coef: f32,
}
impl SimpleDelay {
    fn new(sr: f32, time: f32, fb: f32) -> Self {
        let length = (sr * 5.0) as usize;
        let mut d = Self {
            sample_rate: sr,
            buffer: vec![0.0; length.max(1)],
            write_pos: 0,
            length: length.max(1),
            time_seconds: time.clamp(0.0, 5.0),
            feedback: fb.clamp(0.0, 0.99),
            wet: 0.35,
            fb_lp_state: 0.0,
            fb_lp_coef: 0.0,
        };
        d.set_feedback_tone(6000.0);
        d
    }
    fn set_time(&mut self, t: f32) {
        self.time_seconds = t.clamp(0.0, 5.0);
    }
    fn set_feedback_tone(&mut self, hz: f32) {
        let hz = hz.clamp(500.0, 12000.0);
        let x = (-2.0 * std::f32::consts::PI * hz / self.sample_rate).exp();
        self.fb_lp_coef = 1.0 - x;
    }
    #[inline]
    fn read_frac(&self, delay_samples: f32) -> f32 {
        let mut rp = self.write_pos as i32 - delay_samples as i32;
        while rp < 0 { rp += self.length as i32; }
        let rp0 = rp as usize % self.length;
        let rp1 = (rp0 + 1) % self.length;
        let frac = delay_samples.fract();
        let a = self.buffer[rp0];
        let b = self.buffer[rp1];
        a + (b - a) * frac
    }
    fn process(&mut self, x: f32) -> f32 {
        let d_samp = (self.time_seconds * self.sample_rate).clamp(0.0, (self.length - 2) as f32);

        // read delayed signal
        let delayed = self.read_frac(d_samp);

        // feedback path damping (darkens repeats)
        self.fb_lp_state += self.fb_lp_coef * (delayed - self.fb_lp_state);
        let fb_sig = self.fb_lp_state * self.feedback;

        // write input + feedback
        self.buffer[self.write_pos] = x + fb_sig;
        self.write_pos = (self.write_pos + 1) % self.length;

        // wet/dry
        x * (1.0 - self.wet) + delayed * self.wet
    }
}

// --- Lush Schroeder/Moorer Reverb (mono) -------------------------------
struct SimpleReverb {
    // pre-delay
    pre_buf: Vec<f32>,
    pre_pos: usize,
    pre_len: usize,

    // 4 damped combs
    comb_bufs: [Vec<f32>; 4],
    comb_pos: [usize; 4],
    comb_len: [usize; 4],
    comb_feedback: [f32; 4],
    comb_lp_state: [f32; 4],
    comb_lp_coef: [f32; 4], // feedback damping

    // 2 series allpasses
    ap_bufs: [Vec<f32>; 2],
    ap_pos: [usize; 2],
    ap_len: [usize; 2],
    ap_g: [f32; 2],

    pub wet: f32,
    sample_rate: f32,
    decay: f32, // seconds
    size: f32,  // scale
}
impl SimpleReverb {
    fn new(sr: f32) -> Self {
        let mut r = Self {
            pre_buf: vec![0.0; (0.02 * sr) as usize],
            pre_pos: 0,
            pre_len: (0.02 * sr) as usize,

            comb_bufs: [
                vec![0.0; (0.050 * sr) as usize],
                vec![0.0; (0.056 * sr) as usize],
                vec![0.0; (0.061 * sr) as usize],
                vec![0.0; (0.068 * sr) as usize],
            ],
            comb_pos: [0, 0, 0, 0],
            comb_len: [
                (0.050 * sr) as usize,
                (0.056 * sr) as usize,
                (0.061 * sr) as usize,
                (0.068 * sr) as usize,
            ],
            comb_feedback: [0.77, 0.80, 0.82, 0.84],
            comb_lp_state: [0.0; 4],
            comb_lp_coef: [
                Self::lp_coef(sr, 5000.0),
                Self::lp_coef(sr, 4500.0),
                Self::lp_coef(sr, 4000.0),
                Self::lp_coef(sr, 3500.0),
            ],

            ap_bufs: [
                vec![0.0; (0.012 * sr) as usize],
                vec![0.0; (0.004 * sr) as usize],
            ],
            ap_pos: [0, 0],
            ap_len: [(0.012 * sr) as usize, (0.004 * sr) as usize],
            ap_g: [0.7, 0.7],

            wet: 0.35,
            sample_rate: sr,
            decay: 2.2,
            size: 1.0,
        };
        r.recalc_lengths();
        r
    }

    #[inline]
    fn lp_coef(sr: f32, fc: f32) -> f32 {
        let x = (-2.0 * std::f32::consts::PI * fc / sr).exp();
        1.0 - x
    }

    fn set_size(&mut self, s: f32) {
        self.size = s.clamp(0.5, 1.5);
        self.recalc_lengths();
    }

    fn set_decay(&mut self, seconds: f32) {
        self.decay = seconds.clamp(0.2, 8.0);
        for i in 0..4 {
            let len_s = (self.comb_len[i] as f32) / self.sample_rate;
            // T60 ≈ -3 * len / ln(feedback)  => feedback ≈ e^( -3*len / T60 )
            let fb = (-3.0 * len_s / self.decay).exp();
            self.comb_feedback[i] = fb.clamp(0.5, 0.98);
        }
    }

    fn recalc_lengths(&mut self) {
        let scale = self.size;
        let scale_len = |l: usize| ((l as f32) * scale).max(1.0) as usize;

        self.pre_len = scale_len((0.02 * self.sample_rate) as usize);
        self.pre_buf.resize(self.pre_len.max(1), 0.0);
        self.pre_pos %= self.pre_len.max(1);

        let base = [
            (0.050 * self.sample_rate) as usize,
            (0.056 * self.sample_rate) as usize,
            (0.061 * self.sample_rate) as usize,
            (0.068 * self.sample_rate) as usize,
        ];
        for i in 0..4 {
            let nl = scale_len(base[i]);
            self.comb_len[i] = nl.max(1);
            self.comb_bufs[i].resize(self.comb_len[i], 0.0);
            self.comb_pos[i] %= self.comb_len[i];
        }

        let ap_base = [
            (0.012 * self.sample_rate) as usize,
            (0.004 * self.sample_rate) as usize,
        ];
        for i in 0..2 {
            let nl = scale_len(ap_base[i]);
            self.ap_len[i] = nl.max(1);
            self.ap_bufs[i].resize(self.ap_len[i], 0.0);
            self.ap_pos[i] %= self.ap_len[i];
        }

        self.set_decay(self.decay);
    }

    #[inline]
    fn comb_process(&mut self, i: usize, x: f32) -> f32 {
        let p = self.comb_pos[i];
        let y = self.comb_bufs[i][p];

        // damping in feedback loop
        let a = self.comb_lp_coef[i];
        self.comb_lp_state[i] += a * (y - self.comb_lp_state[i]);
        let fb = self.comb_feedback[i];

        self.comb_bufs[i][p] = x + self.comb_lp_state[i] * fb;
        self.comb_pos[i] = (p + 1) % self.comb_len[i];
        y
    }

    #[inline]
    fn allpass_process(&mut self, i: usize, x: f32) -> f32 {
        let p = self.ap_pos[i];
        let buf = self.ap_bufs[i][p];
        let g = self.ap_g[i];

        let y = -x + buf;
        self.ap_bufs[i][p] = x + buf * g;

        self.ap_pos[i] = (p + 1) % self.ap_len[i];
        y
    }

    fn process(&mut self, x: f32) -> f32 {
        // pre-delay
        let y0 = self.pre_buf[self.pre_pos];
        self.pre_buf[self.pre_pos] = x;
        self.pre_pos = (self.pre_pos + 1) % self.pre_len;

        // parallel combs → average
        let mut s = 0.0;
        for i in 0..4 { s += self.comb_process(i, y0); }
        s *= 0.25;

        // diffusion allpasses
        let y1 = self.allpass_process(0, s);
        let y2 = self.allpass_process(1, y1);

        x * (1.0 - self.wet) + y2 * self.wet
    }
}

// ---------- helpers ----------
fn midi_to_freq(n: u8) -> f32 {
    440.0 * 2f32.powf((n as f32 - 69.0) / 12.0)
}
fn rand_phase() -> f32 {
    (js_sys::Math::random() as f32) * (WAVETABLE_SIZE as f32)
}
fn rand_range(a: f32, b: f32) -> f32 {
    a + (b - a) * (js_sys::Math::random() as f32)
}

fn set(obj: &Object, key: &str, val: f32) {
    let _ = js_sys::Reflect::set(obj, &key.into(), &JsValue::from_f64(val as f64));
}
fn get_into(obj: &Object, key: &str) -> Option<f32> {
    js_sys::Reflect::get(obj, &key.into())
        .ok()
        .and_then(|v| v.as_f64())
        .map(|x| x as f32)
}

// gentle, musical soft saturation
#[inline]
fn soft_clip(x: f32) -> f32 {
    // smooth, monotonic; keeps transients while taming peaks
    let a = 0.5;
    let x1 = x.clamp(-2.0, 2.0);
    x1 * (1.0 + a) / (1.0 + a * x1.abs())
}

// better panic messages in console
fn set_panic_hook() {
    console_error_panic_hook::set_once();
}