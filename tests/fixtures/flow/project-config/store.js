// No pragma: `"all": true` compiles every module of the project as Flow.
import origin, {platform, newline} from './config.js';

declare var __DEV__: boolean;

// Values from outside the program, whose Flow type is stricter than the
// values (they may lack `count`): compiled as unknown (dynamicTypes).
export type Payload = {kind: string, count: number, ...};

// A symbol Flow sees as `true`; the project types it as the unique symbol
// it is (flow.types), so `!== MISSING` narrows it away.
type Missing = true;
export const MISSING: Missing = (Symbol('missing'): any);

class Buffer {
  parts: Array<string> = [];
  add(part: string): void {
    this.parts.push(part);
  }
}

// Assigned only `new Buffer()`: a Buffer or null.
let current = null;

export function begin(): void {
  current = new Buffer();
}

export function write(part: string): void {
  if (__DEV__) {
    throw new Error('dev builds check every write');
  }
  if (current !== null) current.add(part);
}

export function finish(): string {
  const text = current === null ? '' : current.parts.join('');
  current = null;
  return text + platform + ' ' + origin + newline();
}

export function lookup(table: Map<string, number>, key: string): number | Missing {
  const found = table.get(key);
  return found === undefined ? MISSING : found;
}

export function score(table: Map<string, number>, key: string): number {
  const value = lookup(table, key);
  if (value !== MISSING) return value * 10;
  return -1;
}

export function kindOf(payload: Payload): string {
  return payload.kind;
}

// A dynamic type takes the value as it is: no declared field is required
// and every other property stays.
export function echo(payload: Payload): Payload {
  return payload;
}

// A pair of references: the tuple Flow infers.
export function pairOf(payload: Payload, table: Map<string, number>): string {
  const pair = [payload.kind, table.size];
  return pair[0] + ':' + String(pair[1]);
}

// Silenced null: the declared type holds null until set.
let handler: (n: number) => number = (null: any);
export function setHandler(next: (n: number) => number): void {
  handler = next;
}
export function apply(n: number): number {
  return handler === null ? n : handler(n);
}
