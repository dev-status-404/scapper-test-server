import { ProviderError } from "../errors.js";

const stateByProvider = new Map();

export class ProviderCircuitBreaker {
  constructor({
    provider,
    failureThreshold = 5,
    cooldownMs = 60000,
    clock = () => Date.now(),
  }) {
    this.provider = provider;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.clock = clock;
  }

  get state() {
    if (!stateByProvider.has(this.provider)) {
      stateByProvider.set(this.provider, {
        failures: 0,
        openedUntil: 0,
        lastError: null,
      });
    }
    return stateByProvider.get(this.provider);
  }

  assertCanCall() {
    const state = this.state;
    if (state.openedUntil > this.clock()) {
      throw new ProviderError("provider-circuit-open", {
        provider: this.provider,
        retryable: true,
        metadata: {
          opened_until: new Date(state.openedUntil).toISOString(),
          last_error: state.lastError,
        },
      });
    }
  }

  recordSuccess() {
    stateByProvider.set(this.provider, {
      failures: 0,
      openedUntil: 0,
      lastError: null,
    });
  }

  recordFailure(error) {
    const state = this.state;
    state.failures += 1;
    state.lastError = error?.name || error?.message || "ProviderError";

    if (state.failures >= this.failureThreshold) {
      state.openedUntil = this.clock() + this.cooldownMs;
    }
  }
}

export const resetCircuitBreakersForTests = () => {
  stateByProvider.clear();
};

