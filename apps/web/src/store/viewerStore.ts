"use client";

import { create } from "zustand";
import {
  AlignmentEngine,
  TranscriptStore,
  getLanguageProfile,
  matchableTokens,
  normalizeUtterance,
  tokenize,
  type AlignmentResult,
  type DisplayToken,
  type SegmentView,
  type ServerMessage,
  type SessionStatus,
  type TranscriptToken,
} from "@liveread/shared";
import { api, wsUrl } from "../lib/api";
import { ReconnectingSocket, type ConnectionState } from "../lib/ws";
import {
  createRecognitionDriver,
  webSpeechSupported,
  type RecognitionDriver,
} from "../lib/speech";

/**
 * Viewer page state: live transcript materialization, read-aloud alignment,
 * and connection management. The alignment engine and transcript store live
 * outside React state; the store publishes derived snapshots.
 */

export interface SegmentTokens {
  segmentId: string;
  tokens: DisplayToken[];
}

interface SessionMeta {
  id: string;
  title: string;
  languageCode: string;
  status: SessionStatus;
  creatorAudioEnabled: boolean;
  interimReadingEnabled: boolean;
}

export type ReadAloudPermission = "idle" | "requesting" | "granted" | "denied";

interface ViewerState {
  shareId: string | null;
  viewerSessionId: string | null;
  viewerToken: string | null;
  meta: SessionMeta | null;
  accessError: string | null;
  needsPasscode: boolean;
  connection: ConnectionState;
  status: SessionStatus | null;
  creatorConnected: boolean;
  viewerCount: number;
  degraded: boolean;
  finalSegments: SegmentView[];
  interimSegments: SegmentView[];
  segmentTokens: SegmentTokens[];
  totalWords: number;
  readAloudActive: boolean;
  permission: ReadAloudPermission;
  recognitionSupported: boolean;
  alignment: AlignmentResult | null;
  autoScroll: boolean;
  fontScale: number;
  lineSpacing: number;
  highContrast: boolean;

  access(shareId: string, shareToken: string, passcode?: string): Promise<void>;
  startReadAloud(): Promise<void>;
  stopReadAloud(): void;
  manualJump(displayWordIndex: number): void;
  setAutoScroll(v: boolean): void;
  setFontScale(v: number): void;
  setLineSpacing(v: number): void;
  setHighContrast(v: boolean): void;
  disconnect(): void;
}

const transcript = new TranscriptStore();
const engine = new AlignmentEngine();
let socket: ReconnectingSocket | null = null;
let driver: RecognitionDriver | null = null;
let lastReceivedSequence = -1;
let reportTimer: ReturnType<typeof setInterval> | null = null;

function rebuildTokens(
  segments: SegmentView[],
  languageCode: string,
): {
  segmentTokens: SegmentTokens[];
  engineTokens: TranscriptToken[];
  totalWords: number;
} {
  const profile = getLanguageProfile(languageCode);
  const segmentTokens: SegmentTokens[] = [];
  const engineTokens: TranscriptToken[] = [];
  let sentenceOffset = 0;
  let wordOffset = 0;
  for (const seg of segments) {
    const tokens = tokenize(seg.text, profile, { sentenceOffset, wordOffset });
    segmentTokens.push({ segmentId: seg.segmentId, tokens });
    for (const t of matchableTokens(tokens)) {
      engineTokens.push({
        norm: t.norm,
        displayWordIndex: t.wordIndex,
        sentenceIndex: t.sentenceIndex,
        segmentId: seg.segmentId,
      });
    }
    if (tokens.length > 0) {
      const last = tokens[tokens.length - 1]!;
      wordOffset = last.wordIndex + 1;
      sentenceOffset = last.sentenceIndex + 1;
    }
  }
  return { segmentTokens, engineTokens, totalWords: wordOffset };
}

export const useViewerStore = create<ViewerState>((set, get) => {
  function applyServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "transcript.event": {
        transcript.apply(msg.event);
        lastReceivedSequence = Math.max(
          lastReceivedSequence,
          transcript.lastSequence,
        );
        const finals = transcript.finalized();
        const meta = get().meta;
        const { segmentTokens, engineTokens, totalWords } = rebuildTokens(
          finals,
          meta?.languageCode ?? "en-US",
        );
        engine.setTranscriptTokens(engineTokens);
        set({
          finalSegments: finals,
          interimSegments: transcript.interim(),
          segmentTokens,
          totalWords,
          alignment: engine.getResult(),
        });
        break;
      }
      // authoritative status on (re)connect: a viewer joining an already
      // degraded session must see the banner, not just one raised while
      // they were listening
      case "session.status":
        set({ status: msg.status, degraded: msg.status === "degraded" });
        break;
      case "session.live":
        set({ status: "live" });
        break;
      case "session.paused":
        set({ status: "paused" });
        break;
      case "session.resumed":
        set({ status: "live" });
        break;
      case "session.ending":
        set({ status: "ending" });
        break;
      case "session.completed":
        set({ status: "completed" });
        break;
      case "session.degraded":
        set({ status: "degraded", degraded: true });
        break;
      case "incident.started":
        if (msg.component === "transcription") set({ degraded: true });
        break;
      case "incident.resolved":
        set({ degraded: false });
        break;
      case "viewer.count":
        set({ viewerCount: msg.count });
        break;
      case "creator.connection_status":
        set({ creatorConnected: msg.connected });
        break;
      default:
        break;
    }
  }

  function feedRecognition(text: string, isFinal: boolean): void {
    const meta = get().meta;
    const profile = getLanguageProfile(meta?.languageCode ?? "en-US");
    const tokens = normalizeUtterance(text, profile);
    const result = engine.update({
      utteranceTokens: tokens,
      isFinal,
      timestampMs: performance.now(),
    });
    set({ alignment: result });
  }

  return {
    shareId: null,
    viewerSessionId: null,
    viewerToken: null,
    meta: null,
    accessError: null,
    needsPasscode: false,
    connection: "closed",
    status: null,
    creatorConnected: true,
    viewerCount: 0,
    degraded: false,
    finalSegments: [],
    interimSegments: [],
    segmentTokens: [],
    totalWords: 0,
    readAloudActive: false,
    permission: "idle",
    recognitionSupported: true,
    alignment: null,
    autoScroll: true,
    fontScale: 1,
    lineSpacing: 1.8,
    highContrast: false,

    async access(shareId, shareToken, passcode) {
      set({ shareId, accessError: null });
      try {
        const res = await api<{
          viewerSessionId: string;
          viewerToken: string;
          session: SessionMeta & { lastSequence: number };
        }>(`/v1/share/${shareId}/access`, {
          method: "POST",
          body: JSON.stringify({ token: shareToken, passcode }),
        });
        set({
          viewerSessionId: res.viewerSessionId,
          viewerToken: res.viewerToken,
          meta: res.session,
          status: res.session.status,
          needsPasscode: false,
          recognitionSupported:
            webSpeechSupported() ||
            new URLSearchParams(window.location.search).has("fakespeech"),
        });
        socket?.close();
        socket = new ReconnectingSocket({
          url: wsUrl(`/ws/viewer/${shareId}?token=${res.viewerToken}`),
          onMessage: applyServerMessage,
          onState: (connection) => set({ connection }),
          onOpen: (ws) => {
            ws.send(
              JSON.stringify({
                type: "subscribe",
                last_received_sequence: lastReceivedSequence,
              }),
            );
          },
        });
        socket.connect();
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: unknown };
        if (
          e.code === "invalid_request" &&
          typeof e.details === "object" &&
          e.details !== null &&
          (e.details as { needsPasscode?: boolean }).needsPasscode
        ) {
          set({ needsPasscode: true });
          return;
        }
        set({
          accessError:
            e.message ??
            "This link is invalid, expired, or has been revoked by the creator.",
        });
      }
    },

    async startReadAloud() {
      const state = get();
      if (state.readAloudActive) return;
      const useFake = new URLSearchParams(window.location.search).has(
        "fakespeech",
      );
      set({ permission: "requesting" });
      driver = createRecognitionDriver(useFake);
      await driver.start(state.meta?.languageCode ?? "en-US", {
        onResult: feedRecognition,
        onError: (code) => {
          if (code === "permission_denied") {
            set({ permission: "denied", readAloudActive: false });
            driver?.stop();
          } else if (code === "unsupported") {
            set({
              recognitionSupported: false,
              readAloudActive: false,
              permission: "idle",
            });
          }
        },
        onEnd: () => {},
      });
      // driver.start resolves after the permission flow; if the error
      // callback already marked denial/unsupported, keep that state
      if (get().permission === "denied" || !get().recognitionSupported) {
        return;
      }
      set({ permission: "granted", readAloudActive: true });
      void api(`/v1/viewer-sessions/${state.viewerSessionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          viewerToken: state.viewerToken,
          readAloudEnabled: true,
        }),
      }).catch(() => {});
      if (reportTimer) clearInterval(reportTimer);
      reportTimer = setInterval(() => {
        const s = get();
        if (!s.alignment || !s.viewerSessionId) return;
        void api(`/v1/viewer-sessions/${s.viewerSessionId}`, {
          method: "PATCH",
          body: JSON.stringify({
            viewerToken: s.viewerToken,
            currentWordIndex: s.alignment.matchedWordIndex,
            currentSentenceIndex: s.alignment.matchedSentenceIndex,
            alignmentState: s.alignment.state,
            alignmentConfidence: s.alignment.confidence,
          }),
        }).catch(() => {});
      }, 5000);
    },

    stopReadAloud() {
      driver?.stop();
      driver = null;
      if (reportTimer) {
        clearInterval(reportTimer);
        reportTimer = null;
      }
      set({ readAloudActive: false, permission: "idle" });
    },

    manualJump(displayWordIndex) {
      const result = engine.manualReset(displayWordIndex, performance.now());
      set({ alignment: result });
    },

    setAutoScroll: (autoScroll) => set({ autoScroll }),
    setFontScale: (fontScale) => set({ fontScale }),
    setLineSpacing: (lineSpacing) => set({ lineSpacing }),
    setHighContrast: (highContrast) => set({ highContrast }),

    disconnect() {
      driver?.stop();
      driver = null;
      socket?.close();
      socket = null;
      if (reportTimer) clearInterval(reportTimer);
      reportTimer = null;
      const s = get();
      if (s.viewerSessionId && s.viewerToken) {
        void api(`/v1/viewer-sessions/${s.viewerSessionId}/end`, {
          method: "POST",
          body: JSON.stringify({ viewerToken: s.viewerToken }),
          keepalive: true,
        }).catch(() => {});
      }
    },
  };
});
