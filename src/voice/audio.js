import { stat, readFile, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// Filenames live under audio/<meetingId>/, so userId+startMs is enough and avoids
// the underscore-in-channel-name parsing bug of the old implementation.
export function pcmName(userId, startMs) {
  return `${userId}_${startMs}.pcm`;
}

export function parsePcmName(name) {
  const base = name.replace(/\.pcm$/, '');
  const idx = base.lastIndexOf('_');
  return { userId: base.slice(0, idx), startMs: Number(base.slice(idx + 1)) };
}

// The captured PCM is always s16le/16kHz/mono, so a valid WAV is just this
// 44-byte RIFF/fmt/data header followed by the raw PCM bytes — no ffmpeg needed.
export const CHANNELS = 1;
export const SAMPLE_RATE = 16000;
export const BITS_PER_SAMPLE = 16;
export const BLOCK_ALIGN = (CHANNELS * BITS_PER_SAMPLE) / 8; // 2
export const BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN; // 32000

export function pcmDurationMs(byteLength) {
  return Math.round((Math.max(0, byteLength) / BYTE_RATE) * 1000);
}

export function wavHeader(dataLength) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buf.writeUInt16LE(1, 20); // audio format: 1 = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(BYTE_RATE, 28);
  buf.writeUInt16LE(BLOCK_ALIGN, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

// Stream the PCM into the WAV instead of buffering the whole track in memory.
// The header needs the data length up front, which we get from stat() (the PCM
// is already fully written on disk by capture). A long uninterrupted speaking
// turn can be 100+ MB; the old readFile + Buffer.concat held ~2x that in RAM.
export async function convertPcmToWav(pcmPath, wavPath) {
  const { size } = await stat(pcmPath);
  const out = createWriteStream(wavPath);
  // Concatenate the header stream and the PCM file stream into the WAV. pipeline
  // wires up backpressure, waits for the full flush, and propagates any error
  // (and destroys the streams) so there are no dangling handles or rejections.
  const header = Readable.from([wavHeader(size)]);
  await pipeline(
    async function* () {
      yield* header;
      yield* createReadStream(pcmPath);
    },
    out,
  );
  return wavPath;
}

/**
 * Checks whether a PCM file contains actual voiced speech activity.
 * Discards empty files, short glitches, and files lacking dynamic speech peaks
 * (such as flat background fan/microphone hum). Slices audio into 30ms frames
 * and requires sustained voiced frames.
 */
export async function isVoicedPcm(pcmPath, options = {}) {
  const frameSize = options.frameSize ?? 480; // 30ms at 16kHz mono s16le
  const minVoicedFrames = options.minVoicedFrames ?? 3; // at least 90ms of sustained voiced speech
  const frameRmsThreshold = options.frameRmsThreshold ?? 0.008; // speech energy threshold
  const peakThreshold = options.peakThreshold ?? 0.025; // speech dynamic peak threshold

  let fileStat;
  try {
    fileStat = await stat(pcmPath);
  } catch {
    return false;
  }
  if (!fileStat || fileStat.size < frameSize * minVoicedFrames * 2) return false;

  const buf = await readFile(pcmPath);
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  if (int16.length < frameSize * minVoicedFrames) return false;

  let voicedCount = 0;
  for (let i = 0; i <= int16.length - frameSize; i += frameSize) {
    let sumSq = 0;
    let peak = 0;
    for (let j = i; j < i + frameSize; j++) {
      const s = Math.abs(int16[j]) / 32768;
      sumSq += s * s;
      if (s > peak) peak = s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    // Real voice speech has both energy (RMS) and dynamic contrast (peak)
    if (rms >= frameRmsThreshold && peak >= peakThreshold) {
      voicedCount++;
      if (voicedCount >= minVoicedFrames) return true;
    }
  }
  return false;
}

/**
 * Merges consecutive audio chunks from the same speaker if the gap between them
 * is small, padding with silence so timestamps stay synchronized.
 */
export async function mergeSpeakerTracks(tracks, options = {}) {
  const gapThresholdMs = options.gapThresholdMs ?? 2500;
  const maxDurationMs = options.maxDurationMs ?? 30000;
  const unlinkMerged = options.unlinkMerged ?? true;

  if (!tracks || tracks.length <= 1) return [...(tracks || [])];

  const byUser = new Map();
  for (const t of tracks) {
    if (!byUser.has(t.userId)) byUser.set(t.userId, []);
    byUser.get(t.userId).push(t);
  }

  const mergedTracks = [];

  for (const [userId, userTracks] of byUser) {
    userTracks.sort((a, b) => a.startMs - b.startMs);

    let current = null;

    for (const t of userTracks) {
      const { size } = await stat(t.pcmPath).catch(() => ({ size: 0 }));
      const durMs = pcmDurationMs(size);
      const endMs = t.startMs + durMs;
      const trackWithDur = { ...t, size, endMs };

      if (!current) {
        current = { ...trackWithDur, absorbed: [] };
        continue;
      }

      const gap = trackWithDur.startMs - current.endMs;
      const potentialTotalDur = trackWithDur.endMs - current.startMs;

      if (gap >= 0 && gap <= gapThresholdMs && potentialTotalDur <= maxDurationMs) {
        const silenceSamples = Math.round((gap * SAMPLE_RATE) / 1000);
        const silenceBytes = Buffer.alloc(silenceSamples * BLOCK_ALIGN);
        const nextBytes = await readFile(t.pcmPath);

        const out = createWriteStream(current.pcmPath, { flags: 'a' });
        await new Promise((resolve, reject) => {
          out.write(silenceBytes, (err1) => {
            if (err1) return reject(err1);
            out.write(nextBytes, (err2) => {
              if (err2) return reject(err2);
              out.end(resolve);
            });
          });
        });

        current.endMs = trackWithDur.endMs;
        current.size += silenceBytes.length + nextBytes.length;
        current.absorbed.push(t.pcmPath);
      } else {
        mergedTracks.push(current);
        current = { ...trackWithDur, absorbed: [] };
      }
    }

    if (current) {
      mergedTracks.push(current);
    }
  }

  if (unlinkMerged) {
    for (const m of mergedTracks) {
      if (m.absorbed?.length) {
        for (const p of m.absorbed) {
          await unlink(p).catch(() => {});
        }
      }
    }
  }

  return mergedTracks
    .map(({ absorbed, size, endMs, ...rest }) => rest)
    .sort((a, b) => a.startMs - b.startMs);
}

