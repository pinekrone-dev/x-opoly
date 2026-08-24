/**
 * In-memory registry of crawl jobs.
 *
 * Results live only as long as the process does, which is the right trade-off
 * for a tool where every run is a fresh crawl. Jobs are evicted once they are
 * older than the TTL so a long-lived server does not grow without bound.
 */

import { randomUUID } from 'node:crypto'

const JOB_TTL_MS = 30 * 60 * 1000
const MAX_JOBS = 50
const MAX_ACTIVE_JOBS = 4

export class JobStore {
  constructor({ ttlMs = JOB_TTL_MS, maxJobs = MAX_JOBS, maxActive = MAX_ACTIVE_JOBS } = {}) {
    this.jobs = new Map()
    this.ttlMs = ttlMs
    this.maxJobs = maxJobs
    this.maxActive = maxActive
  }

  newId() {
    return randomUUID().slice(0, 12)
  }

  activeCount() {
    let count = 0
    for (const job of this.jobs.values()) {
      if (job.isActive) count += 1
    }
    return count
  }

  atCapacity() {
    return this.activeCount() >= this.maxActive
  }

  add(job) {
    this.jobs.set(job.id, { job, createdAt: Date.now() })
    this.prune()
    return job
  }

  get(id) {
    return this.jobs.get(id)?.job || null
  }

  prune() {
    const now = Date.now()
    for (const [id, entry] of this.jobs) {
      if (entry.job.isActive) continue
      if (now - entry.createdAt > this.ttlMs) this.jobs.delete(id)
    }
    while (this.jobs.size > this.maxJobs) {
      const oldest = [...this.jobs.entries()]
        .filter(([, entry]) => !entry.job.isActive)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (!oldest) break
      this.jobs.delete(oldest[0])
    }
  }
}
