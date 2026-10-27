// An untyped JavaScript lock whose async acquire resolves to an untyped
// ticket.
export class Lock {
  constructor() {
    this.held = false;
    this.log = [];
    this.queue = makeQueue(this.log);
  }
  async acquire() {
    const ticket = await this.queue.wait();
    this.held = true;
    this.log.push("base acquire");
    return ticket;
  }
  release() {
    this.held = false;
  }
}

function makeQueue(log) {
  return { wait: () => new Promise((resolve) => setTimeout(() => resolve(log.length), 1)) };
}
