#!/usr/bin/env node
// 자체 생성 사운드 스프라이트 톤 신디사이저.
// 라이선스: 전량 이 스크립트가 사인/삼각/사각파로 합성한 것 — 외부 다운로드/에셋 없음
// (WT-M2-07 세션 환경 어댑테이션 3항: "node 스크립트로 자체 합성한 짧은 톤(WAV/webm) …
// 라이선스 주석: 자체 생성"). 포맷은 WAV(16-bit PCM mono) — Web Audio decodeAudioData가
// 별도 코덱 없이 디코드 가능하다(§8.2 "포맷은 decodeAudioData 가능한 것으로").
//
// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(사운드 스프라이트 전략), WT-M2-07
//
// apps/web/src/audio/sprite-layout.json이 유일한 레이아웃 원천이다 — 이 스크립트와
// apps/web/src/audio/sprites.ts(런타임 오프셋 계산) 둘 다 그 JSON을 읽는다. 재생성 시
// `node tooling/scripts/generate-sound-sprite.mjs`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAYOUT_PATH = path.join(REPO_ROOT, 'apps/web/src/audio/sprite-layout.json');
const OUT_DIR = path.join(REPO_ROOT, 'apps/web/public/sounds');

const layout = JSON.parse(readFileSync(LAYOUT_PATH, 'utf8'));
const SAMPLE_RATE = layout.sampleRate;

/** 짧은 톤이라 순간 위상 근사(선형 주파수 스윕)로 충분하다 — 클릭/차임/비프류는 위상 연속성
 *  오차가 가청 아티팩트로 드러나기엔 지속시간이 너무 짧다(<0.5s). */
function synthTone(region) {
  const n = Math.max(1, Math.round(region.durationSec * SAMPLE_RATE));
  const samples = new Float32Array(n);
  const attackN = Math.round(region.attackSec * SAMPLE_RATE);
  const releaseN = Math.round(region.releaseSec * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const progress = n > 1 ? i / (n - 1) : 0;
    const freq = region.freqStart + (region.freqEnd - region.freqStart) * progress;
    const phase = 2 * Math.PI * freq * t;
    let raw;
    if (region.wave === 'square') raw = Math.sign(Math.sin(phase)) || 0;
    else if (region.wave === 'triangle') raw = (2 / Math.PI) * Math.asin(Math.sin(phase));
    else raw = Math.sin(phase);

    let env = 1;
    if (i < attackN) env = i / Math.max(1, attackN);
    else if (i > n - releaseN) env = Math.max(0, (n - i) / Math.max(1, releaseN));

    samples[i] = raw * env * region.gain;
  }
  return samples;
}

function silenceSamples(durationSec) {
  return new Float32Array(Math.max(0, Math.round(durationSec * SAMPLE_RATE)));
}

function concatFloat32(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const a of arrays) {
    out.set(a, cursor);
    cursor += a.length;
  }
  return out;
}

/** 16-bit PCM mono WAV 인코딩(외부 의존 없음). */
function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(1, 22); // channels = mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), offset);
    offset += bytesPerSample;
  }
  return buffer;
}

function main() {
  const chunks = [];
  for (const region of layout.regions) {
    chunks.push(synthTone(region));
    chunks.push(silenceSamples(layout.gapSec));
  }
  const all = concatFloat32(chunks);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'sprite.wav'), encodeWav(all, SAMPLE_RATE));
  writeFileSync(path.join(OUT_DIR, 'silence.wav'), encodeWav(silenceSamples(0.05), SAMPLE_RATE));

  console.log(
    `[generate-sound-sprite] wrote sprite.wav (${(all.length / SAMPLE_RATE).toFixed(3)}s, ` +
      `${layout.regions.length} regions) + silence.wav → ${OUT_DIR}`,
  );
}

main();
