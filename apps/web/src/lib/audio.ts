"use client";

/**
 * Creator microphone capture:
 *  - AudioWorklet emits 100 ms Int16 PCM frames (16 kHz mono) for streaming
 *    transcription;
 *  - a parallel MediaRecorder produces webm chunks for archival recording.
 */

export interface CaptureHandle {
  stream: MediaStream;
  stop: () => void;
  setMuted: (muted: boolean) => void;
}

export async function startMicrophoneCapture(opts: {
  onFrame: (pcm: ArrayBuffer) => void;
  onLevel: (rms: number) => void;
  deviceId?: string;
}): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-frame-processor");
  let muted = false;
  node.port.onmessage = (
    ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>,
  ) => {
    opts.onLevel(ev.data.rms);
    if (!muted) opts.onFrame(ev.data.pcm);
  };
  source.connect(node);
  // worklet is a sink; no need to connect to destination (avoids echo)

  return {
    stream,
    stop: () => {
      node.disconnect();
      source.disconnect();
      void ctx.close();
      stream.getTracks().forEach((t) => t.stop());
    },
    setMuted: (m: boolean) => {
      muted = m;
    },
  };
}

export interface RecorderHandle {
  stop: () => Promise<void>;
  /** local emergency download of everything recorded so far */
  downloadLocal: (filename: string) => void;
}

export function pickRecorderMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export function startRecorder(
  stream: MediaStream,
  onChunk: (blob: Blob, seq: number) => void,
): RecorderHandle | null {
  const mimeType = pickRecorderMimeType();
  if (!mimeType) return null;
  const recorder = new MediaRecorder(stream, { mimeType });
  const localChunks: Blob[] = [];
  let seq = 0;
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) {
      localChunks.push(ev.data);
      onChunk(ev.data, seq++);
    }
  };
  recorder.start(5000);
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        if (recorder.state !== "inactive") recorder.stop();
        else resolve();
      }),
    downloadLocal: (filename: string) => {
      const blob = new Blob(localChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}

export function int16ToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
