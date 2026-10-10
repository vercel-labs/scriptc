// A request counter keeps integer statistics while request failures are
// reported through Error subclasses that forward their message and options
// to Error, as a server's error type does next to its hot bookkeeping.
class Stats {
  requests: number;
  flags: number;
  bytes: number;
  constructor() {
    this.requests = 0;
    this.flags = 0;
    this.bytes = 0;
  }
  record(size: number, flag: number): void {
    this.requests = this.requests + 1;
    this.flags |= flag;
    this.bytes = (this.bytes + size) | 0;
  }
}

class ServiceError extends Error {}

class TimeoutError extends ServiceError {
  constructor(message: string, options: { cause: unknown }) {
    super(`timeout: ${message}`, options);
  }
}

const stats = new Stats();
const errors: ServiceError[] = [];
for (let i = 0; i < 12; i++) {
  stats.record(i * 100, 1 << (i % 5));
  if (i % 4 === 3) errors.push(new TimeoutError(`request ${i}`, { cause: `attempt ${stats.requests}` }));
  if (i % 6 === 5) errors.push(new ServiceError(`failed ${i}`));
}
console.log(stats);
for (const error of errors) {
  console.log(error instanceof TimeoutError, error.name, error.message, String(error.cause));
}
stats.record(7, 64);
console.log(stats.requests, stats.flags, stats.bytes);
try {
  throw new TimeoutError("final", { cause: stats.flags });
} catch (error) {
  if (error instanceof ServiceError) console.log(error.message, String(error.cause), error instanceof Error);
}
