// Capture flow:
//   chrome.tabCapture → MediaStream (audio + video tracks)
//   MediaStreamTrackProcessor(video) → VideoFrame stream → I420 bytes → WS /ingest/video
//   MediaStreamTrackProcessor(audio) → AudioData stream → f32le bytes → WS /ingest/audio
//
// Wire protocol (per-message, no inner framing):
//   video: width*height*3/2 bytes, planes Y U V concatenated (I420)
//   audio: variable-length f32le interleaved stereo at 44.1 kHz

(function () {
  let stream = null;
  let videoSession = 0;
  let audioSession = 0;

  function hideScrollbars() {
    const style = document.createElement("style");
    style.textContent = `
      html, body { overflow: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
      video::-webkit-media-controls,
      video::-webkit-media-controls-overlay-play-button,
      video::-webkit-media-controls-enclosure { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  // Previously we toggled an invisible div via requestAnimationFrame at 60Hz
  // to keep Chromium's compositor producing frames on static pages. With
  // tabCapture's MediaStreamTrackProcessor that's no longer needed — the
  // capture pipeline produces frames at the requested rate from compositor
  // output regardless. Keeping the rAF tick was actively harmful: it dragged
  // the compositor up to 60Hz, made the capture stream burst at 60fps, and
  // forced our intake throttle to drop ~40% of frames chaotically.
  function forceFrames() { /* intentionally a no-op */ }

  async function getTabStream(width, height, framerate) {
    const response = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ command: "get-stream-id" }, resolve)
    );
    if (!response || response.error) {
      throw new Error(`get-stream-id failed: ${response && response.error}`);
    }
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: response.streamId } },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
          minFrameRate: framerate, maxFrameRate: framerate,
          minWidth: width, maxWidth: width,
          minHeight: height, maxHeight: height,
        },
      },
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // Open a WebSocket; retry forever on failure with 2s backoff.
  async function openWS(url) {
    while (true) {
      try {
        const ws = await new Promise((res, rej) => {
          const s = new WebSocket(url);
          s.binaryType = "arraybuffer";
          s.addEventListener("open", () => res(s), { once: true });
          s.addEventListener("error", (e) => rej(e), { once: true });
        });
        return ws;
      } catch (e) {
        console.warn(`[capture] WS connect to ${url} failed, retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async function packI420(frame) {
    const W = frame.codedWidth, H = frame.codedHeight;
    const ySize = W * H;
    const uvSize = (W / 2) * (H / 2);
    const buf = new Uint8Array(ySize + 2 * uvSize);
    await frame.copyTo(buf, {
      layout: [
        { offset: 0,                 stride: W },
        { offset: ySize,             stride: W / 2 },
        { offset: ySize + uvSize,    stride: W / 2 },
      ],
    });
    return buf.buffer;
  }

  // Pump VideoFrames → WS, capping outflow at the target framerate. The
  // browser's compositor can deliver frames faster than the requested rate
  // (especially with active CSS animations or playing video elements), but
  // the relay's fifo to ffmpeg drains at exactly `framerate`. Throttle here
  // rather than letting the WS buffer and TCP backpressure handle it
  // chaotically downstream.
  async function pumpVideo(track, ws, mySession, framerate) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    // Browser compositor can produce frames faster than `framerate` (e.g.
    // when forceFrames' rAF runs at 60 Hz), but the relay's fifo to ffmpeg
    // can only drain at `framerate`. Drop overshoots cleanly at intake
    // rather than letting them queue and chaotically drop at the WS buffer.
    const minIntervalMs = 1000 / framerate;
    let nextSendTime = 0;
    let droppedRate = 0;
    let droppedBackpressure = 0;
    let framesReceived = 0;
    let framesSent = 0;
    let lastReport = performance.now();
    try {
      while (mySession === videoSession && ws.readyState === WebSocket.OPEN) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        framesReceived++;
        try {
          const now = performance.now();
          // Allow a half-interval of slack so a frame arriving 5ms early
          // isn't dropped (browser delivery isn't perfectly metronomic).
          if (now + minIntervalMs / 2 < nextSendTime) {
            droppedRate++;
            continue;
          }
          // We're past the rate gate — claim this slot regardless of whether
          // the send below succeeds. Otherwise a backpressure drop leaves
          // nextSendTime frozen and the next 80 frames all sail through the
          // rate check and slam into backpressure again.
          nextSendTime = Math.max(now + minIntervalMs, nextSendTime + minIntervalMs);
          const ab = await packI420(frame);
          if (ws.bufferedAmount > ab.byteLength * 4) {
            droppedBackpressure++;
            continue;
          }
          ws.send(ab);
          framesSent++;
        } finally {
          frame.close();
        }
        const now = performance.now();
        if (now - lastReport >= 1000) {
          console.log(`[capture] video rate: rcv=${framesReceived}/s sent=${framesSent}/s rate-drop=${droppedRate} bp-drop=${droppedBackpressure}`);
          framesReceived = 0; framesSent = 0; droppedRate = 0; droppedBackpressure = 0; lastReport = now;
        }
      }
    } finally {
      try { reader.cancel(); } catch (e) {}
    }
  }

  function copyAudioToInterleavedF32(chunk) {
    const frames = chunk.numberOfFrames;
    const channels = chunk.numberOfChannels;
    const interleaved = new Float32Array(frames * channels);

    if (chunk.format && chunk.format.endsWith("-planar")) {
      const planes = [];
      for (let channel = 0; channel < channels; channel++) {
        const plane = new Float32Array(frames);
        chunk.copyTo(plane, { planeIndex: channel });
        planes.push(plane);
      }
      for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels; channel++) {
          interleaved[frame * channels + channel] = planes[channel][frame];
        }
      }
    } else {
      chunk.copyTo(interleaved, { planeIndex: 0 });
    }

    return interleaved.buffer;
  }

  async function pumpAudio(track, ws, mySession) {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    try {
      while (mySession === audioSession && ws.readyState === WebSocket.OPEN) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        try {
          ws.send(copyAudioToInterleavedF32(chunk));
        } finally {
          chunk.close();
        }
      }
    } finally {
      try { reader.cancel(); } catch (e) {}
    }
  }

  // (Re)open the video WS and pump until it closes; then loop again.
  async function videoLoop(track, vURL, framerate) {
    while (true) {
      const mySession = ++videoSession;
      const ws = await openWS(vURL);
      console.log("[capture] video WS connected");
      ws.addEventListener("close", () => console.log("[capture] video WS closed — will reconnect"));
      await pumpVideo(track, ws, mySession, framerate);
      // Either the WS closed or the track ended. If track ended, exit.
      if (track.readyState === "ended") {
        console.warn("[capture] video track ended — bailing out of loop");
        return;
      }
      // Small backoff before reconnecting.
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function audioLoop(track, aURL) {
    while (true) {
      const mySession = ++audioSession;
      const ws = await openWS(aURL);
      console.log("[capture] audio WS connected");
      ws.addEventListener("close", () => console.log("[capture] audio WS closed — will reconnect"));
      await pumpAudio(track, ws, mySession);
      if (track.readyState === "ended") {
        console.warn("[capture] audio track ended — bailing out of loop");
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function startCapture({ width, height, framerate, relayHost }) {
    hideScrollbars();
    forceFrames();
    try {
      stream = await getTabStream(width, height, framerate);
    } catch (e) {
      console.error("[capture] tabCapture failed, retrying in 2s:", e);
      setTimeout(() => startCapture({ width, height, framerate, relayHost }), 2000);
      return;
    }

    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];

    const vURL = `ws://${relayHost}/ingest/video?w=${width}&h=${height}&fr=${framerate}`;
    const aURL = `ws://${relayHost}/ingest/audio?sr=44100&ch=2`;

    console.log(`[capture] starting pumps — ${width}x${height}@${framerate}fps → ws://${relayHost}/ingest/*`);

    videoLoop(vTrack, vURL, framerate).catch((e) => console.error("[capture] videoLoop fatal:", e));
    audioLoop(aTrack, aURL).catch((e) => console.error("[capture] audioLoop fatal:", e));
  }

  // The trigger-capture.sh script posts CAPTURE_COMMAND with at minimum:
  //   { type: 'CAPTURE_COMMAND', command: 'start', width, height, framerate }
  // and either `relayHost` (preferred new shape, "host:port") or `port`
  // (legacy shape from the MediaRecorder era — we accept both for now).
  window.addEventListener("message", (event) => {
    if (
      event.data &&
      event.data.type === "CAPTURE_COMMAND" &&
      event.data.command === "start"
    ) {
      const width = event.data.width || 720;
      const height = event.data.height || 576;
      const framerate = event.data.framerate || 25;
      const relayHost =
        event.data.relayHost ||
        (event.data.port ? `127.0.0.1:${event.data.port}` : "127.0.0.1:9000");
      startCapture({ width, height, framerate, relayHost });
    }
  });
})();
