/**
 * sketcher-sound.js — ANS-inspired audio engine for Sketcher Pro
 * by Vladyslav Bubalo
 *
 * Sound model inspired by the АНС synthesizer (Муzeum of Music, Moscow):
 * - Y axis → pitch (top = high freq, bottom = low freq)
 * - Stroke density / speed → timbre richness (sine → distorted harmonics)
 * - Drawing motion → amplitude envelope (attack on mousedown, release on up)
 * - Fill lines → additive chord swell (each interpolated line = new partial)
 */

const SketcherSound = (() => {

    // ─── Config ───────────────────────────────────────────────────────────────

    const CFG = {
        // Frequency range mapped to canvas Y axis (top → high, bottom → low)
        FREQ_MAX:       2400,   // Hz at Y = 0
        FREQ_MIN:       60,     // Hz at Y = canvasH

        // Master gain
        MASTER_GAIN:    0.18,

        // How many harmonics to pile when density is max
        MAX_HARMONICS:  7,

        // Distortion curve saturation at full density
        DIST_AMOUNT:    280,

        // Brush draw: amplitude envelope times (seconds)
        ATTACK:         0.04,
        RELEASE:        0.22,

        // Fill swell: each line adds a tiny partial that fades in
        FILL_PARTIAL_GAIN: 0.025,
        FILL_PARTIAL_FADE: 0.18,  // seconds

        // Minimum movement (px on canvas) before we retrigger pitch
        MOVE_THRESHOLD: 4,

        // Speed → staccato gate: fast strokes shorten note length
        SPEED_GATE_MIN: 0.05,   // seconds
        SPEED_GATE_MAX: 0.30,

        // Reverb room size (convolution IR length in seconds)
        REVERB_SEC:     1.2,
    };

    // ─── State ────────────────────────────────────────────────────────────────

    let ctx          = null;   // AudioContext
    let masterGain   = null;
    let masterComp   = null;   // limiter/compressor
    let reverbNode   = null;   // ConvolverNode
    let reverbSend   = null;   // GainNode → reverb
    let distNode     = null;   // WaveShaperNode

    let isReady      = false;
    let canvasW      = 1200;
    let canvasH      = 1200;

    // Currently active brush oscillator cluster
    let brushOscs    = [];     // { osc, gain }
    let brushActive  = false;
    let lastBrushPt  = null;
    let lastBrushTime = 0;

    // Density tracker: counts strokes drawn; decays over time
    let densityScore = 0;
    let densityTimer = null;

    // Fill chord partials (one per interpolated line)
    let fillPartials = [];

    // ─── Init ─────────────────────────────────────────────────────────────────

    function init() {
        if (isReady) return;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[SketcherSound] WebAudio not supported', e);
            return;
        }

        // Master chain: distortion → compressor → gain → out
        distNode = ctx.createWaveShaper();
        distNode.oversample = '4x';
        _updateDistCurve(0);

        masterComp = ctx.createDynamicsCompressor();
        masterComp.threshold.value = -18;
        masterComp.knee.value      = 8;
        masterComp.ratio.value     = 6;
        masterComp.attack.value    = 0.003;
        masterComp.release.value   = 0.18;

        masterGain = ctx.createGain();
        masterGain.gain.value = CFG.MASTER_GAIN;

        // Reverb
        reverbNode = ctx.createConvolver();
        reverbNode.buffer = _buildReverbIR(CFG.REVERB_SEC);
        reverbSend = ctx.createGain();
        reverbSend.gain.value = 0.28;

        distNode.connect(masterComp);
        masterComp.connect(masterGain);
        masterGain.connect(ctx.destination);

        // Wet reverb path
        masterGain.connect(reverbSend);
        reverbSend.connect(reverbNode);
        reverbNode.connect(ctx.destination);

        isReady = true;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /** Call when canvas resolution changes */
    function setCanvasSize(w, h) {
        canvasW = w || 1200;
        canvasH = h || 1200;
    }

    /** Resume suspended context (required after user gesture on iOS/Chrome) */
    function resume() {
        if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    /** User started drawing at canvas point {x, y} */
    function onBrushDown(pt) {
        if (!isReady) return;
        resume();
        brushActive = true;
        lastBrushPt = pt;
        lastBrushTime = ctx.currentTime;
        _startBrushTone(pt);
        _bumpDensity(1.5);
    }

    /** User is dragging the brush; called per move event with canvas coords */
    function onBrushMove(pt) {
        if (!isReady || !brushActive) return;

        if (!lastBrushPt) { lastBrushPt = pt; return; }

        const dx   = pt.x - lastBrushPt.x;
        const dy   = pt.y - lastBrushPt.y;
        const dist = Math.hypot(dx, dy);
        if (dist < CFG.MOVE_THRESHOLD) return;

        const now   = ctx.currentTime;
        const dt    = Math.max(0.001, now - lastBrushTime);
        const speed = dist / dt / canvasH;  // normalised 0..∞

        _updateBrushTone(pt, speed);
        lastBrushPt   = pt;
        lastBrushTime = now;
    }

    /** User lifted the brush */
    function onBrushUp() {
        if (!isReady || !brushActive) return;
        brushActive = false;
        _stopBrushTone();
        lastBrushPt = null;
    }

    /**
     * Called once per interpolated fill line.
     * @param {number} t     - 0..1 progress through the fill animation
     * @param {Array}  pts   - array of {x,y} canvas coords for this line
     */
    function onFillLine(t, pts) {
        if (!isReady || !pts.length) return;
        resume();

        // Average Y of this line → pitch
        let sumY = 0;
        for (const p of pts) sumY += p.y;
        const avgY = sumY / pts.length;

        // Average X → stereo pan
        let sumX = 0;
        for (const p of pts) sumX += p.x;
        const avgX = sumX / pts.length;
        const pan  = (avgX / canvasW) * 2 - 1; // -1..1

        const freq = _yToFreq(avgY);

        // Each fill line fires a short sine burst (ANS-style partial)
        _spawnFillPartial(freq, pan, t);
        _bumpDensity(0.4);
    }

    /** Clear all sound state (e.g. on canvas clear) */
    function reset() {
        onBrushUp();
        _killFillPartials();
        densityScore = 0;
        _updateDistCurve(0);
    }

    // ─── Internal: brush tone ─────────────────────────────────────────────────

    function _startBrushTone(pt) {
        _killBrushOscs();

        const freq     = _yToFreq(pt.y);
        const harmCount = _densityToHarmonics();
        const pan      = (pt.x / canvasW) * 2 - 1;

        for (let h = 0; h < harmCount; h++) {
            const { osc, gain } = _makeOscGain(
                freq * (h + 1),
                h === 0 ? 'sine' : (h < 3 ? 'triangle' : 'sawtooth'),
                pan
            );

            // Harmonic gain falloff: 1/h²
            const baseGain = 1 / ((h + 1) * (h + 1));
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(baseGain, ctx.currentTime + CFG.ATTACK);

            osc.start(ctx.currentTime);
            brushOscs.push({ osc, gain });
        }
    }

    function _updateBrushTone(pt, speed) {
        const freq    = _yToFreq(pt.y);
        const pan     = (pt.x / canvasW) * 2 - 1;
        const gateLen = _speedToGate(speed);

        brushOscs.forEach(({ osc, gain }, h) => {
            // Glide pitch to new position
            osc.frequency.cancelScheduledValues(ctx.currentTime);
            osc.frequency.setValueAtTime(osc.frequency.value, ctx.currentTime);
            osc.frequency.linearRampToValueAtTime(freq * (h + 1), ctx.currentTime + 0.04);

            // Staccato pulse on fast strokes
            if (speed > 0.3) {
                const baseGain = 1 / ((h + 1) * (h + 1));
                gain.gain.cancelScheduledValues(ctx.currentTime);
                gain.gain.setValueAtTime(baseGain, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + gateLen * 0.5);
                gain.gain.linearRampToValueAtTime(baseGain, ctx.currentTime + gateLen);
            }

            // Panner
            if (osc._panner) {
                osc._panner.pan.setValueAtTime(osc._panner.pan.value, ctx.currentTime);
                osc._panner.pan.linearRampToValueAtTime(pan, ctx.currentTime + 0.04);
            }
        });

        _updateDistCurve(densityScore);
    }

    function _stopBrushTone() {
        const t = ctx.currentTime;
        brushOscs.forEach(({ osc, gain }) => {
            gain.gain.cancelScheduledValues(t);
            gain.gain.setValueAtTime(gain.gain.value, t);
            gain.gain.linearRampToValueAtTime(0.0001, t + CFG.RELEASE);
            osc.stop(t + CFG.RELEASE + 0.05);
        });
        brushOscs = [];
    }

    function _killBrushOscs() {
        brushOscs.forEach(({ osc, gain }) => {
            try { osc.stop(); } catch (_) {}
            gain.disconnect();
        });
        brushOscs = [];
    }

    // ─── Internal: fill partials ──────────────────────────────────────────────

    function _spawnFillPartial(freq, pan, t) {
        // Limit concurrent partials to avoid overload
        if (fillPartials.length > 40) {
            const old = fillPartials.shift();
            try { old.osc.stop(); } catch (_) {}
            old.gain.disconnect();
        }

        const { osc, gain } = _makeOscGain(freq, 'sine', pan);

        // Amplitude shaped by density: more density = more harmonics in fill too
        const density = Math.min(1, densityScore / 10);
        const maxGain = CFG.FILL_PARTIAL_GAIN * (1 + density * 1.5);
        const fadeTime = CFG.FILL_PARTIAL_FADE * (0.7 + t * 0.6);

        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(maxGain, ctx.currentTime + 0.02);
        gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeTime);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + fadeTime + 0.05);

        // Also add one detuned harmonic for richness when density is high
        if (density > 0.4) {
            const { osc: osc2, gain: gain2 } = _makeOscGain(freq * 2.01, 'triangle', pan * 0.7);
            gain2.gain.setValueAtTime(0, ctx.currentTime);
            gain2.gain.linearRampToValueAtTime(maxGain * 0.3, ctx.currentTime + 0.03);
            gain2.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + fadeTime * 0.8);
            osc2.start(ctx.currentTime);
            osc2.stop(ctx.currentTime + fadeTime * 0.8 + 0.05);
            fillPartials.push({ osc: osc2, gain: gain2 });
        }

        fillPartials.push({ osc, gain });
    }

    function _killFillPartials() {
        fillPartials.forEach(({ osc, gain }) => {
            try { osc.stop(); } catch (_) {}
            gain.disconnect();
        });
        fillPartials = [];
    }

    // ─── Internal: helpers ────────────────────────────────────────────────────

    /** Y canvas coordinate → frequency (logarithmic, top=high) */
    function _yToFreq(y) {
        const norm = 1 - Math.min(1, Math.max(0, y / canvasH)); // 0=bottom,1=top
        return CFG.FREQ_MIN * Math.pow(CFG.FREQ_MAX / CFG.FREQ_MIN, norm);
    }

    /** Create oscillator + panner + gain wired into distNode */
    function _makeOscGain(freq, type, pan) {
        const osc    = ctx.createOscillator();
        const panner = ctx.createStereoPanner();
        const gain   = ctx.createGain();

        osc.type            = type;
        osc.frequency.value = Math.min(Math.max(freq, 20), 18000);
        panner.pan.value    = Math.min(1, Math.max(-1, pan));
        gain.gain.value     = 0;

        osc._panner = panner; // stash for later updates

        osc.connect(gain);
        gain.connect(panner);
        panner.connect(distNode);

        return { osc, gain };
    }

    /** Number of harmonics to stack based on current density */
    function _densityToHarmonics() {
        const d = Math.min(1, densityScore / 10);
        return 1 + Math.round(d * (CFG.MAX_HARMONICS - 1));
    }

    /** Fast speed → short gate (staccato); slow speed → long gate */
    function _speedToGate(speed) {
        const t = Math.min(1, speed / 1.5);
        return CFG.SPEED_GATE_MAX - t * (CFG.SPEED_GATE_MAX - CFG.SPEED_GATE_MIN);
    }

    /** Increment density accumulator; auto-decay over 4s of inactivity */
    function _bumpDensity(amount) {
        densityScore = Math.min(10, densityScore + amount);
        _updateDistCurve(densityScore);
        clearTimeout(densityTimer);
        densityTimer = setTimeout(() => {
            densityScore = Math.max(0, densityScore - 3);
            _updateDistCurve(densityScore);
        }, 4000);
    }

    /** Rebuild WaveShaper distortion curve based on density 0..10 */
    function _updateDistCurve(density) {
        if (!distNode) return;
        const amount = (density / 10) * CFG.DIST_AMOUNT;
        const n      = 256;
        const curve  = new Float32Array(n);
        const k      = amount;
        for (let i = 0; i < n; i++) {
            const x = (i * 2) / n - 1;
            curve[i] = k === 0
                ? x
                : ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
        }
        distNode.curve = curve;
    }

    /**
     * Build a simple synthetic reverb IR using filtered noise.
     * No external files needed.
     */
    function _buildReverbIR(durationSec) {
        const rate    = ctx.sampleRate;
        const len     = Math.floor(rate * durationSec);
        const ir      = ctx.createBuffer(2, len, rate);

        for (let ch = 0; ch < 2; ch++) {
            const data = ir.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                // Exponential decay of white noise
                const env  = Math.pow(1 - i / len, 2.4);
                data[i] = (Math.random() * 2 - 1) * env;
            }
        }
        return ir;
    }

    // ─── Export ───────────────────────────────────────────────────────────────

    return { init, setCanvasSize, resume, onBrushDown, onBrushMove, onBrushUp, onFillLine, reset };

})();
