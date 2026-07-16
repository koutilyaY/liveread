# LiveRead — Pilot Guide

## Who this is for

A small, friendly pilot: a lecturer, a community reading group, a language
class. **Not** a public launch — see "Before you go public" below.

## 30-second demo (no credentials, no cloud)

```bash
cd liveread
docker compose up --build -d
make seed
open http://localhost:3000/s/demo-reading-2026#demo-share-token-public
```

Press **Read Aloud Mode** and read the text out loud. The highlight follows you.
Skip a paragraph — it finds you. Reach the end — it tells you you've caught up.

For the live half: sign in as `demo@liveread.local` / `liveread-demo-2026`, open
"Live Demo — press Start Speaking", pass preflight, and press Start. Text
appears as the fake provider "speaks". Open the share link in another window to
watch it arrive live.

## Running a real pilot session

**Before (10 min)** — create the session (title, language, privacy, recording,
retention, vocabulary hints for names/jargon). Run preflight **on the actual
machine and network you'll use**. Copy the share link _at creation_ — the token
is shown once. Use a wired headset; room mics produce poor transcripts.

**During** — watch the input meter (silence = a dead mic, not a quiet room).
Speak in complete sentences and pause at the end; finals land on phrase
endpoints. If the degraded banner appears, keep going — recording continues; the
gap is marked, never invented. Pause during Q&A you don't want transcribed.

**After** — review the transcript editor and correct errors (history is kept).
Download `.txt`/`.vtt`. Revoke the link when the audience no longer needs it.

## Tell your viewers

- Read Aloud needs Chrome/Edge/Safari — **Firefox has no Web Speech API**; there they read manually by tapping a sentence (fully supported).
- Their microphone audio **never leaves their browser** and is never stored.
- Tap any sentence to move the cursor. Turn off auto-scroll if it distracts.
- Font size, spacing, and high contrast are in the sidebar.

## Set expectations honestly

Transcription is near-real-time, not instant. Interim text changes; final text is
stable. Proper nouns get misheard — that's what vocabulary hints and the editor
are for. Accents and background noise degrade both pipelines.

## Before you go public

1. Real STT credentials + a signed DPA (`STT_PROVIDER=deepgram` — **unverified against the live service**, LIMITATIONS.md #13).
2. Legal review of the Terms placeholder; configure minimum-age/guardian policy.
3. `NODE_ENV=production`, TLS, and **`TRUST_PROXY` set to your load balancer's addresses** (DEPLOYMENT.md).
4. Abuse-review tooling + takedown workflow (report-only today).
5. Spending alerts and a hard provider cutoff (COST_MODEL.md).

Read LIMITATIONS.md end-to-end first. It is short and honest.
