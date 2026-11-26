// Imported by the program and by its island module: one class on both sides
// (NI-6). The getter answers a fresh view on every read, which is the
// accessor crossing this fixture measures.
export class Sink {
  constructor() {
    this.reads = 0;
  }

  get chunk() {
    this.reads++;
    return Buffer.alloc(65536);
  }
}
