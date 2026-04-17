// Content script: captures the tab via tabCapture stream ID and publishes
// it to mediamtx's WHIP endpoint as VP8 + Opus over WebRTC. Independent
// RTP timestamps are what fixes A/V drift.

(function () {
  let pc = null;
  let stream = null;

  function hideScrollbars() {
    const style = document.createElement("style");
    style.textContent = `
      html, body { overflow: hidden !important; }
      ::-webkit-scrollbar { display: none !important; }
      video::-webkit-media-controls { display: none !important; }
      video::-webkit-media-controls-overlay-play-button { display: none !important; }
      video::-webkit-media-controls-enclosure { display: none !important; }
      video::-internal-media-controls-overlay-cast-button { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function forceFrames() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(el);
    let toggle = false;
    function tick() {
      toggle = !toggle;
      el.style.opacity = toggle ? "0.01" : "0.02";
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  async function getTabStream(width, height, framerate) {
    const response = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ command: "get-stream-id" }, resolve)
    );
    if (!response || response.error) {
      throw new Error(`get-stream-id failed: ${response && response.error}`);
    }
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId,
          minFrameRate: framerate,
          maxFrameRate: framerate,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
        },
      },
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function pinCodecPreferences(pc) {
    // Prefer VP8 + Opus. mediamtx will forward these as RTP streams with
    // independent clocks — the whole point of the rebuild.
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.sender.track && transceiver.sender.track.kind;
      if (!kind) continue;
      const capabilities = RTCRtpSender.getCapabilities(kind);
      if (!capabilities) continue;
      const preferred = capabilities.codecs.filter((c) => {
        const m = c.mimeType.toLowerCase();
        return (kind === "video" && m === "video/vp8") ||
               (kind === "audio" && m === "audio/opus");
      });
      const fallback = capabilities.codecs.filter((c) => !preferred.includes(c));
      if (transceiver.setCodecPreferences) {
        try {
          transceiver.setCodecPreferences([...preferred, ...fallback]);
        } catch (e) {
          console.warn("[capture] setCodecPreferences failed:", e);
        }
      }
    }
  }

  async function pinVideoBitrate(pc, maxBitrate) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video") continue;
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length
        ? params.encodings.map((e) => ({ ...e, maxBitrate }))
        : [{ maxBitrate }];
      try {
        await sender.setParameters(params);
      } catch (e) {
        console.warn("[capture] setParameters failed:", e);
      }
    }
  }

  async function publishWHIP(mediaStream, whipUrl, maxBitrate) {
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    pc = new RTCPeerConnection();

    // Surface connection failures so the outer loop can retry.
    pc.addEventListener("iceconnectionstatechange", () => {
      console.log(`[capture] iceConnectionState=${pc.iceConnectionState}`);
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        console.warn("[capture] ICE failed/disconnected — restarting publish");
        setTimeout(() => startPublishing(mediaStream, whipUrl, maxBitrate), 2000);
      }
    });

    for (const track of mediaStream.getTracks()) {
      pc.addTransceiver(track, { direction: "sendonly", streams: [mediaStream] });
    }

    pinCodecPreferences(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait briefly for ICE gathering — WHIP servers handle trickle but
    // bundling candidates in the offer simplifies the flow.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      setTimeout(resolve, 1000);
    });

    const response = await fetch(whipUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!response.ok) {
      throw new Error(`WHIP POST failed: ${response.status} ${response.statusText}`);
    }
    const answerSDP = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSDP });

    await pinVideoBitrate(pc, maxBitrate);
    console.log("[capture] WHIP publish established");
  }

  async function startPublishing(existingStream, whipUrl, maxBitrate) {
    try {
      const s = existingStream || stream;
      if (!s) throw new Error("no media stream to publish");
      await publishWHIP(s, whipUrl, maxBitrate);
    } catch (err) {
      console.error("[capture] publish failed, retrying in 2s:", err);
      setTimeout(() => startPublishing(existingStream, whipUrl, maxBitrate), 2000);
    }
  }

  async function startCapture({ whipUrl, width, height, framerate, maxBitrate }) {
    try {
      stream = await getTabStream(width, height, framerate);
      console.log("[capture] got media stream, publishing to WHIP:", whipUrl);
      await startPublishing(stream, whipUrl, maxBitrate);
    } catch (err) {
      console.error("[capture] capture init failed, retrying in 2s:", err);
      setTimeout(() => startCapture({ whipUrl, width, height, framerate, maxBitrate }), 2000);
    }
  }

  window.addEventListener("message", (event) => {
    if (
      event.data &&
      event.data.type === "CAPTURE_COMMAND" &&
      event.data.command === "start"
    ) {
      const width = event.data.width || 720;
      const height = event.data.height || 576;
      const framerate = event.data.framerate || 25;
      const whipUrl = event.data.whipUrl || "http://127.0.0.1:8889/live/whip";
      const maxBitrate = event.data.maxBitrate || 2_500_000;
      console.log(
        `[capture] start command — ${width}x${height}@${framerate}fps → ${whipUrl}`
      );
      hideScrollbars();
      forceFrames();
      startCapture({ whipUrl, width, height, framerate, maxBitrate });
    }
  });
})();
