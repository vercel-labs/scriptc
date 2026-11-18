// A record-valued class field that declares toJSON: Node calls the hook with
// the record as receiver and serializes its answer, so a layout write must
// keep the class on the runtime walk instead of exposing the record's fields.
interface Secret {
  value: string;
  toJSON(): { value: string };
}

class Box {
  secret: Secret;
  constructor(secret: Secret) {
    this.secret = secret;
  }
}

const secret: Secret = {
  value: "hunter2",
  toJSON() {
    return { value: "redacted" };
  },
};
console.log(JSON.stringify(new Box(secret)));
