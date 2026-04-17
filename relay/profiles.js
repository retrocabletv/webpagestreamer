// Profile resolution: picks a base config by PROFILE env var and applies
// any explicit overrides. Pure function — no side effects, no process access.

const PROFILES = {
  pal: {
    width: 720, height: 576, framerate: "25",
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "12/11", interlaced: true, format: "mpegts",
  },
  ntsc: {
    width: 720, height: 480, framerate: "29.97",
    videoCodec: "mpeg2video", audioCodec: "mp2",
    videoBitrate: "5000k", audioBitrate: "256k",
    sar: "10/11", interlaced: true, format: "mpegts",
  },
  "720p": {
    width: 1280, height: 720, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
  "1080p": {
    width: 1920, height: 1080, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "5000k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "mpegts",
  },
  hls: {
    width: 1280, height: 720, framerate: "30",
    videoCodec: "libx264", audioCodec: "aac",
    videoBitrate: "2500k", audioBitrate: "128k",
    sar: "1/1", interlaced: false, format: "hls",
  },
};

function resolveProfile(env) {
  const requested = env.PROFILE || "pal";
  const profile = PROFILES[requested] ? requested : "pal";
  const base = PROFILES[profile];

  const framerate = env.FRAMERATE || base.framerate;
  const width = env.WIDTH ? parseInt(env.WIDTH, 10) : base.width;
  const height = env.HEIGHT ? parseInt(env.HEIGHT, 10) : base.height;

  const interlaced = env.INTERLACED !== undefined
    ? env.INTERLACED === "true"
    : base.interlaced;

  const gop = Math.round(parseFloat(framerate) / 2);

  return {
    profile,
    width,
    height,
    framerate,
    gop,
    videoCodec: env.VIDEO_CODEC || base.videoCodec,
    audioCodec: env.AUDIO_CODEC || base.audioCodec,
    videoBitrate: env.VIDEO_BITRATE || base.videoBitrate,
    audioBitrate: env.AUDIO_BITRATE || base.audioBitrate,
    sar: env.SAR || base.sar,
    interlaced,
    format: env.FORMAT || base.format,
  };
}

module.exports = { resolveProfile };
