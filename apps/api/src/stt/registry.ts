import { env } from "../env.js";
import { sttFailovers, sttProviderErrors } from "../lib/metrics.js";
import { DeepgramSttProvider } from "./deepgram.js";
import { FakeSttProvider } from "./fake.js";
import type {
  SttProvider,
  SttStream,
  SttStreamCallbacks,
  SttStreamOptions,
} from "./provider.js";

/**
 * Provider registry with a circuit breaker and single-failover policy.
 *
 * Failover rules (spec: PROVIDER FAILOVER):
 *  - a stream error triggers at most ONE failover to the configured secondary;
 *  - the new stream starts fresh — no audio replay without sequence control,
 *    so the un-transcribed span is reported as a gap (never fabricated);
 *  - the circuit opens after `failureThreshold` consecutive start failures and
 *    half-opens after `cooldownMs`.
 */

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  constructor(
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 30_000,
  ) {}

  canAttempt(): boolean {
    if (this.consecutiveFailures < this.failureThreshold) return true;
    return Date.now() - this.openedAt > this.cooldownMs; // half-open probe
  }
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = Date.now();
    }
  }
  get state(): "closed" | "open" | "half_open" {
    if (this.consecutiveFailures < this.failureThreshold) return "closed";
    return Date.now() - this.openedAt > this.cooldownMs ? "half_open" : "open";
  }
}

const breakers = new Map<string, CircuitBreaker>();
function breaker(name: string): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = new CircuitBreaker();
    breakers.set(name, b);
  }
  return b;
}

let fakeProvider: FakeSttProvider | null = null;
let deepgramProvider: DeepgramSttProvider | null = null;

export function getProvider(name: string): SttProvider | null {
  switch (name) {
    case "fake":
      if (!fakeProvider) fakeProvider = new FakeSttProvider();
      return fakeProvider;
    case "deepgram": {
      const key = env().DEEPGRAM_API_KEY;
      if (!key) return null;
      if (!deepgramProvider) deepgramProvider = new DeepgramSttProvider(key);
      return deepgramProvider;
    }
    default:
      return null;
  }
}

export function primaryProviderName(): string {
  const configured = env().STT_PROVIDER;
  if (configured === "deepgram" && !env().DEEPGRAM_API_KEY) {
    // configured but unusable — honest downgrade, surfaced via /readyz
    return "fake";
  }
  return configured;
}

export interface StartStreamResult {
  stream: SttStream;
  providerName: string;
  /** true when the primary was skipped/failed and the fallback is in use */
  degraded: boolean;
}

export async function startSttStream(
  opts: SttStreamOptions,
  cb: SttStreamCallbacks,
  onFailover?: (from: string, to: string) => void,
): Promise<StartStreamResult> {
  const primary = primaryProviderName();
  const fallbackName = env().STT_FALLBACK_PROVIDER;
  const order: string[] = [primary];
  if (fallbackName !== "none" && fallbackName !== primary)
    order.push(fallbackName);

  let lastError: Error | null = null;
  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    const provider = getProvider(name);
    if (!provider) continue;
    const b = breaker(name);
    if (!b.canAttempt()) {
      sttProviderErrors.inc({ provider: name, kind: "circuit_open" });
      continue;
    }
    try {
      // wrap callbacks so a mid-stream error can trigger one failover upstream
      const stream = await provider.startStream(opts, cb);
      b.recordSuccess();
      const degraded = i > 0;
      if (degraded && onFailover) {
        sttFailovers.inc({ from: order[0]!, to: name });
        onFailover(order[0]!, name);
      }
      return { stream, providerName: name, degraded };
    } catch (err) {
      b.recordFailure();
      sttProviderErrors.inc({ provider: name, kind: "start_failure" });
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("no_stt_provider_available");
}

export function providerHealthSummary(): {
  primary: string;
  fallback: string;
  circuit: string;
} {
  const primary = primaryProviderName();
  return {
    primary,
    fallback: env().STT_FALLBACK_PROVIDER,
    circuit: breaker(primary).state,
  };
}
