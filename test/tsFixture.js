/**
 * A small, well-formed MPEG-TS stream for tests: a PAT, a PMT with one H.264 video and one AAC audio stream, and
 * PES packets with PCR, PTS and DTS. Each provider in a test can use its own PIDs and clock. Video continuation
 * packets carry [tag] as payload, so a test can tell which source a stretch of output came from.
 */
const { crc32 } = require("../xtream/tsNormalizer");

const PACKET = 188;

function psi(pid, body, cc) {
  const crc = crc32(body);
  const sec = Buffer.concat([body, Buffer.from([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])]);
  const p = Buffer.alloc(PACKET, 0xff);
  p[0] = 0x47;
  p[1] = 0x40 | (pid >> 8);
  p[2] = pid & 0xff;
  p[3] = 0x10 | (cc & 0x0f);
  p[4] = 0;
  sec.copy(p, 5);
  return p;
}

function ts(b, o, prefix, t) {
  b[o] = (prefix << 4) | ((Math.floor(t / 2 ** 30) & 7) << 1) | 1;
  b[o + 1] = Math.floor(t / 2 ** 22) & 0xff;
  b[o + 2] = ((Math.floor(t / 2 ** 15) & 0x7f) << 1) | 1;
  b[o + 3] = Math.floor(t / 2 ** 7) & 0xff;
  b[o + 4] = ((t & 0x7f) << 1) | 1;
}

class FakeTs {
  constructor({ tag = 1, pmtPid = 0x20, videoPid = 0x21, audioPid = 0x22, clock = 1_000_000, frameEvery = 3000, gop = 10 } = {}) {
    Object.assign(this, { tag, pmtPid, videoPid, audioPid, clock, frameEvery, gop });
    this.cc = new Map();
    this.frame = 0;
  }

  next(pid) {
    const c = ((this.cc.get(pid) ?? 15) + 1) & 0x0f;
    this.cc.set(pid, c);
    return c;
  }

  tables() {
    const pat = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (this.pmtPid >> 8), this.pmtPid & 0xff]);
    const es = Buffer.from([
      0x1b, 0xe0 | (this.videoPid >> 8), this.videoPid & 0xff, 0xf0, 0x00,
      0x0f, 0xe0 | (this.audioPid >> 8), this.audioPid & 0xff, 0xf0, 0x00,
    ]);
    const len = 9 + es.length + 4;
    const pmt = Buffer.concat([Buffer.from([0x02, 0xb0 | (len >> 8), len & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (this.videoPid >> 8), this.videoPid & 0xff, 0xf0, 0x00]), es]);
    return [psi(0, pat, this.next(0)), psi(this.pmtPid, pmt, this.next(this.pmtPid))];
  }

  /** One video frame (a PES start with PCR, PTS and DTS, then [fill] continuation packets) and one audio packet. */
  frameOut(fill = 6) {
    const key = this.frame % this.gop === 0;
    const t = this.clock + this.frame * this.frameEvery;
    this.frame++;
    const out = [];
    const v = Buffer.alloc(PACKET, 0xff);
    v[0] = 0x47;
    v[1] = 0x40 | (this.videoPid >> 8);
    v[2] = this.videoPid & 0xff;
    v[3] = 0x30 | this.next(this.videoPid);
    v[4] = 7;
    v[5] = 0x10;
    const pcr = t - 9000;
    v[6] = Math.floor(pcr / 2 ** 25) & 0xff;
    v[7] = Math.floor(pcr / 2 ** 17) & 0xff;
    v[8] = Math.floor(pcr / 2 ** 9) & 0xff;
    v[9] = Math.floor(pcr / 2) & 0xff;
    v[10] = ((pcr % 2) << 7) | 0x7e;
    v[11] = 0;
    const o = 12;
    v[o] = 0; v[o + 1] = 0; v[o + 2] = 1; v[o + 3] = 0xe0; v[o + 4] = 0; v[o + 5] = 0;
    v[o + 6] = 0x80; v[o + 7] = 0xc0; v[o + 8] = 10;
    ts(v, o + 9, 3, t + 3000);
    ts(v, o + 14, 1, t);
    const nal = o + 19;
    // Keyframes start with an SPS; the random access flag is set on every frame, as one real provider does.
    v[nal] = 0; v[nal + 1] = 0; v[nal + 2] = 1; v[nal + 3] = key ? 0x67 : 0x41;
    v[5] |= 0x40;
    out.push(v);
    for (let i = 0; i < fill; i++) {
      const c = Buffer.alloc(PACKET, this.tag);
      c[0] = 0x47;
      c[1] = this.videoPid >> 8;
      c[2] = this.videoPid & 0xff;
      c[3] = 0x10 | this.next(this.videoPid);
      out.push(c);
    }
    const a = Buffer.alloc(PACKET, 0xaa);
    a[0] = 0x47;
    a[1] = 0x40 | (this.audioPid >> 8);
    a[2] = this.audioPid & 0xff;
    a[3] = 0x10 | this.next(this.audioPid);
    const ao = 4;
    a[ao] = 0; a[ao + 1] = 0; a[ao + 2] = 1; a[ao + 3] = 0xc0; a[ao + 4] = 0; a[ao + 5] = 0;
    a[ao + 6] = 0x80; a[ao + 7] = 0x80; a[ao + 8] = 5;
    ts(a, ao + 9, 2, t + 3000);
    out.push(a);
    return out;
  }

  /** [frames] frames, with the program tables at the start. */
  chunk(frames = 10) {
    const out = this.tables();
    for (let i = 0; i < frames; i++) out.push(...this.frameOut());
    return Buffer.concat(out);
  }
}

/** Parses output packets: pid, continuity counter, payload start, PCR, PTS, DTS and the first payload byte. */
function parse(buf) {
  const out = [];
  for (let i = 0; i + PACKET <= buf.length; i += PACKET) {
    const p = buf.subarray(i, i + PACKET);
    if (p[0] !== 0x47) throw new Error(`no sync byte at ${i}`);
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const adapt = (p[3] & 0x20) !== 0;
    let o = adapt ? 5 + p[4] : 4;
    let pcr = null;
    if (adapt && p[4] >= 7 && p[5] & 0x10) pcr = p[6] * 2 ** 25 + p[7] * 2 ** 17 + p[8] * 2 ** 9 + p[9] * 2 + (p[10] >> 7);
    const start = (p[1] & 0x40) !== 0;
    let pts = null;
    let dts = null;
    const read = (q) => ((p[q] >> 1) & 7) * 2 ** 30 + p[q + 1] * 2 ** 22 + ((p[q + 2] >> 1) << 15) + p[q + 3] * 2 ** 7 + (p[q + 4] >> 1);
    if (start && p[o] === 0 && p[o + 1] === 0 && p[o + 2] === 1) {
      const flags = p[o + 7] >> 6;
      if (flags >= 2) pts = read(o + 9);
      if (flags === 3) dts = read(o + 14);
    }
    out.push({ pid, cc: p[3] & 0x0f, hasPayload: (p[3] & 0x10) !== 0, start, pcr, pts, dts, first: p[o] });
  }
  return out;
}

module.exports = { FakeTs, parse };
