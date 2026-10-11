import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcmName, parsePcmName, wavHeader, convertPcmToWav, pcmDurationMs, isVoicedPcm, mergeSpeakerTracks } from '../src/voice/audio.js';

test('pcmName + parsePcmName roundtrip (userId may contain no underscores)', () => {
  const name = pcmName('123', 4567);
  assert.equal(name, '123_4567.pcm');
  assert.deepEqual(parsePcmName(name), { userId: '123', startMs: 4567 });
});

test('pcmDurationMs accurately calculates duration from byte length', () => {
  assert.equal(pcmDurationMs(32000), 1000);
  assert.equal(pcmDurationMs(16000), 500);
  assert.equal(pcmDurationMs(0), 0);
});

test('isVoicedPcm detects silence vs voiced PCM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-vad-'));
  try {
    const silentPath = join(dir, 'silent.pcm');
    const voicedPath = join(dir, 'voiced.pcm');
    const emptyPath = join(dir, 'empty.pcm');

    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(silentPath, Buffer.alloc(3200, 0)); // 100ms of zeros

    // Create 100ms of a sine wave (3200 bytes = 1600 samples)
    const voicedBuf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      const val = Math.round(Math.sin((i / 16) * 2 * Math.PI) * 10000);
      voicedBuf.writeInt16LE(val, i * 2);
    }
    await writeFile(voicedPath, voicedBuf);

    assert.equal(await isVoicedPcm(emptyPath), false);
    assert.equal(await isVoicedPcm(silentPath), false);
    assert.equal(await isVoicedPcm(voicedPath), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeSpeakerTracks merges close segments for the same speaker and preserves ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-merge-'));
  try {
    const pcm1 = join(dir, 'userA_1000.pcm');
    const pcm2 = join(dir, 'userA_2500.pcm'); // 500ms after end of pcm1 (pcm1 is 32000 bytes = 1000ms, ends at 2000ms)
    const pcm3 = join(dir, 'userB_1500.pcm');

    await writeFile(pcm1, Buffer.alloc(32000, 1));
    await writeFile(pcm2, Buffer.alloc(16000, 2));
    await writeFile(pcm3, Buffer.alloc(16000, 3));

    const tracks = [
      { userId: 'userA', pcmPath: pcm1, startMs: 1000 },
      { userId: 'userB', pcmPath: pcm3, startMs: 1500 },
      { userId: 'userA', pcmPath: pcm2, startMs: 2500 },
    ];

    const merged = await mergeSpeakerTracks(tracks, { gapThresholdMs: 2000, unlinkMerged: false });
    assert.equal(merged.length, 2);
    const userATrack = merged.find((t) => t.userId === 'userA');
    assert.ok(userATrack);
    assert.equal(userATrack.startMs, 1000);
    assert.equal(userATrack.pcmPath, pcm1);

    const buf = await readFile(pcm1);
    // 32000 + (500ms silence = 16000 bytes) + 16000 = 64000 bytes
    assert.equal(buf.length, 64000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wavHeader builds a valid 44-byte RIFF/WAVE header for 16k mono s16', () => {
  const dataLength = 1000;
  const buf = wavHeader(dataLength);
  assert.equal(buf.length, 44);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + dataLength);
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(buf.readUInt16LE(20), 1); // PCM format
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), 16000); // sample rate
  assert.equal(buf.readUInt32LE(28), 32000); // byte rate
  assert.equal(buf.readUInt16LE(32), 2); // block align
  assert.equal(buf.readUInt16LE(34), 16); // bits per sample
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), dataLength);
});

test('convertPcmToWav writes a header + raw PCM bytes to wavPath', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-test-'));
  try {
    const pcmPath = join(dir, 'in.pcm');
    const wavPath = join(dir, 'out.wav');
    const pcm = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
    await writeFile(pcmPath, pcm);

    const result = await convertPcmToWav(pcmPath, wavPath);
    assert.equal(result, wavPath);

    const out = await readFile(wavPath);
    assert.equal(out.length, 44 + pcm.length);
    assert.deepEqual(out.subarray(0, 44), wavHeader(pcm.length));
    assert.deepEqual(out.subarray(44), pcm);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('convertPcmToWav streams a large PCM correctly (header length + bytes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-big-'));
  try {
    const pcmPath = join(dir, 'big.pcm');
    const wavPath = join(dir, 'big.wav');
    // ~5 MB — exercises the streaming path across many chunks.
    const pcm = Buffer.alloc(5 * 1024 * 1024, 0xab);
    await writeFile(pcmPath, pcm);
    await convertPcmToWav(pcmPath, wavPath);
    const out = await readFile(wavPath);
    assert.equal(out.length, 44 + pcm.length);
    assert.deepEqual(out.subarray(0, 44), wavHeader(pcm.length));
    assert.equal(out.readUInt32LE(40), pcm.length); // data chunk length matches
    assert.deepEqual(out.subarray(44, 44 + 8), pcm.subarray(0, 8));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('convertPcmToWav handles an empty PCM (silent track)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-empty-'));
  try {
    const pcmPath = join(dir, 'empty.pcm');
    const wavPath = join(dir, 'empty.wav');
    await writeFile(pcmPath, Buffer.alloc(0));
    await convertPcmToWav(pcmPath, wavPath);
    const out = await readFile(wavPath);
    assert.equal(out.length, 44);
    assert.equal(out.readUInt32LE(40), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
