// Memory monitoring utility for tracking and optimizing resource usage

/**
 * Get current memory usage in MB
 */
export const getMemoryUsage = () => {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // Resident Set Size (total memory)
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // Total heap
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // Used heap
    external: Math.round(usage.external / 1024 / 1024), // External C++ objects
    arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024), // ArrayBuffers
  };
};

/**
 * Log memory usage with optional label
 */
export const logMemoryUsage = (label = "") => {
  const usage = getMemoryUsage();
  const prefix = label ? `[${label}]` : "[Memory]";
  console.log(
    `${prefix} RSS: ${usage.rss}MB | Heap: ${usage.heapUsed}/${usage.heapTotal}MB | External: ${usage.external}MB`,
  );
  return usage;
};

/**
 * Check if memory usage is approaching limits
 * @param {number} threshold - Percentage threshold (default 80%)
 * @returns {boolean} True if memory usage is high
 */
export const isMemoryHigh = (threshold = 80) => {
  const usage = process.memoryUsage();
  const heapPercentage = (usage.heapUsed / usage.heapTotal) * 100;
  return heapPercentage >= threshold;
};

/**
 * Force garbage collection if available
 * Note: Requires --expose-gc flag when starting Node.js
 */
export const forceGarbageCollection = () => {
  if (global.gc) {
    const before = getMemoryUsage();
    global.gc();
    const after = getMemoryUsage();
    const freed = before.heapUsed - after.heapUsed;
    console.log(`[Memory] Garbage collection freed ${freed}MB`);
    return freed;
  } else {
    console.log(
      "[Memory] Garbage collection not available. Start with --expose-gc flag.",
    );
    return 0;
  }
};

/**
 * Monitor memory usage during async operations
 * @param {Function} asyncFn - Async function to monitor
 * @param {string} label - Label for logging
 */
export const monitorMemory = async (asyncFn, label = "Operation") => {
  console.log(`\n[Memory Monitor] Starting: ${label}`);
  const startUsage = logMemoryUsage("Before");
  const startTime = Date.now();

  try {
    const result = await asyncFn();

    const endTime = Date.now();
    const endUsage = logMemoryUsage("After");
    const duration = endTime - startTime;
    const memoryDelta = endUsage.rss - startUsage.rss;

    console.log(`[Memory Monitor] ${label} completed in ${duration}ms`);
    console.log(
      `[Memory Monitor] Memory delta: ${memoryDelta > 0 ? "+" : ""}${memoryDelta}MB\n`,
    );

    return result;
  } catch (error) {
    logMemoryUsage("Error State");
    throw error;
  }
};

/**
 * Memory usage tracker for scraping operations
 */
export class MemoryTracker {
  constructor(label = "Task") {
    this.label = label;
    this.checkpoints = [];
    this.startTime = Date.now();
    this.checkpoint("start");
  }

  checkpoint(name) {
    const usage = getMemoryUsage();
    const elapsed = Date.now() - this.startTime;
    this.checkpoints.push({ name, usage, elapsed });
    console.log(
      `[${this.label}] ${name} @ ${elapsed}ms - Heap: ${usage.heapUsed}MB`,
    );
  }

  summary() {
    if (this.checkpoints.length < 2) return;

    const start = this.checkpoints[0];
    const end = this.checkpoints[this.checkpoints.length - 1];
    const duration = end.elapsed;
    const memoryDelta = end.usage.rss - start.usage.rss;
    const peakMemory = Math.max(...this.checkpoints.map((c) => c.usage.rss));

    console.log(`\n[${this.label}] Summary:`);
    console.log(`  Duration: ${duration}ms`);
    console.log(
      `  Memory Delta: ${memoryDelta > 0 ? "+" : ""}${memoryDelta}MB`,
    );
    console.log(`  Peak Memory: ${peakMemory}MB`);
    console.log(`  Checkpoints: ${this.checkpoints.length}`);

    return {
      duration,
      memoryDelta,
      peakMemory,
      checkpoints: this.checkpoints,
    };
  }
}

// Auto-log memory usage every 30 seconds; trigger GC if heap is high
if (process.env.NODE_ENV === "development") {
  setInterval(() => {
    if (isMemoryHigh(75)) {
      logMemoryUsage("High Memory Warning");
      forceGarbageCollection(); // no-op unless --expose-gc is set
    }
  }, 30000);
}

// In all environments: force GC every 5 minutes if heap > 85%
setInterval(() => {
  if (isMemoryHigh(85)) {
    forceGarbageCollection();
  }
}, 5 * 60 * 1000);
