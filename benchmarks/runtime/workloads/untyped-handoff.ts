// A dispatch board. Producers file typed work orders; the board keeps each
// order as `unknown` beside the handler that declared its type; a round hands
// every order back to its handler, which reads it at its own type. This is
// what a container or a framework does with a caller's record: store it
// untyped, return it to the code that knows what it is.
//
// The orders reach the board four ways: an annotated binding, a literal
// checked with `satisfies`, a literal passed for a parameter whose type is
// the handler's own parameter type, and a bare literal that its handler
// reads with `as`. Handlers with a declared parameter sit behind
// `(order: any) => number`; one takes `unknown` and asserts.
interface Shipment {
  id: number;
  dock: string;
  crates: number;
  fragile: boolean;
}
interface Repair {
  id: number;
  machine: string;
  hours?: number;
  note?: string;
}
interface Audit {
  id: number;
  ledger: string;
  lines: number;
  flagged?: boolean;
}
interface Refill {
  id: number;
  bay: number;
  litres: number;
}

type Handler = (order: any) => number;

class Ticket {
  handler: Handler;
  order: unknown;
  constructor(handler: Handler, order: unknown) {
    this.handler = handler;
    this.order = order;
  }
}

function ship(order: Shipment): number {
  return order.id + order.crates + order.dock.length + (order.fragile ? 1 : 0);
}

function repair(order: Repair): number {
  const note = order.note === undefined ? 0 : order.note.length;
  return order.id + (order.hours ?? 1) + order.machine.length + note;
}

function audit(order: Audit): number {
  return order.id + order.lines + order.ledger.length + (order.flagged === true ? 2 : 0);
}

function refill(order: unknown): number {
  const r = order as Refill;
  return r.id + r.bay + r.litres;
}

function file<H extends Handler>(board: Ticket[], handler: H, order: Parameters<H>[0]): void {
  board.push(new Ticket(handler, order));
}

const scale = Number(process.argv[2] ?? "1");
const count = 4000;
const rounds = Math.max(1, Math.round(250 * scale));

const board: Ticket[] = [];
for (let i = 0; i < count; i++) {
  const kind = i & 3;
  if (kind === 0) {
    const order: Shipment = { id: i, dock: "d" + (i & 7), crates: i % 13, fragile: (i & 8) === 0 };
    board.push(new Ticket(ship, order));
  } else if (kind === 1) {
    board.push(new Ticket(repair, { id: i, machine: "m" + (i & 7), hours: i % 5 } satisfies Repair));
  } else if (kind === 2) {
    file(board, audit, { id: i, ledger: "l" + (i & 15), lines: i % 40 });
  } else {
    board.push(new Ticket(refill, { id: i, bay: i % 6, litres: 20 + (i % 9) }));
  }
}

let total = 0;
for (let round = 0; round < rounds; round++) {
  for (const ticket of board) total += ticket.handler(ticket.order);
}
console.log(board.length, rounds, total);
