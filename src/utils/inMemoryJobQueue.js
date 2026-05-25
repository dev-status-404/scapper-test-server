import { EventEmitter } from "events";

const TERMINAL_STATES = new Set(["completed", "failed"]);

const toMillis = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const computeBackoffDelay = (backoff, attemptsMade) => {
  if (!backoff) return 0;

  if (typeof backoff === "number") {
    return Math.max(0, backoff);
  }

  const baseDelay = Math.max(0, toMillis(backoff.delay, 0));
  if (!baseDelay) return 0;

  let delay = baseDelay;
  if (backoff.type === "exponential") {
    delay = baseDelay * Math.max(1, 2 ** Math.max(0, attemptsMade - 1));
  }

  const jitter = Math.min(1, Math.max(0, Number(backoff.jitter || 0)));
  if (jitter > 0) {
    const spread = delay * jitter;
    delay = delay - spread + Math.random() * spread * 2;
  }

  return Math.max(0, Math.round(delay));
};

const matchesState = (job, states = []) => {
  if (!states.length) return true;
  return states.includes(job.state);
};

export class QueueRescheduleError extends Error {
  constructor(delayMs, message = "queue-job-rescheduled") {
    super(message);
    this.name = "QueueRescheduleError";
    this.delayMs = Math.max(0, toMillis(delayMs, 0));
  }
}

class InMemoryJob {
  constructor(queue, name, data, opts = {}) {
    this.queue = queue;
    this.name = name;
    this.id = String(opts.jobId || queue.nextId++);
    this.data = data;
    this.opts = {
      ...queue.defaultJobOptions,
      ...opts,
    };
    this.progress = 0;
    this.attemptsMade = 0;
    this.timestamp = Date.now();
    this.processedOn = null;
    this.finishedOn = null;
    this.failedReason = null;
    this.returnvalue = null;
    this.state = this.opts.delay > 0 ? "delayed" : "waiting";
    this.availableAt = this.opts.delay > 0 ? Date.now() + this.opts.delay : Date.now();
    this.token = `memory:${this.id}`;
    this.removeTimer = null;
  }

  async getState() {
    return this.state;
  }

  async updateData(data) {
    this.data = data;
    return this;
  }

  async updateProgress(progress) {
    this.progress = progress;
    return this;
  }

  async remove() {
    this.queue.removeJob(this.id);
    return true;
  }

  async changeDelay(delayMs) {
    this.queue.delayJob(this.id, delayMs);
    return this;
  }

  async moveToDelayed(timestamp) {
    const delayMs = Math.max(0, Number(timestamp || 0) - Date.now());
    this.queue.delayJob(this.id, delayMs);
    return true;
  }
}

export class InMemoryJobQueue extends EventEmitter {
  constructor(name, { defaultJobOptions = {}, concurrency = 1 } = {}) {
    super();
    this.name = name;
    this.defaultJobOptions = defaultJobOptions;
    this.concurrency = Math.max(1, toMillis(concurrency, 1));
    this.jobs = new Map();
    this.nextId = 1;
    this.activeCount = 0;
    this.processor = null;
    this.drainScheduled = false;
    this.delayTimer = null;
  }

  setProcessor(processor, { concurrency = null } = {}) {
    this.processor = processor;
    if (concurrency != null) {
      this.concurrency = Math.max(1, toMillis(concurrency, this.concurrency));
    }
    this.scheduleDrain();
    return this;
  }

  async add(name, data, opts = {}) {
    const requestedJobId = opts.jobId != null ? String(opts.jobId) : null;
    if (requestedJobId) {
      const existing = this.jobs.get(requestedJobId);
      if (existing && !TERMINAL_STATES.has(existing.state)) {
        return existing;
      }
      if (existing) {
        this.removeJob(requestedJobId);
      }
    }

    const job = new InMemoryJob(this, name, data, opts);
    this.jobs.set(job.id, job);
    this.scheduleDrain();
    return job;
  }

  async addBulk(entries = []) {
    const jobs = [];
    for (const entry of entries) {
      jobs.push(await this.add(entry.name, entry.data, entry.opts || {}));
    }
    return jobs;
  }

  async getJob(jobId) {
    return this.jobs.get(String(jobId)) || null;
  }

  async getJobs(states = [], start = 0, end = -1) {
    const filtered = Array.from(this.jobs.values())
      .filter((job) => matchesState(job, states))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const normalizedEnd = end == null || end < 0 ? filtered.length : end + 1;
    return filtered.slice(Math.max(0, start), normalizedEnd);
  }

  async getJobCounts(...states) {
    const counts = {};
    if (!states.length) return counts;

    for (const state of states) {
      counts[state] = 0;
    }

    for (const job of this.jobs.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, job.state)) {
        counts[job.state] += 1;
      }
    }

    return counts;
  }

  removeJob(jobId) {
    const key = String(jobId);
    const job = this.jobs.get(key);
    if (!job) return false;
    if (job.removeTimer) clearTimeout(job.removeTimer);
    this.jobs.delete(key);
    this.scheduleDrain();
    return true;
  }

  delayJob(jobId, delayMs) {
    const job = this.jobs.get(String(jobId));
    if (!job) return null;
    job.state = delayMs > 0 ? "delayed" : "waiting";
    job.availableAt = Date.now() + Math.max(0, toMillis(delayMs, 0));
    job.finishedOn = null;
    this.scheduleDrain();
    return job;
  }

  scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain().catch((error) => {
        console.error(`[${this.name}] In-memory queue drain failed:`, error);
      });
    });
  }

  scheduleNextDelayedDrain() {
    if (this.delayTimer) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }

    let nextAvailableAt = null;
    for (const job of this.jobs.values()) {
      if (job.state !== "delayed") continue;
      if (nextAvailableAt == null || job.availableAt < nextAvailableAt) {
        nextAvailableAt = job.availableAt;
      }
    }

    if (nextAvailableAt == null) return;

    const waitMs = Math.max(0, nextAvailableAt - Date.now());
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      this.scheduleDrain();
    }, waitMs);
  }

  promoteReadyDelayedJobs() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.state === "delayed" && job.availableAt <= now) {
        job.state = "waiting";
      }
    }
  }

  getNextReadyJob() {
    const now = Date.now();
    const candidates = Array.from(this.jobs.values())
      .filter((job) => job.state === "waiting" && job.availableAt <= now)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return candidates[0] || null;
  }

  async drain() {
    if (!this.processor) {
      this.scheduleNextDelayedDrain();
      return;
    }

    this.promoteReadyDelayedJobs();

    while (this.activeCount < this.concurrency) {
      const job = this.getNextReadyJob();
      if (!job) break;
      this.startJob(job);
    }

    this.scheduleNextDelayedDrain();
  }

  startJob(job) {
    job.state = "active";
    job.processedOn = Date.now();
    job.finishedOn = null;
    job.failedReason = null;
    job.returnvalue = null;
    this.activeCount += 1;
    this.emit("active", job);

    Promise.resolve(this.processor(job))
      .then((result) => this.completeJob(job, result))
      .catch((error) => this.failJob(job, error))
      .finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.scheduleDrain();
      });
  }

  completeJob(job, result) {
    job.state = "completed";
    job.returnvalue = result ?? null;
    job.finishedOn = Date.now();
    this.emit("completed", job, result);
    this.scheduleAutoRemoval(job, "removeOnComplete");
  }

  failJob(job, error) {
    if (error instanceof QueueRescheduleError) {
      job.state = error.delayMs > 0 ? "delayed" : "waiting";
      job.availableAt = Date.now() + error.delayMs;
      return;
    }

    job.attemptsMade += 1;
    const maxAttempts = Math.max(1, toMillis(job.opts.attempts, 1));

    if (job.attemptsMade < maxAttempts) {
      const delayMs = computeBackoffDelay(job.opts.backoff, job.attemptsMade);
      job.state = delayMs > 0 ? "delayed" : "waiting";
      job.availableAt = Date.now() + delayMs;
      job.failedReason = error?.message || "queue-job-retry";
      return;
    }

    job.state = "failed";
    job.failedReason = error?.message || "queue-job-failed";
    job.finishedOn = Date.now();
    this.emit("failed", job, error);
    this.scheduleAutoRemoval(job, "removeOnFail");
  }

  scheduleAutoRemoval(job, optionName) {
    if (!TERMINAL_STATES.has(job.state)) return;
    const option = job.opts?.[optionName];
    const ageSeconds =
      typeof option === "object" && option
        ? toMillis(option.age, 0)
        : toMillis(option, 0);

    if (ageSeconds <= 0) return;

    if (job.removeTimer) clearTimeout(job.removeTimer);
    job.removeTimer = setTimeout(() => {
      this.removeJob(job.id);
    }, ageSeconds * 1000);
  }
}

export default InMemoryJobQueue;
