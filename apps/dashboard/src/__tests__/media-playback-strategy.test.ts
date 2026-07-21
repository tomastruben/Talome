import { describe, expect, it } from "vitest";
import {
  chooseLocalPlaybackStrategy,
  initialPlaybackMode,
} from "@/components/files/media-player/helpers";

describe("media playback strategy", () => {
  const chrome = { safari: false, hevc: false };

  it("starts browser-native movie containers without waiting for analysis", () => {
    expect(initialPlaybackMode("Movie.mp4")).toBe("direct");
    expect(initialPlaybackMode("Movie.mkv")).toBe("deciding");
  });

  it("direct plays H.264 MP4 with native AAC audio", () => {
    expect(chooseLocalPlaybackStrategy({
      videoCodec: "h264",
      audio: [{ codec: "aac" }],
      videoColorTransfer: "bt709",
      videoPixFmt: "yuv420p",
    }, "Movie.mp4", chrome)).toEqual({
      mode: "direct",
      ready: true,
      needsOptimization: false,
    });
  });

  it("uses streaming HLS instead of whole-file transmux for AC-3 audio", () => {
    expect(chooseLocalPlaybackStrategy({
      videoCodec: "h264",
      audio: [{ codec: "ac3" }],
      videoColorTransfer: "bt709",
      videoPixFmt: "yuv420p",
    }, "Send Help.mp4", chrome).mode).toBe("hls");
  });

  it("keeps compatible MKV on the lightweight remux path", () => {
    expect(chooseLocalPlaybackStrategy({
      videoCodec: "h264",
      audio: [{ codec: "aac" }],
      videoColorTransfer: "bt709",
      videoPixFmt: "yuv420p",
    }, "Movie.mkv", chrome).mode).toBe("direct-mkv");
  });

  it("transcodes HDR HEVC through HLS", () => {
    expect(chooseLocalPlaybackStrategy({
      videoCodec: "hevc",
      audio: [{ codec: "aac" }],
      videoColorTransfer: "smpte2084",
      videoPixFmt: "yuv420p10le",
    }, "Movie.mkv", { safari: true, hevc: true }).mode).toBe("hls");
  });
});
