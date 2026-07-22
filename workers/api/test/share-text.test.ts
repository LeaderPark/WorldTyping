// spec: docs/01 §9.1(이모지 그리드 포맷), docs/06 §2.3(shareText 필드), WT-M5-04
import { describe, expect, it } from "vitest";
import { buildDailyShareText } from "../src/lib/share-text";

describe("buildDailyShareText", () => {
  it("완주(10/10, 오타 1건) — ko: 그리드·완주 카운트·CPM/정확도/PI(등급)·/daily 링크", () => {
    const perCountry = [
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 0, skipped: false },
      { errors: 2, skipped: false }, // 🟨
      { errors: 0, skipped: false },
    ];
    const text = buildDailyShareText({
      dailyNo: 187,
      lang: "ko",
      totalCountries: 10,
      perCountry,
      cpm: 412.4,
      accMilli: 962,
      pi: 381.2,
      grade: "A",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("WORLD TYPING 데일리 #187");
    expect(lines[1]).toBe("🟩🟩🟩🟩🟩🟩🟩🟩🟨🟩  10/10 완주");
    expect(lines[2]).toBe("⚡ 412타 · 🎯 96.2% · PI 381 (A)");
    expect(lines[3]).toBe("/daily");
  });

  it("en 로케일 — cleared/cpm 라벨 전환", () => {
    const text = buildDailyShareText({
      dailyNo: 3,
      lang: "en",
      totalCountries: 3,
      perCountry: [
        { errors: 0, skipped: false },
        { errors: 1, skipped: false },
        { errors: 0, skipped: true },
      ],
      cpm: 300,
      accMilli: 900,
      pi: 270,
      grade: "B",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("WORLD TYPING Daily #3");
    expect(lines[1]).toBe("🟩🟨🟥  2/3 cleared");
    expect(lines[2]).toBe("⚡ 300cpm · 🎯 90.0% · PI 270 (B)");
  });

  it("라이프 0 조기 종료(스킵 이후 잔여 칸) — 도달 못한 칸도 🟥로 채운다", () => {
    const text = buildDailyShareText({
      dailyNo: 1,
      lang: "ko",
      totalCountries: 5,
      perCountry: [
        { errors: 0, skipped: false },
        { errors: 0, skipped: false },
        { errors: 0, skipped: true }, // 라이프 0 → 즉시 종료
      ],
      cpm: 200,
      accMilli: 1000,
      pi: 200,
      grade: "C",
    });
    expect(text.split("\n")[1]).toBe("🟩🟩🟥🟥🟥  2/5 완주");
  });

  it("publicOrigin이 주어지면 절대 URL, 없으면 상대 경로", () => {
    const base = {
      dailyNo: 1,
      lang: "ko" as const,
      totalCountries: 1,
      perCountry: [{ errors: 0, skipped: false }],
      cpm: 100,
      accMilli: 1000,
      pi: 100,
      grade: "S",
    };
    expect(buildDailyShareText(base).split("\n").at(-1)).toBe("/daily");
    expect(buildDailyShareText({ ...base, publicOrigin: "https://worldtyping.gg/" }).split("\n").at(-1)).toBe(
      "https://worldtyping.gg/daily",
    );
  });
});
