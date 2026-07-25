import { describe, expect, it } from "vitest";
import {
  audioSwitchPosition,
  channelLabel,
  chooseLocalPlaybackStrategy,
  defaultAudioTrackIndex,
  initialPlaybackMode,
  langLabel,
  trackLabel,
} from "@/components/files/media-player/helpers";

describe("media playback strategy", () => {
  const chrome = { safari: false, hevc: false };

  it("waits for codec metadata before mounting a normal media source", () => {
    expect(initialPlaybackMode("Movie.mp4")).toBe("deciding");
    expect(initialPlaybackMode("Movie.mkv")).toBe("deciding");
    expect(initialPlaybackMode("Movie.mp4", true)).toBe("direct");
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

  it("uses the container default audio track instead of assuming track zero", () => {
    expect(defaultAudioTrackIndex([
      { index: 0, isDefault: false },
      { index: 1, isDefault: true },
    ])).toBe(1);
    expect(defaultAudioTrackIndex([{ index: 3 }])).toBe(3);
    expect(defaultAudioTrackIndex([])).toBe(0);
  });

  it("keeps an absolute playback position while restarting HLS for a language", () => {
    expect(audioSwitchPosition("hls", 12.5, 120, 0)).toBe(132.5);
    expect(audioSwitchPosition("direct", 132.5, 120, 0)).toBe(132.5);
    expect(audioSwitchPosition("jellyfin-hls", 132.5, 120, 0)).toBe(132.5);
    expect(audioSwitchPosition("hls", Number.NaN, 120, 132.5)).toBe(132.5);
  });

  it("shows useful language and channel names for multilingual tracks", () => {
    expect(langLabel("ces-CZ")).toBe("Czech");
    expect(langLabel("slo")).toBe("Slovak");
    expect(trackLabel({ index: 1, language: "jpn", title: "Original" }, "Audio"))
      .toBe("Japanese · Original");
    expect(channelLabel(1)).toBe("Mono");
    expect(channelLabel(2)).toBe("Stereo");
    expect(channelLabel(6)).toBe("5.1");
    expect(channelLabel(8)).toBe("7.1");
  });
});
