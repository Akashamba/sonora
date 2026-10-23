import { describe, expect, test } from "bun:test";
import { trackFileName } from "../src/utils/audioPath";
import { ytDlpDownloadArgs } from "../src/utils/fetchAudio";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

describe("trackFileName", () => {
  test("keeps the title readable and appends the YouTube id before .opus", () => {
    expect(trackFileName("Uber Everywhere", "eImirstTOyE")).toBe(
      "Uber_Everywhere_eImirstTOyE.opus",
    );
  });

  test("two different videos with the same title get different file names", () => {
    const first = trackFileName("Uber Everywhere", "eImirstTOyE");
    const second = trackFileName("Uber Everywhere", "GKpIQsUoYO8");
    expect(first).not.toBe(second);
  });

  test("a very long title is truncated but still ends in _<id>.opus within 255 bytes", () => {
    const name = trackFileName("A".repeat(400), "eImirstTOyE");
    expect(name.endsWith("_eImirstTOyE.opus")).toBe(true);
    expect(byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).toBe(`${"A".repeat(238)}_eImirstTOyE.opus`);
  });

  test("multi-byte titles are cut by bytes without splitting a character", () => {
    const name = trackFileName("é".repeat(300), "eImirstTOyE");
    expect(name.endsWith("_eImirstTOyE.opus")).toBe(true);
    expect(byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).not.toContain("�");
  });

  test("a title with / is sanitized and a title with % is kept", () => {
    expect(trackFileName("AC/DC: Back in Black", "eImirstTOyE")).toBe(
      "ACDC_Back_in_Black_eImirstTOyE.opus",
    );
    expect(trackFileName("100% Pure", "GKpIQsUoYO8")).toBe(
      "100%_Pure_GKpIQsUoYO8.opus",
    );
  });

  test("a title with % still produces a valid yt-dlp output template", () => {
    const filePath = `audio/${trackFileName("100% Pure", "GKpIQsUoYO8")}`;
    const args = ytDlpDownloadArgs("u", filePath);
    expect(args[args.indexOf("-o") + 1]).toBe(
      "audio/100%%_Pure_GKpIQsUoYO8.%(ext)s",
    );
  });
});
