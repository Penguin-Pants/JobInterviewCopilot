/**
 * TASK-010 spike renderer. Sandboxed, context-isolated, no Node.
 *
 * It calls only the standard web API. If this works, the audio worker can stay
 * configured exactly as FR-086 requires and the electron-audio-loopback
 * dependency is unnecessary on Windows.
 */
(async () => {
  const payload = {
    streamAcquired: false,
    audioTrackCount: 0,
    videoTrackCount: 0,
    audioTrackLabel: null,
    audioSettings: null,
    sampledMs: 0,
    peakAmplitude: null,
    nonSilent: null,
    rendererError: null,
  };

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    payload.streamAcquired = true;

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    payload.audioTrackCount = audioTracks.length;
    payload.videoTrackCount = videoTracks.length;

    // The video track is only the vehicle for the audio. Drop it immediately:
    // this app has no business holding a screen video stream (ADR-021).
    for (const track of videoTracks) {
      track.stop();
      stream.removeTrack(track);
    }

    if (audioTracks.length > 0) {
      payload.audioTrackLabel = audioTracks[0].label;
      payload.audioSettings = audioTracks[0].getSettings();

      // Confirm the 16 kHz context forcing from ADR-006 while we are here.
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      let peak = 0;
      const started = Date.now();
      await new Promise((resolve) => {
        const tick = setInterval(() => {
          analyser.getFloatTimeDomainData(buffer);
          for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
          if (Date.now() - started >= 3000) {
            clearInterval(tick);
            resolve();
          }
        }, 100);
      });

      payload.sampledMs = Date.now() - started;
      payload.peakAmplitude = Number(peak.toFixed(6));
      payload.nonSilent = peak > 0.0005;
      payload.contextSampleRate = context.sampleRate;
      await context.close();
    }

    for (const track of stream.getTracks()) track.stop();
  } catch (err) {
    payload.rendererError = String(err && err.message ? err.message : err);
  }

  window.spike.report(payload);
})();
