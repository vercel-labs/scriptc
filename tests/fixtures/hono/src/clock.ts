/* Time is injected so the service is deterministic under test: the fixture
 * clock starts at a fixed instant and advances one second per reading. */

export interface Clock {
  now(): number;
}

export class SteppingClock implements Clock {
  private current: number;
  private readonly stepMs: number;

  constructor(start: number, stepMs: number) {
    this.current = start;
    this.stepMs = stepMs;
  }

  now(): number {
    const value = this.current;
    this.current += this.stepMs;
    return value;
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function daysBetween(fromIso: string, toMs: number): number {
  return Math.floor((toMs - Date.parse(fromIso)) / DAY_MS);
}
