import { describe, expect, test } from "bun:test";
import { audioContentType } from "../src/utils/audioContentType";

describe("audioContentType", () => {
  test("maps stored extensions to the matching audio type", () => {
    expect(audioContentType("audio/Song.opus")).toBe("audio/ogg; codecs=opus");
    expect(audioContentType("audio/Song.ogg")).toBe("audio/ogg; codecs=opus");
    expect(audioContentType("audio/Song.m4a")).toBe("audio/mp4");
    expect(audioContentType("audio/Song.mp4")).toBe("audio/mp4");
    expect(audioContentType("audio/Song.webm")).toBe("audio/webm");
    expect(audioContentType("audio/Song.mp3")).toBe("audio/mpeg");
  });

  test("ignores extension case and falls back to octet-stream", () => {
    expect(audioContentType("audio/Song.OPUS")).toBe("audio/ogg; codecs=opus");
    expect(audioContentType("audio/Song.flac")).toBe("application/octet-stream");
    expect(audioContentType("audio/Song")).toBe("application/octet-stream");
  });
});
