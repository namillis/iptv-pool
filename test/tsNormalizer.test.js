const test = require("node:test");
const assert = require("node:assert");
const { TsNormalizer, parsePmt, OUT_VIDEO_PID, OUT_AUDIO_PID, OUT_PMT_PID } = require("../xtream/tsNormalizer");
const { FakeTs, parse } = require("./tsFixture");

function clock(start = 1_800_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** Continuity counters run 0-15 without a gap on every PID that carries payload. */
function assertContinuous(packets) {
  const last = new Map();
  for (const p of packets) {
    if (!p.hasPayload) continue;
    if (last.has(p.pid)) assert.strictEqual(p.cc, (last.get(p.pid) + 1) & 15, `continuity on PID ${p.pid}`);
    last.set(p.pid, p.cc);
  }
}

test("one source keeps its timestamps, moves to fixed PIDs and gets its own program table", () => {
  const n = new TsNormalizer({ now: clock() });
  const src = new FakeTs({ pmtPid: 0x100, videoPid: 0x200, audioPid: 0x300 });
  const out = parse(n.push(src.chunk(20)));
  const pids = new Set(out.map((p) => p.pid));
  assert.deepStrictEqual([...pids].sort((a, b) => a - b), [0, OUT_VIDEO_PID, OUT_AUDIO_PID, OUT_PMT_PID].sort((a, b) => a - b));
  const video = out.filter((p) => p.pid === OUT_VIDEO_PID && p.pts !== null);
  assert.strictEqual(video[0].dts, 1_000_000, "the first source's clock is left alone");
  assertContinuous(out);
});

test("output waits for a keyframe, then starts with the program table", () => {
  const n = new TsNormalizer({ now: clock() });
  const src = new FakeTs({ gop: 10 });
  src.frame = 3; // join mid-GOP: frames 3-9 are not keyframes
  const out = parse(n.push(src.chunk(12)));
  assert.strictEqual(out[0].pid, 0);
  assert.strictEqual(out[1].pid, OUT_PMT_PID);
  const firstVideo = out.find((p) => p.pid === OUT_VIDEO_PID);
  assert.strictEqual(firstVideo.dts, 1_000_000 + 10 * 3000, "the first frame out is the keyframe at frame 10");
});

test("a switch to a source with other PIDs and another clock carries on seamlessly", () => {
  const now = clock();
  const n = new TsNormalizer({ now });
  const a = new FakeTs({ tag: 1, pmtPid: 0x20, videoPid: 0x21, audioPid: 0x22, clock: 5_000_000 });
  const b = new FakeTs({ tag: 2, pmtPid: 0x1100, videoPid: 0x1011, audioPid: 0x1100 + 0x12, clock: 7_777_777_777 });
  const first = n.push(a.chunk(30));
  now.advance(2000);
  n.startSource();
  const second = n.push(b.chunk(30));
  const out = parse(Buffer.concat([first, second]));
  assertContinuous(out);
  assert.ok(out.every((p) => [0, OUT_PMT_PID, OUT_VIDEO_PID, OUT_AUDIO_PID].includes(p.pid)), "the output PIDs never change");

  const video = out.filter((p) => p.pid === OUT_VIDEO_PID && p.dts !== null);
  for (let i = 1; i < video.length; i++) assert.ok(video[i].dts > video[i - 1].dts, `DTS moves forward at frame ${i}`);
  const jump = video.findIndex((p, i) => i && p.dts - video[i - 1].dts !== 3000);
  const gap = video[jump].dts - video[jump - 1].dts;
  assert.ok(gap > 0 && gap <= 2 * 3000, `the next source carries on a frame later, not after a hole (${gap})`);
  const pcrs = out.filter((p) => p.pcr !== null).map((p) => p.pcr);
  for (let i = 1; i < pcrs.length; i++) assert.ok(pcrs[i] > pcrs[i - 1], "the clock moves forward across the switch");
  const tags = out.filter((p) => p.pid === OUT_VIDEO_PID && !p.start).map((p) => p.first);
  assert.strictEqual(tags[0], 1);
  assert.strictEqual(tags[tags.length - 1], 2);
});

test("a TV joining mid-stream starts with the tables and the last keyframe", () => {
  const n = new TsNormalizer({ now: clock() });
  const src = new FakeTs({ gop: 10 });
  n.push(src.chunk(25));
  const join = parse(n.joinPrefix());
  assert.strictEqual(join[0].pid, 0);
  assert.strictEqual(join[1].pid, OUT_PMT_PID);
  const firstVideo = join.find((p) => p.pid === OUT_VIDEO_PID);
  assert.strictEqual(firstVideo.dts, 1_000_000, "from the first keyframe: less than the backlog has played");

  // 20 s of video (frames are 1/30 s): a joining TV gets about the last 8 s, starting on a keyframe.
  n.push(Buffer.concat(Array.from({ length: 600 }, () => Buffer.concat(src.frameOut()))));
  const later = parse(n.joinPrefix()).filter((p) => p.pid === OUT_VIDEO_PID && p.dts !== null);
  const span = (later[later.length - 1].dts - later[0].dts) / 90000;
  assert.ok(span >= 8 && span < 9, `the backlog covers about 8 s (${span.toFixed(2)})`);
  assert.strictEqual((later[0].dts - 1_000_000) % (10 * 3000), 0, "and starts on a keyframe");
  const after = parse(n.push(Buffer.concat(src.frameOut())));
  assert.ok(after.length > 0);
});

test("the program table it writes parses back with the fixed PIDs", () => {
  const n = new TsNormalizer({ now: clock() });
  const out = n.push(new FakeTs().chunk(12));
  const pmtPacket = out.subarray(188, 376);
  const prog = parsePmt(pmtPacket);
  assert.strictEqual(prog.video.pid, OUT_VIDEO_PID);
  assert.strictEqual(prog.video.type, 0x1b);
  assert.deepStrictEqual(prog.audio.map((a) => [a.pid, a.type]), [[OUT_AUDIO_PID, 0x0f]]);
  assert.strictEqual(prog.pcrPid, OUT_VIDEO_PID);
});

test("bytes split anywhere still come out as whole packets", () => {
  const n = new TsNormalizer({ now: clock() });
  const all = new FakeTs().chunk(20);
  const parts = [];
  for (let i = 0; i < all.length; i += 1000) parts.push(n.push(all.subarray(i, i + 1000)));
  const out = Buffer.concat(parts);
  assert.strictEqual(out.length % 188, 0);
  assertContinuous(parse(out));
});

test("audioFormat reads an ADTS header, and a switch to other audio is flagged", () => {
  const adts = (profile, rate) => Buffer.from([0xff, 0xf1, (profile << 6) | (rate << 2), 0x80, 0, 0, 0]);
  assert.strictEqual(require("../xtream/tsNormalizer").audioFormat(0x0f, adts(1, 3)), "aac 1/3/2");
  assert.strictEqual(require("../xtream/tsNormalizer").audioFormat(0x0f, Buffer.from([1, 2, 3])), null);

  const now = clock();
  const n = new TsNormalizer({ now });
  const withAudio = (src, profile) => {
    const chunk = src.chunk(12);
    // Put an ADTS header at the start of every audio PES payload.
    for (let i = 0; i < chunk.length; i += 188) {
      const pid = ((chunk[i + 1] & 0x1f) << 8) | chunk[i + 2];
      if (pid === src.audioPid && chunk[i + 1] & 0x40) adts(profile, 3).copy(chunk, i + 4 + 14);
    }
    return chunk;
  };
  n.push(withAudio(new FakeTs({ clock: 1_000_000 }), 1));
  assert.strictEqual(n.formatChanged, false);
  n.startSource();
  n.push(withAudio(new FakeTs({ clock: 9_000_000 }), 1));
  assert.strictEqual(n.formatChanged, false, "same audio on the next source");
  n.startSource();
  n.push(withAudio(new FakeTs({ clock: 5_000_000 }), 0));
  assert.strictEqual(n.formatChanged, true, "another AAC profile");
});
