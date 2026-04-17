const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveProfile } = require("../profiles.js");

test("pal profile is the default when PROFILE is unset", () => {
  const cfg = resolveProfile({});
  assert.equal(cfg.width, 720);
  assert.equal(cfg.height, 576);
  assert.equal(cfg.framerate, "25");
  assert.equal(cfg.videoCodec, "mpeg2video");
  assert.equal(cfg.audioCodec, "mp2");
  assert.equal(cfg.sar, "12/11");
  assert.equal(cfg.interlaced, true);
  assert.equal(cfg.format, "mpegts");
  assert.equal(cfg.profile, "pal");
});

test("ntsc profile", () => {
  const cfg = resolveProfile({ PROFILE: "ntsc" });
  assert.equal(cfg.width, 720);
  assert.equal(cfg.height, 480);
  assert.equal(cfg.framerate, "29.97");
  assert.equal(cfg.sar, "10/11");
  assert.equal(cfg.interlaced, true);
});

test("720p profile", () => {
  const cfg = resolveProfile({ PROFILE: "720p" });
  assert.equal(cfg.width, 1280);
  assert.equal(cfg.height, 720);
  assert.equal(cfg.videoCodec, "libx264");
  assert.equal(cfg.audioCodec, "aac");
  assert.equal(cfg.interlaced, false);
});

test("1080p profile", () => {
  const cfg = resolveProfile({ PROFILE: "1080p" });
  assert.equal(cfg.width, 1920);
  assert.equal(cfg.height, 1080);
});

test("hls profile", () => {
  const cfg = resolveProfile({ PROFILE: "hls" });
  assert.equal(cfg.format, "hls");
  assert.equal(cfg.videoCodec, "libx264");
});

test("unknown profile falls back to pal", () => {
  const cfg = resolveProfile({ PROFILE: "nope" });
  assert.equal(cfg.profile, "pal");
});

test("env overrides take precedence over profile defaults", () => {
  const cfg = resolveProfile({
    PROFILE: "pal",
    WIDTH: "640",
    HEIGHT: "480",
    FRAMERATE: "24",
    VIDEO_CODEC: "libx264",
    AUDIO_CODEC: "aac",
    VIDEO_BITRATE: "3000k",
    AUDIO_BITRATE: "192k",
    SAR: "1/1",
    INTERLACED: "false",
    FORMAT: "mpegts",
  });
  assert.equal(cfg.width, 640);
  assert.equal(cfg.height, 480);
  assert.equal(cfg.framerate, "24");
  assert.equal(cfg.videoCodec, "libx264");
  assert.equal(cfg.audioCodec, "aac");
  assert.equal(cfg.videoBitrate, "3000k");
  assert.equal(cfg.audioBitrate, "192k");
  assert.equal(cfg.sar, "1/1");
  assert.equal(cfg.interlaced, false);
});

test("INTERLACED env parses 'true' / 'false' strings", () => {
  assert.equal(resolveProfile({ INTERLACED: "true" }).interlaced, true);
  assert.equal(resolveProfile({ INTERLACED: "false" }).interlaced, false);
});

test("gop is derived as framerate/2 rounded", () => {
  assert.equal(resolveProfile({ PROFILE: "pal" }).gop, 13); // 25/2 = 12.5 → 13
  assert.equal(resolveProfile({ PROFILE: "ntsc" }).gop, 15); // 29.97/2 ≈ 14.985 → 15
  assert.equal(resolveProfile({ PROFILE: "720p" }).gop, 15);
});
