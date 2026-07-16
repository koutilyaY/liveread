"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { DisplayToken, SegmentView } from "@liveread/shared";
import type { SegmentTokens } from "../store/viewerStore";

/**
 * Reading surface: finalized text with word/sentence highlighting, interim
 * text in reduced-contrast styling, viewer-controlled auto-scroll.
 *
 * Transcript text is rendered exclusively as text nodes — never as HTML.
 */

interface Props {
  finalSegments: SegmentView[];
  interimSegments: SegmentView[];
  segmentTokens: SegmentTokens[];
  activeWordIndex: number;
  activeSentenceIndex: number;
  autoScroll: boolean;
  fontScale: number;
  lineSpacing: number;
  highContrast: boolean;
  readAloudActive: boolean;
  onManualJump?: (displayWordIndex: number) => void;
}

const SegmentText = memo(function SegmentText({
  tokens,
  activeWordIndex,
  activeSentenceIndex,
  readAloudActive,
  onManualJump,
}: {
  tokens: DisplayToken[];
  activeWordIndex: number;
  activeSentenceIndex: number;
  readAloudActive: boolean;
  onManualJump?: ((displayWordIndex: number) => void) | undefined;
}) {
  return (
    <>
      {tokens.map((t) => {
        const isActiveWord = readAloudActive && t.wordIndex === activeWordIndex;
        const isActiveSentence =
          readAloudActive && t.sentenceIndex === activeSentenceIndex;
        return (
          <span key={t.wordIndex}>
            <span
              data-word-index={t.wordIndex}
              data-sentence-index={t.sentenceIndex}
              data-active-word={isActiveWord || undefined}
              className={
                isActiveWord
                  ? "word-active px-0.5"
                  : isActiveSentence
                    ? "sentence-active"
                    : undefined
              }
              onClick={
                onManualJump ? () => onManualJump(t.wordIndex) : undefined
              }
              role={onManualJump ? "button" : undefined}
              tabIndex={onManualJump ? 0 : undefined}
              onKeyDown={
                onManualJump
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onManualJump(t.wordIndex);
                      }
                    }
                  : undefined
              }
            >
              {t.text}
            </span>{" "}
          </span>
        );
      })}
    </>
  );
});

export function TranscriptView({
  finalSegments,
  interimSegments,
  segmentTokens,
  activeWordIndex,
  activeSentenceIndex,
  autoScroll,
  fontScale,
  lineSpacing,
  highContrast,
  readAloudActive,
  onManualJump,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrolledWord = useRef(-1);

  // suspend auto-scroll while the user is scrolling manually
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = () => {
      setUserScrolled(true);
      if (userScrollTimeout.current) clearTimeout(userScrollTimeout.current);
      userScrollTimeout.current = setTimeout(
        () => setUserScrolled(false),
        6000,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onWheel, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onWheel);
    };
  }, []);

  // auto-scroll: keep the active word inside the reading zone; scroll only
  // when it actually leaves the zone, never on every interim token
  useEffect(() => {
    if (!autoScroll || userScrolled || activeWordIndex < 0) return;
    if (activeWordIndex === lastScrolledWord.current) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(
      `[data-word-index="${activeWordIndex}"]`,
    );
    if (!el) return;
    const cRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const zoneTop = cRect.top + cRect.height * 0.2;
    const zoneBottom = cRect.top + cRect.height * 0.6;
    if (rect.top < zoneTop || rect.bottom > zoneBottom) {
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      el.scrollIntoView({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      lastScrolledWord.current = activeWordIndex;
    }
  }, [activeWordIndex, autoScroll, userScrolled]);

  const returnToCursor = () => {
    setUserScrolled(false);
    lastScrolledWord.current = -1;
  };

  const tokensBySegment = new Map(
    segmentTokens.map((s) => [s.segmentId, s.tokens]),
  );

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        className={`h-full overflow-y-auto rounded-lg border p-6 ${
          highContrast
            ? "border-black bg-white text-black dark:border-white dark:bg-black dark:text-white"
            : "border-zinc-200 bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        }`}
        style={{ fontSize: `${fontScale}rem`, lineHeight: lineSpacing }}
        aria-label="Live transcript"
        data-testid="transcript-view"
      >
        {finalSegments.length === 0 && interimSegments.length === 0 && (
          <p className="text-zinc-500" data-testid="transcript-empty">
            Waiting for the speaker to begin…
          </p>
        )}
        <div data-testid="final-transcript">
          {finalSegments.map((seg) => (
            <span key={seg.segmentId} data-segment-id={seg.segmentId}>
              <SegmentText
                tokens={tokensBySegment.get(seg.segmentId) ?? []}
                activeWordIndex={activeWordIndex}
                activeSentenceIndex={activeSentenceIndex}
                readAloudActive={readAloudActive}
                onManualJump={onManualJump}
              />
            </span>
          ))}
        </div>
        {interimSegments.length > 0 && (
          <div
            data-testid="interim-transcript"
            aria-label="Incoming text, may change"
            className="mt-2 italic text-zinc-600 dark:text-zinc-400"
          >
            {interimSegments.map((seg) => (
              <span key={seg.segmentId}>{seg.text} </span>
            ))}
            <span className="animate-pulse" aria-hidden>
              ▍
            </span>
          </div>
        )}
      </div>
      {userScrolled && autoScroll && (
        <button
          type="button"
          onClick={returnToCursor}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-2 text-sm text-white shadow-lg hover:bg-blue-700"
        >
          Return to current sentence
        </button>
      )}
    </div>
  );
}
