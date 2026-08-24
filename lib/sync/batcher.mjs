export class AdaptiveBatcher {
  constructor({ minSize = 25, maxSize = 100, growthStep = 10 } = {}) {
    if (!Number.isInteger(minSize) || minSize < 1) {
      throw new TypeError("minSize must be a positive integer.");
    }
    if (!Number.isInteger(maxSize) || maxSize < minSize) {
      throw new TypeError("maxSize must be at least minSize.");
    }
    if (!Number.isInteger(growthStep) || growthStep < 1) {
      throw new TypeError("growthStep must be a positive integer.");
    }
    this.minSize = minSize;
    this.maxSize = maxSize;
    this.growthStep = growthStep;
    this.currentSize = minSize;
  }

  sizeFor({ circuitState = "CLOSED", halfOpenBatch = 1 } = {}) {
    return circuitState === "HALF_OPEN"
      ? Math.max(1, Math.min(this.currentSize, halfOpenBatch))
      : this.currentSize;
  }

  recordSuccess() {
    this.currentSize = Math.min(this.maxSize, this.currentSize + this.growthStep);
    return this.currentSize;
  }

  recordFailure() {
    this.currentSize = Math.max(this.minSize, Math.floor(this.currentSize / 2));
    return this.currentSize;
  }

  reset() {
    this.currentSize = this.minSize;
  }
}
