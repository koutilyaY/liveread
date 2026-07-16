# LiveRead — WebRTC / LiveKit Deployment

## Scope — read this first

LiveKit is provisioned in compose (profile `media`) and the data model carries
`creator_audio_enabled`, but **live creator audio is not wired into the UI**:
there is no token-mint endpoint and no publish/subscribe path. Viewers cannot
currently hear the creator live. Transcript delivery and recording playback are
unaffected. This is LIMITATIONS.md #5 — stated here so nobody deploys expecting
live audio to work.

Everything below is the design and the operational requirements for completing
it.

## Why an SFU at all

The spec is explicit: **do not** send the creator's raw audio from the browser
to every viewer. One creator × thousands of viewers is exactly the fan-out an
SFU exists for. We do **not** build one — LiveKit is the default (ADR-0001).

Transcript events deliberately do **not** ride LiveKit data channels. They need
durable ordering and replay-after-reconnect, which is a database concern. Text-
only readers should never pay for a media connection.

## Local

```bash
docker compose --profile media up -d livekit coturn
```

`infra/livekit/livekit.yaml`: port 7880 (signal), 7881 (TCP), 50000–50060/udp.
Dev key `devkey` / `devsecret-local-only-…` — **local only**, never production.

## Production

- LiveKit Cloud **or** self-hosted (Kubernetes/VMs) near creators.
- **TURN is required**, not optional: symmetric NAT and restrictive corporate networks fail without it. `turns:` on 443/TCP is the fallback that works nearly everywhere.
- UDP 50000–60000 open for RTC; 7880/7881 for signal.
- Token scoping (when implemented): short TTL, room = session id, **creator = publish-only, viewer = subscribe-only**. Never issue a wildcard-room token. Mint server-side after the same authorization check the WebSocket performs.

## Sizing

Audio-only is cheap per stream but scales linearly with subscribers. Budget by
subscriber-minutes; monitor per-node bandwidth. Autoscale on participant count.

## Failure modes to handle when wiring this up

| Failure              | Expected behavior                                                          |
| -------------------- | -------------------------------------------------------------------------- |
| WebRTC connect fails | fall back to transcript-only; say so plainly                               |
| TURN unavailable     | same                                                                       |
| LiveKit down         | transcript + recording continue; audio unavailable is surfaced, not hidden |
| Autoplay blocked     | require a gesture; never auto-play                                         |

The viewer UI already renders a "creator audio unavailable" state rather than
pretending audio exists.
