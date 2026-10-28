// ggwave (data over sound: FSK with Reed-Solomon error correction, MIT) for passing records
// phone to phone through a speaker, a walkie-talkie, an AM radio or a phone call. Carried over
// unchanged from BSVKey/dtn-custody-demo radio/lib/sound.mjs, where it moved real payments.
export const SPEEDS = {
  normal: "GGWAVE_PROTOCOL_AUDIBLE_NORMAL", fast: "GGWAVE_PROTOCOL_AUDIBLE_FAST", fastest: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
  "dt-normal": "GGWAVE_PROTOCOL_DT_NORMAL", "dt-fast": "GGWAVE_PROTOCOL_DT_FAST", "dt-fastest": "GGWAVE_PROTOCOL_DT_FASTEST",
};

// Pass to the ggwave factory to keep its debug printing off stdout: factory(QUIET)
export const QUIET = { print() {}, printErr() {} };

// Thin wrapper over a loaded ggwave module (browser or Node). Samples are float32.
//
// ggwave always runs at 48 kHz here. Its own resampling needs input in frames of
// 1024 x inputRate / 48000 samples, which is not a whole number at 44.1 kHz (940.8), and a
// misaligned frame stops it decoding for good. So audio captured at any other rate is resampled
// to 48 kHz first (inputRate), and encoded audio is always 48 kHz: give players that rate.
export const RATE = 48000;
export function ggwaveCodec(gg, { inputRate = RATE } = {}) {
  gg.disableLog?.();
  const p = gg.getDefaultParameters();
  p.sampleRateInp = RATE; p.sampleRateOut = RATE;
  // separate instances: encoding on the receiving instance breaks a decode in progress
  const tx = gg.init(p), rx = gg.init(p);
  const FRAME = p.samplesPerFrame, frame = new Float32Array(FRAME);
  let fill = 0;
  // streaming linear resampler state: position of the next output sample, in input samples
  let pos = 0, prev = 0;
  function to48k(x, rate) {
    if (rate === RATE) return x;
    const step = rate / RATE, out = [];
    for (; pos < x.length; pos += step) {
      const j = Math.floor(pos), f = pos - j, a = j === 0 ? prev : x[j - 1], b = x[j];
      out.push(a + (b - a) * f);
    }
    pos -= x.length; prev = x[x.length - 1] ?? prev;
    return Float32Array.from(out);
  }
  return {
    sampleRate: RATE,
    // returns a Float32Array copy at 48 kHz (the module's own view is reused by the next call)
    encode(text, speed = "fast", volume = 25) {
      const raw = gg.encode(tx, text, gg.ProtocolId[SPEEDS[speed]], volume);
      return new Float32Array(new Int8Array(raw).buffer);
    },
    // feed captured samples in any block size, at `rate` (default: inputRate); returns the texts
    // decoded so far (often none). ggwave gets whole 48 kHz frames only.
    decode(samples, rate = inputRate) {
      const x = to48k(samples, rate), texts = [];
      for (let i = 0; i < x.length; ) {
        const take = Math.min(FRAME - fill, x.length - i);
        frame.set(x.subarray(i, i + take), fill); fill += take; i += take;
        if (fill < FRAME) break;
        fill = 0;
        const out = gg.decode(rx, new Int8Array(frame.buffer.slice(0)));
        if (out && out.length) texts.push(new TextDecoder().decode(out));
      }
      return texts;
    },
  };
}
