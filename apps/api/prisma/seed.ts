import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import argon2 from "argon2";

/**
 * Deterministic demo seed (spec: DEMO MODE).
 *
 * Creates:
 *  - demo creator account:  demo@liveread.local / liveread-demo-2026
 *  - a COMPLETED session "Global Reading Demonstration" with a finalized
 *    transcript and revision history, reachable at /s/{shareId}#{token}
 *  - a fresh preflight session the creator can start live immediately
 *
 * The live part of the demo uses the fake STT provider — run the stack and
 * press "Start Speaking" on the seeded preflight session. No paid
 * credentials required.
 */

const db = new PrismaClient();
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const DEMO_SHARE_ID = "demo-reading-2026";
const DEMO_SHARE_TOKEN = "demo-share-token-public";

const SENTENCES = [
  "Welcome everyone to this global reading demonstration.",
  "Today we are going to explore how live text can follow your voice.",
  "The words you see appear moments after they are spoken.",
  "Interim text may change while a sentence is still forming.",
  "Once a sentence is finalized it becomes stable and readable.",
  "Viewers anywhere in the world receive these updates instantly.",
  "Each reader can move through the text at their own pace.",
  "The reading cursor follows your voice as you speak the words.",
  "If you skip ahead the system will find your new position.",
  "If you read the same sentence twice it will not lose track.",
  "When you catch up with the speaker the page will tell you.",
  "New sentences keep arriving while you continue reading.",
  "This concludes the guided portion of the demonstration.",
  "Thank you for reading along with us today.",
];

async function main(): Promise<void> {
  const email = "demo@liveread.local";
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Seed already applied (demo user exists). Skipping.");
    return;
  }

  const passwordHash = await argon2.hash("liveread-demo-2026", {
    type: argon2.argon2id,
  });
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      displayName: "Demo Creator",
      emailVerifiedAt: new Date(),
    },
  });
  const org = await db.organization.create({
    data: { name: "Demo workspace", slug: "demo-workspace" },
  });
  await db.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: "owner" },
  });

  const startedAt = new Date(Date.now() - 3600_000);
  const session = await db.liveSession.create({
    data: {
      organizationId: org.id,
      creatorUserId: user.id,
      title: "Global Reading Demonstration",
      status: "completed",
      privacyMode: "unlisted",
      shareId: DEMO_SHARE_ID,
      shareTokenHash: sha256(DEMO_SHARE_TOKEN),
      recordingEnabled: false,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 300_000),
      lastSequence: SENTENCES.length * 2 - 1,
    },
  });

  let seq = -1;
  let ms = 0;
  for (let i = 0; i < SENTENCES.length; i++) {
    const text = SENTENCES[i]!;
    const segmentId = randomUUID();
    const startMs = ms;
    const endMs = ms + text.split(" ").length * 320;
    ms = endMs + 200;
    const interimSeq = ++seq;
    const finalSeq = ++seq;
    await db.transcriptSegment.create({
      data: {
        id: segmentId,
        liveSessionId: session.id,
        segmentIndex: i,
        currentRevision: 1,
        status: "final",
        text,
        normalizedText: text.toLowerCase().replace(/[^a-z0-9 ]/g, ""),
        startMs,
        endMs,
        confidence: 0.94,
        finalizedAt: new Date(startedAt.getTime() + endMs),
      },
    });
    const base = {
      session_id: session.id,
      segment_id: segmentId,
      language_code: "en-US",
      start_ms: startMs,
      end_ms: endMs,
    };
    await db.transcriptEvent.create({
      data: {
        liveSessionId: session.id,
        sequenceNumber: interimSeq,
        segmentId,
        revisionNumber: 0,
        eventType: "transcript.interim",
        payload: {
          ...base,
          event_id: randomUUID(),
          sequence_number: interimSeq,
          revision_number: 0,
          event_type: "transcript.interim",
          text: text.slice(0, Math.floor(text.length / 2)),
          is_final: false,
          stability: 0.6,
          confidence: null,
          created_at: new Date(startedAt.getTime() + startMs).toISOString(),
        },
      },
    });
    await db.transcriptEvent.create({
      data: {
        liveSessionId: session.id,
        sequenceNumber: finalSeq,
        segmentId,
        revisionNumber: 1,
        eventType: "transcript.final",
        payload: {
          ...base,
          event_id: randomUUID(),
          sequence_number: finalSeq,
          revision_number: 1,
          event_type: "transcript.final",
          text,
          is_final: true,
          stability: null,
          confidence: 0.94,
          created_at: new Date(startedAt.getTime() + endMs).toISOString(),
        },
      },
    });
  }

  // a fresh session ready to go live with the fake provider
  await db.liveSession.create({
    data: {
      organizationId: org.id,
      creatorUserId: user.id,
      title: "Live Demo — press Start Speaking",
      status: "preflight",
      privacyMode: "unlisted",
      shareId: "live-demo-2026",
      shareTokenHash: sha256("live-demo-token-public"),
      recordingEnabled: true,
    },
  });

  console.log("Seeded demo data:");
  console.log("  login:      demo@liveread.local / liveread-demo-2026");
  console.log(`  completed:  /s/${DEMO_SHARE_ID}#${DEMO_SHARE_TOKEN}`);
  console.log("  live-ready: /s/live-demo-2026#live-demo-token-public");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
