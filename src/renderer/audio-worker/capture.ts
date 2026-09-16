import type { TranscriptSource } from '../../shared/types.js';

/**
 * Stream acquisition (CMP-03b, FR-040, ADR-028).
 *
 * The one narrow seam ADR-005 asked for. If the acquisition mechanism ever has
 * to change, it changes here and nowhere else.
 *
 * `electron-audio-loopback` was evaluated and rejected (ADR-028). Its renderer
 * half calls `ipcRenderer` from inside the renderer, which a `sandbox: true`,
 * `contextIsolation: true` renderer cannot do, and declaring it made `electron`
 * a production dependency, which breaks the installer build. What it actually
 * does is what this file does: main owns `setDisplayMediaRequestHandler` and
 * answers `audio: 'loopback'`, and the renderer asks for a display stream.
 *
 * Nothing in this directory may import the filesystem; the lint rule enforces
 * it (NFR-002).
 */

/**
 * Processing that must be off for both streams.
 *
 * The spike found these arrive **on** by default. They are microphone
 * defaults and they are wrong here: gain control pumps levels between a loud
 * and a quiet speaker, and noise suppression removes exactly the quiet
 * consonants a transcriber needs. Applied to the interviewer stream they
 * damage the input before the STT provider ever sees it, and the symptom would
 * be poor suggestions rather than anything that looks like an audio bug
 * (ADR-028).
 */
export const RAW_AUDIO_CONSTRAINTS = {
  autoGainControl: false,
  echoCancellation: false,
  noiseSuppression: false,
} as const;

export class StreamAcquisitionError extends Error {
  constructor(
    readonly source: TranscriptSource,
    message: string,
  ) {
    super(message);
    this.name = 'StreamAcquisitionError';
  }
}

/**
 * System audio, which is the interviewer plus anything else the machine is
 * playing. That breadth is a documented v1 limitation, not an oversight
 * (ADR-021).
 *
 * The video track is the vehicle Chromium requires for a display stream; it is
 * stopped and removed immediately. This app has no business holding a screen
 * video stream for any longer than the call takes to return.
 */
export async function getLoopbackStream(): Promise<MediaStream> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: RAW_AUDIO_CONSTRAINTS,
    });
  } catch (err) {
    throw new StreamAcquisitionError(
      'interviewer',
      `System audio could not be captured: ${describe(err)}`,
    );
  }

  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  if (stream.getAudioTracks().length === 0) {
    throw new StreamAcquisitionError(
      'interviewer',
      'The display stream carried no audio track, so the interviewer would not be heard.',
    );
  }
  return stream;
}

/** The candidate's own microphone. */
export async function getMicrophoneStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...RAW_AUDIO_CONSTRAINTS, channelCount: 1 },
      video: false,
    });
  } catch (err) {
    throw new StreamAcquisitionError(
      'candidate',
      `The microphone could not be captured: ${describe(err)}`,
    );
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
