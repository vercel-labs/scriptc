// An untyped module with a class of its own and a write with a computed key.
export class Recorder {
  constructor() {
    this.notes = [];
  }
  note(text) {
    this.notes.push(text);
  }
  count() {
    return this.notes.length;
  }
}

export function tag(target, key, value) {
  target[key] = value;
  return target[key];
}
