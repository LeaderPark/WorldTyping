#!/usr/bin/env node
// 자체 생성 사운드 스프라이트 톤 신디사이저.
// 라이선스: 전량 이 스크립트가 사인/삼각/사각파로 합성한 것 — 외부 다운로드/에셋 없음
// (WT-M2-07 세션 환경 어댑테이션 3항: "node 스크립트로 자체 합성한 짧은 톤(WAV/webm) …
// 라이선스 주석: 자체 생성"). 포맷은 WAV(16-bit PCM mono) — Web Audio decodeAudioData가
// 별도 코덱 없이 디코드 가능하다(§8.2 "포맷은 decodeAudioData 가능한 것으로").
//
// spec: docs/01 §13.1(오디오 표), docs/03 §8.2(사운드 스프라이트 전략), WT-M2-07,
//       docs/09 §7.8(chase SFX 총괄표), WT-CH-07(2번째 시트 등록)
//
// apps/web/src/audio/sprite-layout.json이 5모드 공용 시트의 유일한 레이아웃 원천이다 — 이
// 스크립트와 apps/web/src/audio/sprites.ts(런타임 오프셋 계산) 둘 다 그 JSON을 읽는다.
// WT-CH-07이 chase 전용 2번째 시트(apps/web/src/audio/chase-sprite-layout.json →
// chase-sprite.wav, apps/web/src/audio/chase-sprites.ts가 오프셋 계산)를 등록했다 — chase를
// 플레이하지 않는 4개 모드의 sprite.wav를 그대로 유지(바이트 동일)하기 위해 기존 시트를 확장하지
// 않고 별도 파일로 분리했다(chase-sprites.ts 헤더 주석 참조). 재생성 시
// `node tooling/scripts/generate-sound-sprite.mjs` — 두 시트 모두 재생성된다(SHEETS 배열).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIO_SRC_DIR = path.join(REPO_ROOT, 'apps/web/src/audio');
const OUT_DIR = path.join(REPO_ROOT, 'apps/web/public/sounds');

/** 시트 목록 — layoutPath(JSON 레이아웃 원천) → outName(public/sounds 산출 파일명). 신규 시트
 *  추가 시 이 배열에 1행만 더하면 된다(로직 변경 불요). */
const SHEETS = [
  { layoutPath: path.join(AUDIO_SRC_DIR, 'sprite-layout.json'), outName: 'sprite.wav' },
  { layoutPath: path.join(AUDIO_SRC_DIR, 'chase-sprite-layout.json'), outName: 'chase-sprite.wav' },
];

/** 짧은 톤이라 순간 위상 근사(선형 주파수 스윕)로 충분하다 — 클릭/차임/비프류는 위상 연속성
 *  오차가 가청 아티팩트로 드러나기엔 지속시간이 너무 짧다(<0.5s). */
function synthTone(region, sampleRate) {
  const n = Math.max(1, Math.round(region.durationSec * sampleRate));
  const samples = new Float32Array(n);
  const attackN = Math.round(region.attackSec * sampleRate);
  const releaseN = Math.round(region.releaseSec * sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
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

function silenceSamples(durationSec, sampleRate) {
  return new Float32Array(Math.max(0, Math.round(durationSec * sampleRate)));
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

/** 시트 1개(JSON 레이아웃 → WAV)를 합성해 OUT_DIR에 쓴다. 두 시트가 완전히 동일한 코드 경로를
 *  타므로(SAMPLE_RATE/gapSec을 시트 자신의 JSON에서 읽음) 기존 sprite.wav 산출 로직은 파라미터화만
 *  됐을 뿐 바이트 결과가 이전과 동일하다(회귀 0 — synthTone/silenceSamples가 이제 sampleRate를
 *  인자로 받는 것 외에 수식 무변경). */
function buildSheet({ layoutPath, outName }) {
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
  const sampleRate = layout.sampleRate;
  const chunks = [];
  for (const region of layout.regions) {
    chunks.push(synthTone(region, sampleRate));
    chunks.push(silenceSamples(layout.gapSec, sampleRate));
  }
  const all = concatFloat32(chunks);
  writeFileSync(path.join(OUT_DIR, outName), encodeWav(all, sampleRate));
  return { outName, seconds: all.length / sampleRate, regionCount: layout.regions.length };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const results = SHEETS.map(buildSheet);
  // silence.wav는 원래 시트(5모드 공용)와 동일한 샘플레이트 관례를 그대로 따른다(기존 산출물 무변경).
  const primarySampleRate = JSON.parse(readFileSync(SHEETS[0].layoutPath, 'utf8')).sampleRate;
  writeFileSync(
    path.join(OUT_DIR, 'silence.wav'),
    encodeWav(silenceSamples(0.05, primarySampleRate), primarySampleRate),
  );

  for (const r of results) {
    console.log(
      `[generate-sound-sprite] wrote ${r.outName} (${r.seconds.toFixed(3)}s, ${r.regionCount} regions) → ${OUT_DIR}`,
    );
  }
  console.log(`[generate-sound-sprite] wrote silence.wav → ${OUT_DIR}`);
}

main();
