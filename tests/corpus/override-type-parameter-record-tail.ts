// An override that adds optional parameters typed with the subclass's own
// type parameter has no value an ancestor's slot could carry: `T` names
// nothing on the base, and a record or array built over it (`{ value: T }`,
// `{ value: T }[]`) is just as unnameable. The family reserves no slot, so
// the base keeps its own shape and compiles on its own, and a base-typed
// call reaches the override with the added argument absent exactly as in
// Node.
class Recorder {
  events: string[] = [];
  emit(name: string): void {
    this.events.push(name);
  }
}

class PayloadRecorder<T> extends Recorder {
  seen: string[] = [];
  override emit(name: string, payload?: { value: T }): void {
    this.events.push(name);
    this.seen.push(payload === undefined ? "absent" : String(payload.value));
  }
}

const recorder = new Recorder();
recorder.emit("plain");
recorder.emit("again");
console.log("base:", recorder.events.join(","));

const throughBase: Recorder = new PayloadRecorder<string>();
throughBase.emit("via-base");
console.log("via base:", throughBase.events.join(","), recorder.events.join(","));

const payloads = new PayloadRecorder<string>();
payloads.emit("absent");
payloads.emit("present", { value: "v" });
console.log("payloads:", payloads.events.join(","), payloads.seen.join(","));

// The same slot over a generic base instantiated with a concrete argument:
// with nothing reserved, the base's instantiation has only its own method
// and compiles, while the subclass keeps its added argument.
class GenericBase<U> {
  names: string[] = [];
  push(name: string): void {
    this.names.push(name);
  }
}

class GenericRecorder<T> extends GenericBase<string> {
  extras: string[] = [];
  override push(name: string, extra?: { value: T }): void {
    this.names.push(name);
    this.extras.push(extra === undefined ? "absent" : String(extra.value));
  }
}

const genericBase = new GenericBase<number>();
genericBase.push("one");
console.log("generic base:", genericBase.names.join(","));

const genericThroughBase: GenericBase<string> = new GenericRecorder<boolean>();
genericThroughBase.push("two");
const genericRecorder = new GenericRecorder<boolean>();
genericRecorder.push("three");
genericRecorder.push("four", { value: true });
console.log(
  "generic sub:",
  genericThroughBase.names.join(","),
  genericRecorder.names.join(","),
  genericRecorder.extras.join(","),
);

// Nested records and arrays of records are unnameable for the same reason.
class Painter {
  out: string[] = [];
  paint(label: string): void {
    this.out.push(label);
  }
}

class LayeredPainter<T> extends Painter {
  override paint(
    label: string,
    options?: { inner?: { value: T } },
    list?: { value: T }[],
  ): void {
    this.out.push(
      label,
      options?.inner === undefined ? "no-inner" : String(options.inner.value),
      list === undefined ? "no-list" : `${list.length}:${String(list[0]?.value)}`,
    );
  }
}

const painter = new Painter();
painter.paint("plain");
const layered = new LayeredPainter<number>();
layered.paint("absent");
layered.paint("present", { inner: { value: 7 } }, [{ value: 1 }, { value: 2 }]);
console.log("paint:", painter.out.join(","), layered.out.join(","));
