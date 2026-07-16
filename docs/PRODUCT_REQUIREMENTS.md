# LiveRead — Product Requirements

## Vision

Someone speaks live; their words are published as text globally in near real
time; every viewer can read that text aloud at their own pace while the page
follows _their_ voice.

LiveRead is **not** a meeting bot, a meeting summarizer, a video-conferencing
platform, or an Otter.ai clone. The differentiated workflow is viewer-controlled
voice-following reading.

## Language policy (binding on all copy)

**Never promise:** zero latency · perfect transcription · 100% recognition
accuracy · perfect pronunciation matching · uninterrupted operation on every
network · support for every browser · unlimited free global operation.

**Say instead:** near-real-time transcription · interim text may be corrected ·
final text is more stable · viewer-controlled voice following · automatic
recovery from common connection failures · human-editable final transcript ·
best-effort global connectivity.

Enforced in the UI: the viewer footer reads "Near-real-time transcription —
interim text may be corrected"; completed sessions carry "Automated
transcription can contain errors"; the degraded banner says "Live transcription
is temporarily degraded. Audio recording continues."

## Roles

**Creator** — account; start/pause/resume/end a session; choose language,
privacy, recording, retention, vocabulary; see connection/transcription health;
edit finalized text; share/revoke links; download/delete recording+transcript;
review analytics.

**Viewer** — open an authorized link; watch text appear live; distinguish
final vs interim; press Read Aloud immediately; grant mic; read at their own
pace with word/sentence highlighting; pause/resume; jump manually; restart;
change font/spacing/contrast; disable auto-scroll; play the recording afterward
when permitted. **No account required** for authorized unlisted viewers.

**Organization administrator** — future-ready, minimally implemented: roles,
retention defaults, `public_links_allowed`, usage, audit events exist in the
data model and are enforced server-side. No admin UI (LIMITATIONS.md #7).

## The two pipelines (never conflate)

|                              | Creator                                               | Viewer                                                    |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Purpose                      | canonical transcript (+ optional recording)           | locate the reader's position                              |
| Path                         | mic → WSS → STT → interim/final → persist → broadcast | mic → in-browser recognition → normalize → align → cursor |
| Writes canonical transcript? | **yes**                                               | **never**                                                 |
| Audio stored?                | opt-in                                                | **never**                                                 |
| Identifiers                  | `stream_type=canonical_creator`                       | `viewer_alignment`                                        |

Separate identifiers, permissions, rate limits, observability, and failure
states.

## Core acceptance behaviors

1. Read Aloud is pressable **before any transcript exists** → "Read Aloud is ready. Waiting for the first readable sentence."
2. Reaching the end of finalized text → "You have caught up with the speaker. Waiting for the next sentence."
3. New finalized sentences let reading resume automatically.
4. Repeated phrases must not cause uncontrolled cursor jumping.
5. Forward skips, backward reading, and restarts must recover.
6. Manual cursor reset (tap/Enter a sentence) always works — **with or without a microphone**.
7. Viewer reading position is independent of the creator's speaking speed.
8. Creator reconnect must not duplicate finalized transcript; viewer reconnect must replay missed events.
9. Provider failure → visible degraded state, recording continues, **no fabricated transcript**.
10. Completed transcript + recording remain at the same link, subject to privacy settings.

Traceability for all 46 mandatory criteria: REQUIREMENTS_TRACEABILITY.md.
Verified results: FINAL_VERIFICATION.md. Gaps: LIMITATIONS.md.
