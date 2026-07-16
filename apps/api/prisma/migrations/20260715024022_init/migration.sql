-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "default_retention_days" INTEGER NOT NULL DEFAULT 90,
    "public_links_allowed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("organization_id","user_id")
);

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "creator_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "language_code" TEXT NOT NULL DEFAULT 'en-US',
    "status" TEXT NOT NULL DEFAULT 'preflight',
    "privacy_mode" TEXT NOT NULL DEFAULT 'unlisted',
    "share_id" TEXT NOT NULL,
    "share_token_hash" TEXT NOT NULL,
    "share_passcode_hash" TEXT,
    "share_expires_at" TIMESTAMP(3),
    "share_revoked_at" TIMESTAMP(3),
    "creator_audio_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recording_enabled" BOOLEAN NOT NULL DEFAULT true,
    "interim_reading_enabled" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "last_sequence" INTEGER NOT NULL DEFAULT -1,
    "started_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "region" TEXT NOT NULL DEFAULT 'local',
    "transcription_provider" TEXT NOT NULL DEFAULT 'fake',
    "transcription_model" TEXT NOT NULL DEFAULT 'fake-1',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_streams" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "stream_type" TEXT NOT NULL,
    "provider_stream_id" TEXT,
    "codec" TEXT NOT NULL DEFAULT 'pcm_s16le',
    "sample_rate" INTEGER NOT NULL DEFAULT 16000,
    "channel_count" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "audio_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'audio/webm',
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "text" TEXT NOT NULL DEFAULT '',
    "normalized_text" TEXT NOT NULL DEFAULT '',
    "language_code" TEXT NOT NULL DEFAULT 'en-US',
    "start_ms" INTEGER NOT NULL DEFAULT 0,
    "end_ms" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "stability" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMP(3),
    "corrected_at" TIMESTAMP(3),

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_revisions" (
    "id" UUID NOT NULL,
    "transcript_segment_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "previous_text" TEXT NOT NULL,
    "new_text" TEXT NOT NULL,
    "actor_user_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_events" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "segment_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vocabulary_terms" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "phrase" TEXT NOT NULL,
    "pronunciation_hint" TEXT,
    "boost" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vocabulary_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewer_sessions" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "anonymous_id" TEXT NOT NULL,
    "authenticated_user_id" UUID,
    "token_hash" TEXT NOT NULL,
    "read_aloud_enabled" BOOLEAN NOT NULL DEFAULT false,
    "current_word_index" INTEGER NOT NULL DEFAULT -1,
    "current_sentence_index" INTEGER NOT NULL DEFAULT -1,
    "alignment_state" TEXT NOT NULL DEFAULT 'waiting',
    "alignment_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "viewer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_access_events" (
    "id" UUID NOT NULL,
    "live_session_id" UUID NOT NULL,
    "viewer_session_id" UUID,
    "action" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent_family" TEXT,
    "country_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "request_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "live_session_id" UUID,
    "component" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "error_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "recoverable" BOOLEAN NOT NULL DEFAULT true,
    "recovery_action" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "live_sessions_share_id_key" ON "live_sessions"("share_id");

-- CreateIndex
CREATE INDEX "live_sessions_creator_user_id_idx" ON "live_sessions"("creator_user_id");

-- CreateIndex
CREATE INDEX "live_sessions_organization_id_idx" ON "live_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "audio_streams_live_session_id_idx" ON "audio_streams"("live_session_id");

-- CreateIndex
CREATE INDEX "recordings_live_session_id_idx" ON "recordings"("live_session_id");

-- CreateIndex
CREATE INDEX "transcript_segments_live_session_id_status_idx" ON "transcript_segments"("live_session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_live_session_id_segment_index_key" ON "transcript_segments"("live_session_id", "segment_index");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_revisions_transcript_segment_id_revision_number_key" ON "transcript_revisions"("transcript_segment_id", "revision_number");

-- CreateIndex
CREATE INDEX "transcript_events_live_session_id_sequence_number_idx" ON "transcript_events"("live_session_id", "sequence_number");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_events_live_session_id_sequence_number_key" ON "transcript_events"("live_session_id", "sequence_number");

-- CreateIndex
CREATE INDEX "vocabulary_terms_live_session_id_idx" ON "vocabulary_terms"("live_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "viewer_sessions_token_hash_key" ON "viewer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "viewer_sessions_live_session_id_idx" ON "viewer_sessions"("live_session_id");

-- CreateIndex
CREATE INDEX "share_access_events_live_session_id_idx" ON "share_access_events"("live_session_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "incident_events_live_session_id_idx" ON "incident_events"("live_session_id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_streams" ADD CONSTRAINT "audio_streams_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_transcript_segment_id_fkey" FOREIGN KEY ("transcript_segment_id") REFERENCES "transcript_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_revisions" ADD CONSTRAINT "transcript_revisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_events" ADD CONSTRAINT "transcript_events_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vocabulary_terms" ADD CONSTRAINT "vocabulary_terms_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewer_sessions" ADD CONSTRAINT "viewer_sessions_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
