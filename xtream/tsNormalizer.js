/**
 * Makes the relay's output look like one continuous MPEG-TS stream while its source changes underneath.
 *
 * Every provider's stream has its own packet ids (PIDs) and its own clock. A player that read the first
 * stream's program table and timestamps would freeze or show nothing after a raw splice (Android's ExoPlayer
 * reads the program table once). So the output always uses the same PIDs and its own program table, timestamps
 * carry on from where the last source left off, continuity counters run without gaps, and each source starts
 * on a video keyframe. It also keeps the output since the last keyframe, so a TV that joins a shared channel
 * starts on a whole picture.
 */
const PACKET = 188;
const SYNC = 0x47;
const PAT_PID = 0x0000;
const OUT_PMT_PID = 0x1000;
const OUT_VIDEO_PID = 0x0100;
const OUT_AUDIO_PID = 0x0101;
const OUT_PCR_PID = 0x01ff;
const MAX_AUDIO = 8;
const CLOCK = 2 ** 33;
const PSI_EVERY_PACKETS = 400;
// Some providers send their SPS only every few seconds, and a picture can't be decoded before it.
const KEYFRAME_WAIT_MS = 5000;
// The next source's timestamps start one frame (1/30 s at 90 kHz) after the last source's, so the TV plays on
// from its buffer instead of showing a frozen picture for the time the switch took.
const SWITCH_GAP = 3000;
const GOP_CACHE_MAX = 6 * 1024 * 1024;
// Just after a switch, audio the new source muxed earlier than its video would play twice; it's dropped instead.
const OVERLAP_MS = 3000;

const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xea]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x8a]);
// Private-data streams that are audio: AC-3, E-AC-3 and DTS descriptors.
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b]);
const HEVC_TYPE = 0x24;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c >>> 0;
}

const pidOf = (p, o = 0) => ((p[o + 1] & 0x1f) << 8) | p[o + 2];
const hasPayload = (p) => (p[3] & 0x10) !== 0;
const hasAdaptation = (p) => (p[3] & 0x20) !== 0;
const payloadStart = (p) => (p[1] & 0x40) !== 0;

function payloadOffset(p) {
  return hasAdaptation(p) ? 5 + p[4] : 4;
}

/** The PCR of packet [p] in 90 kHz units, or null. */
function readPcr(p) {
  if (!hasAdaptation(p) || p[4] < 7 || !(p[5] & 0x10)) return null;
  return p[6] * 2 ** 25 + p[7] * 2 ** 17 + p[8] * 2 ** 9 + p[9] * 2 + (p[10] >> 7);
}

function writePcr(p, base) {
  p[6] = Math.floor(base / 2 ** 25) & 0xff;
  p[7] = Math.floor(base / 2 ** 17) & 0xff;
  p[8] = Math.floor(base / 2 ** 9) & 0xff;
  p[9] = Math.floor(base / 2) & 0xff;
  p[10] = ((base % 2) << 7) | (p[10] & 0x7f);
}

function readTs(b, o) {
  return ((b[o] >> 1) & 0x07) * 2 ** 30 + b[o + 1] * 2 ** 22 + ((b[o + 2] >> 1) << 15) + b[o + 3] * 2 ** 7 + (b[o + 4] >> 1);
}

function writeTs(b, o, ts) {
  const prefix = b[o] & 0xf0;
  b[o] = prefix | ((Math.floor(ts / 2 ** 30) & 0x07) << 1) | 1;
  b[o + 1] = Math.floor(ts / 2 ** 22) & 0xff;
  b[o + 2] = ((Math.floor(ts / 2 ** 15) & 0x7f) << 1) | 1;
  b[o + 3] = Math.floor(ts / 2 ** 7) & 0xff;
  b[o + 4] = ((ts & 0x7f) << 1) | 1;
}

const wrap = (t) => ((t % CLOCK) + CLOCK) % CLOCK;
/** a - b on the 33-bit clock, as the shorter way round. */
const ahead = (a, b) => wrap(a - b + CLOCK / 2) - CLOCK / 2;

/** The PES header's PTS and DTS offsets in packet [p], when it starts a PES packet that has them. */
function pesTimestamps(p) {
  const o = payloadOffset(p);
  if (o + 19 > PACKET || p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) return null;
  const flags = p[o + 7] >> 6;
  if (flags === 2) return { pts: o + 9, dts: null };
  if (flags === 3) return { pts: o + 9, dts: o + 14 };
  return null;
}

/**
 * Whether [bytes] (video payload, after [tail], the last bytes of the previous payload) hold a parameter set,
 * the start of a picture that can be decoded on its own: an SPS for H.264, a VPS or SPS for HEVC. The random
 * access flag isn't enough, as some providers set it on ordinary frames.
 */
function hasParameterSet(tail, bytes, hevc) {
  const b = tail.length ? Buffer.concat([tail, bytes]) : bytes;
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
    const nal = b[i + 3];
    if (hevc ? ((nal >> 1) & 0x3f) === 32 || ((nal >> 1) & 0x3f) === 33 : (nal & 0x1f) === 7) return true;
  }
  return false;
}

/** The video bytes of packet [p]: its payload, without the PES header when it starts one. */
function videoBytes(p) {
  let o = payloadOffset(p);
  if (o >= PACKET) return Buffer.alloc(0);
  if (payloadStart(p) && p[o] === 0 && p[o + 1] === 0 && p[o + 2] === 1 && o + 9 <= PACKET) o += 9 + p[o + 8];
  return o < PACKET ? p.subarray(o) : Buffer.alloc(0);
}

/**
 * The audio format of an AAC (ADTS) frame at the start of [bytes]: profile, sample rate index and channels. Players
 * such as ExoPlayer set their audio decoder up from the first frame and strip these headers, so a change of any
 * of them mid-stream garbles the sound. Other audio is described by its stream type alone.
 */
function audioFormat(type, bytes) {
  if (type !== 0x0f) return `type ${type}`;
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xf6) !== 0xf0) continue;
    const profile = bytes[i + 2] >> 6;
    const rate = (bytes[i + 2] >> 2) & 0x0f;
    const channels = ((bytes[i + 2] & 0x01) << 2) | (bytes[i + 3] >> 6);
    return `aac ${profile}/${rate}/${channels}`;
  }
  return null;
}

/** The section in a PSI packet's payload (after the pointer field), or null when it doesn't fit one packet. */
function section(p) {
  let o = payloadOffset(p);
  if (o >= PACKET) return null;
  o += 1 + p[o];
  if (o + 3 > PACKET) return null;
  const len = ((p[o + 1] & 0x0f) << 8) | p[o + 2];
  if (o + 3 + len > PACKET) return null;
  return p.subarray(o, o + 3 + len);
}

function parsePat(p) {
  const s = section(p);
  if (!s || s[0] !== 0x00) return null;
  for (let i = 8; i + 4 <= s.length - 4; i += 4) {
    const program = (s[i] << 8) | s[i + 1];
    if (program !== 0) return ((s[i + 2] & 0x1f) << 8) | s[i + 3];
  }
  return null;
}

/** The source program's PCR PID and the streams the output keeps: its first video stream and its audio. */
function parsePmt(p) {
  const s = section(p);
  if (!s || s[0] !== 0x02) return null;
  const pcrPid = ((s[8] & 0x1f) << 8) | s[9];
  const infoLen = ((s[10] & 0x0f) << 8) | s[11];
  const streams = [];
  let video = null;
  for (let i = 12 + infoLen; i + 5 <= s.length - 4; ) {
    const type = s[i];
    const pid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
    const esLen = ((s[i + 3] & 0x0f) << 8) | s[i + 4];
    const descriptors = Buffer.from(s.subarray(i + 5, i + 5 + esLen));
    i += 5 + esLen;
    let audio = AUDIO_TYPES.has(type);
    if (type === 0x06) for (let d = 0; d + 2 <= descriptors.length; d += 2 + descriptors[d + 1]) if (AUDIO_DESCRIPTORS.has(descriptors[d])) audio = true;
    if (VIDEO_TYPES.has(type) && !video) video = { type, pid, descriptors };
    else if (audio) streams.push({ type, pid, descriptors });
  }
  return { pcrPid, video, audio: streams.slice(0, MAX_AUDIO) };
}

function psiPacket(pid, sectionBody, cc) {
  const crc = crc32(sectionBody);
  const sec = Buffer.concat([sectionBody, Buffer.from([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])]);
  const p = Buffer.alloc(PACKET, 0xff);
  p[0] = SYNC;
  p[1] = 0x40 | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = 0x10 | (cc & 0x0f);
  p[4] = 0;
  sec.copy(p, 5);
  return p;
}

class TsNormalizer {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.cc = new Map();
    this.version = 0;
    this.layout = null;
    this.lastPcr = null;
    this.lastPcrAt = 0;
    this.lastPts = null;
    this.lastDts = null;
    this.lastPtsByPid = new Map();
    this.dropping = new Set();
    this.format = null;
    this.formatChanged = false;
    this.sinceKeyframe = [];
    this.sinceKeyframeBytes = 0;
    this.sinceKeyframeAt = null;
    this.packetsSincePsi = 0;
    this.startSource();
  }

  /** A new source starts: forget its predecessor's PIDs and clock, and wait for its first keyframe. */
  startSource() {
    this.rest = Buffer.alloc(0);
    this.inPmtPid = null;
    this.inProgram = null;
    this.map = null;
    this.inPcr = null;
    this.offset = null;
    this.gateOpen = false;
    this.pending = null;
    this.sourceFormat = { video: null, audio: null };
    this.sourceAt = this.now();
  }

  nextCc(pid) {
    const c = ((this.cc.get(pid) ?? 15) + 1) & 0x0f;
    this.cc.set(pid, c);
    return c;
  }

  /** The output program for the source's streams: same PIDs always, a new version when the stream types change. */
  setProgram(prog) {
    const map = new Map();
    const out = [];
    if (prog.video) {
      map.set(prog.video.pid, OUT_VIDEO_PID);
      out.push({ ...prog.video, outPid: OUT_VIDEO_PID });
    }
    prog.audio.forEach((a, i) => {
      map.set(a.pid, OUT_AUDIO_PID + i);
      out.push({ ...a, outPid: OUT_AUDIO_PID + i });
    });
    let pcrOut = map.get(prog.pcrPid);
    if (pcrOut === undefined) {
      pcrOut = OUT_PCR_PID;
      map.set(prog.pcrPid, OUT_PCR_PID);
    }
    const layout = JSON.stringify({ pcrOut, streams: out.map((s) => [s.type, s.outPid, s.descriptors.toString("hex")]) });
    if (this.layout !== null && layout !== this.layout) this.version = (this.version + 1) & 0x1f;
    this.layout = layout;
    this.map = map;
    this.inProgram = prog;
    this.outStreams = out;
    this.pcrOut = pcrOut;
    this.videoPid = prog.video ? prog.video.pid : null;
    this.firstAudio = prog.audio.length ? prog.audio[0] : null;
    this.sourceFormat.video = prog.video ? prog.video.type : "none";
    this.hevc = !!prog.video && prog.video.type === HEVC_TYPE;
  }

  psi() {
    const pat = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1 | (this.version << 1), 0x00, 0x00, 0x00, 0x01, 0xe0 | (OUT_PMT_PID >> 8), OUT_PMT_PID & 0xff]);
    const es = [];
    for (const s of this.outStreams) {
      es.push(Buffer.from([s.type, 0xe0 | (s.outPid >> 8), s.outPid & 0xff, 0xf0 | (s.descriptors.length >> 8), s.descriptors.length & 0xff]), s.descriptors);
    }
    const esBuf = Buffer.concat(es);
    const len = 9 + esBuf.length + 4;
    const pmt = Buffer.concat([
      Buffer.from([0x02, 0xb0 | (len >> 8), len & 0xff, 0x00, 0x01, 0xc1 | (this.version << 1), 0x00, 0x00, 0xe0 | (this.pcrOut >> 8), this.pcrOut & 0xff, 0xf0, 0x00]),
      esBuf,
    ]);
    this.packetsSincePsi = 0;
    return [psiPacket(PAT_PID, pat, this.nextCc(PAT_PID)), psiPacket(OUT_PMT_PID, pmt, this.nextCc(OUT_PMT_PID))];
  }

  /**
   * Sets the clock offset for this source so both its clock and its timestamps carry on past the last source's:
   * the later of the two offsets, since sources buffer different amounts ahead of their clock.
   */
  fixOffset(firstPcr, first) {
    if (this.lastPcr === null) {
      this.offset = 0;
      return;
    }
    const options = [];
    if (firstPcr !== null) options.push(wrap(this.lastPcr + SWITCH_GAP - firstPcr));
    if (first && this.lastPts !== null) options.push(wrap(this.lastPts + SWITCH_GAP - first.pts));
    if (first && first.dts !== null && this.lastDts !== null) options.push(wrap(this.lastDts + SWITCH_GAP - first.dts));
    // The latest of them, so the clock, the PTS and the DTS all move forward.
    this.offset = options.reduce((a, b) => (a === null || ahead(b, a) > 0 ? b : a), null) ?? 0;
  }

  /** Output packets for a chunk of the source's bytes. */
  push(chunk) {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out = [];
    let i = 0;
    while (i + PACKET <= buf.length) {
      if (buf[i] !== SYNC) {
        i++;
        continue;
      }
      this.packet(Buffer.from(buf.subarray(i, i + PACKET)), out);
      i += PACKET;
    }
    this.rest = Buffer.from(buf.subarray(i));
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }

  packet(p, out) {
    const pid = pidOf(p);
    if (pid === PAT_PID) {
      const pmtPid = parsePat(p);
      if (pmtPid !== null) this.inPmtPid = pmtPid;
      return;
    }
    if (pid === this.inPmtPid) {
      const prog = parsePmt(p);
      if (prog && (!this.inProgram || JSON.stringify(prog) !== JSON.stringify(this.inProgram))) {
        this.setProgram(prog);
        if (this.gateOpen) out.push(...this.psi());
      }
      return;
    }
    if (!this.map || !this.map.has(pid)) return;

    const pcr = readPcr(p);
    if (pcr !== null) this.inPcr = pcr;
    if (!this.gateOpen) return this.waitForPicture(p, pid, out);
    this.emit(p, pid, out);
  }

  /**
   * Holds the source's packets from each video PES start until that picture turns out to carry a parameter set,
   * then opens the output there; a PES without one is dropped. After KEYFRAME_WAIT_MS it opens at the next PES.
   */
  waitForPicture(p, pid, out) {
    const noVideo = this.videoPid === null;
    const atVideoStart = pid === this.videoPid && payloadStart(p);
    const late = this.now() - this.sourceAt > KEYFRAME_WAIT_MS;
    if (atVideoStart) this.pending = { packets: [], tail: Buffer.alloc(0), found: late };
    if (!noVideo && !this.pending) return;
    if (this.pending) {
      this.pending.packets.push(p);
      if (pid === this.videoPid && !this.pending.found) {
        const bytes = videoBytes(p);
        this.pending.found = hasParameterSet(this.pending.tail, bytes, this.hevc);
        this.pending.tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 3)));
      }
      if (!this.pending.found || (this.inPcr === null && !late)) return;
    }
    const held = this.pending ? this.pending.packets : [p];
    this.pending = null;
    const first = held[0];
    const ts = pidOf(first) === this.videoPid && payloadStart(first) ? pesTimestamps(first) : null;
    this.fixOffset(this.inPcr, ts ? { pts: readTs(first, ts.pts), dts: ts.dts === null ? null : readTs(first, ts.dts) } : null);
    this.gateOpen = true;
    this.openedAt = this.now();
    this.dropping.clear();
    this.sinceKeyframe = [];
    this.sinceKeyframeBytes = 0;
    this.pes = null;
    this.joinable = false;
    out.push(...this.psi());
    for (const q of held) this.emit(q, pidOf(q), out);
  }

  /** Rewrites one packet of the source onto the output's PIDs, clock and continuity counters. */
  emit(p, pid, out) {
    const pcr = readPcr(p);
    const outPid = this.map.get(pid);
    if (this.overlaps(p, pid, outPid)) return;
    if (this.firstAudio && pid === this.firstAudio.pid && this.sourceFormat.audio === null && payloadStart(p)) this.noteAudio(videoBytes(p));
    p[1] = (p[1] & 0xe0) | ((outPid >> 8) & 0x1f);
    p[2] = outPid & 0xff;
    if (pcr !== null) {
      const t = wrap(pcr + this.offset);
      writePcr(p, t);
      this.lastPcr = t;
      this.lastPcrAt = this.now();
    }
    if (payloadStart(p)) {
      const ts = pesTimestamps(p);
      if (ts) {
        const pts = wrap(readTs(p, ts.pts) + this.offset);
        writeTs(p, ts.pts, pts);
        const dts = ts.dts === null ? pts : wrap(readTs(p, ts.dts) + this.offset);
        if (ts.dts !== null) writeTs(p, ts.dts, dts);
        if (this.lastPts === null || ahead(pts, this.lastPts) > 0) this.lastPts = pts;
        this.lastPtsByPid.set(outPid, pts);
        if (this.lastDts === null || ahead(dts, this.lastDts) > 0) this.lastDts = dts;
      }
    }
    if (hasPayload(p)) p[3] = (p[3] & 0xf0) | this.nextCc(outPid);
    else p[3] = (p[3] & 0xf0) | (this.cc.get(outPid) ?? 0);

    if (++this.packetsSincePsi >= PSI_EVERY_PACKETS) out.push(...this.psi());
    out.push(p);
    this.remember(p, pid);
  }

  /**
   * Records the source's audio format, and flags [formatChanged] when it differs from what the output started
   * with (another sample rate or AAC profile, say): see audioFormat. The relay then restarts the TVs' players.
   */
  noteAudio(bytes) {
    const audio = audioFormat(this.firstAudio.type, bytes);
    if (audio === null) return;
    this.sourceFormat.audio = audio;
    const format = `${this.sourceFormat.video}|${audio}`;
    if (this.format === null) this.format = format;
    else if (format !== this.format) {
      this.format = format;
      this.formatChanged = true;
    }
  }

  /** Whether [p] is part of an audio PES from just after a switch that would play before audio already sent. */
  overlaps(p, pid, outPid) {
    if (pid === this.videoPid || outPid === this.pcrOut) return false;
    if (!payloadStart(p)) return this.dropping.has(outPid);
    this.dropping.delete(outPid);
    if (this.now() - this.openedAt > OVERLAP_MS) return false;
    const ts = pesTimestamps(p);
    const last = this.lastPtsByPid.get(outPid);
    if (!ts || last === undefined || ahead(wrap(readTs(p, ts.pts) + this.offset), last) > 0) return false;
    this.dropping.add(outPid);
    return true;
  }

  /**
   * Keeps the output from the start of the last picture with a parameter set, for TVs that join. The parameter
   * set can be several packets into the picture's PES, so each PES start is marked until that's known.
   */
  remember(p, pid) {
    const video = pid === this.videoPid;
    if (video && payloadStart(p)) this.pes = { at: this.sinceKeyframe.length, tail: Buffer.alloc(0), done: false };
    if (this.sinceKeyframeBytes + PACKET > GOP_CACHE_MAX) {
      this.sinceKeyframe = [];
      this.sinceKeyframeBytes = 0;
      this.joinable = false;
      if (this.pes) this.pes.at = 0;
    }
    this.sinceKeyframe.push(p);
    this.sinceKeyframeBytes += PACKET;
    if (!video || !this.pes || this.pes.done) return;
    const bytes = videoBytes(p);
    if (hasParameterSet(this.pes.tail, bytes, this.hevc)) {
      this.sinceKeyframe = this.sinceKeyframe.slice(this.pes.at);
      this.sinceKeyframeBytes = this.sinceKeyframe.length * PACKET;
      this.pes = { at: 0, tail: Buffer.alloc(0), done: true };
      this.joinable = true;
    } else this.pes.tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 3)));
  }

  /** What a TV joining now gets first: the program table and the output since the last keyframe. */
  joinPrefix() {
    if (!this.gateOpen || !this.outStreams) return Buffer.alloc(0);
    const [pat, pmt] = this.psiCopy();
    return Buffer.concat([pat, pmt, ...(this.joinable ? this.sinceKeyframe : [])]);
  }

  /** The program table without advancing the shared continuity counters (a joining TV starts its own count). */
  psiCopy() {
    const saved = new Map(this.cc);
    const since = this.packetsSincePsi;
    const packets = this.psi();
    this.cc = saved;
    this.packetsSincePsi = since;
    return packets;
  }
}

module.exports = { TsNormalizer, audioFormat, crc32, readPcr, readTs, parsePmt, parsePat, PACKET, OUT_VIDEO_PID, OUT_AUDIO_PID, OUT_PMT_PID };
