const validStates = new Set(["CLOSED", "OPEN", "HALF_OPEN"]);

export class SyncCircuitBreaker {
  #probeInFlight = false;

  constructor({
    metadataRepository = null,
    failureThreshold = 5,
    openMs = 60_000,
    halfOpenBatch = 5,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new TypeError("failureThreshold must be a positive integer.");
    }
    if (!Number.isInteger(openMs) || openMs < 1_000) {
      throw new TypeError("openMs must be at least 1000 milliseconds.");
    }
    if (!Number.isInteger(halfOpenBatch) || halfOpenBatch < 1) {
      throw new TypeError("halfOpenBatch must be a positive integer.");
    }
    this.metadataRepository = metadataRepository;
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.halfOpenBatch = halfOpenBatch;
    this.now = now;
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.openUntil = null;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.openCount = 0;
    this.#restore();
  }

  #restore() {
    const stored = this.metadataRepository?.get("circuit_breaker");
    const value = stored?.metadata;
    if (!value || !validStates.has(value.state)) return;
    this.state = value.state;
    this.consecutiveFailures = Number(value.consecutiveFailures ?? 0);
    this.openedAt = value.openedAt ?? null;
    this.openUntil = value.openUntil ?? null;
    this.lastFailureAt = value.lastFailureAt ?? null;
    this.lastSuccessAt = value.lastSuccessAt ?? null;
    this.openCount = Number(value.openCount ?? 0);
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.openUntil = Math.min(Number(this.openUntil ?? this.now()), this.now());
    }
  }

  #persist() {
    this.metadataRepository?.set({
      streamName: "circuit_breaker",
      state: this.state.toLowerCase(),
      lastAttemptAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      metadata: this.getSnapshot(),
    });
  }

  canAttempt(at = this.now()) {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (at < Number(this.openUntil ?? Infinity)) return false;
      this.state = "HALF_OPEN";
      this.#probeInFlight = false;
      this.#persist();
    }
    if (this.#probeInFlight) return false;
    this.#probeInFlight = true;
    return true;
  }

  recordSuccess(at = this.now()) {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.openUntil = null;
    this.lastSuccessAt = at;
    this.#probeInFlight = false;
    this.#persist();
  }

  cancelAttempt() {
    this.#probeInFlight = false;
  }

  recordFailure({ kind = "transient", affectsCircuit = true } = {}, at = this.now()) {
    this.lastFailureAt = at;
    this.#probeInFlight = false;
    if (!affectsCircuit) {
      this.#persist();
      return;
    }
    this.consecutiveFailures += 1;
    if (
      this.state === "HALF_OPEN" ||
      kind === "quota" ||
      kind === "rate_limit" ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      const wasOpen = this.state === "OPEN";
      this.state = "OPEN";
      this.openedAt = at;
      this.openUntil = at + this.openMs;
      if (!wasOpen) this.openCount += 1;
    }
    this.#persist();
  }

  getSnapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      openUntil: this.openUntil,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openCount: this.openCount,
      halfOpenBatch: this.halfOpenBatch,
    };
  }
}
