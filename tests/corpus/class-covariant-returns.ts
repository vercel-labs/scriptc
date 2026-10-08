abstract class Document {
  title = "draft";
  abstract copy(): Document;
}
abstract class NamedDocument extends Document {
  abstract copy(): NamedDocument;
  abstract name(): string;
}
class Note extends NamedDocument {
  text = "note";
  copy(): Note {
    const result = new Note();
    result.text = this.text;
    return result;
  }
  name(): string { return this.text; }
}
class Checklist extends NamedDocument {
  copy(): Checklist { return new Checklist(); }
  name(): string { return "checklist"; }
}
class RichNote extends Note {
  count = 7;
  copy(): RichNote {
    const result = new RichNote();
    result.text = this.text;
    result.count = this.count;
    return result;
  }
}
function duplicate(value: Document): Document { return value.copy(); }
function named(value: NamedDocument): string { return value.copy().name(); }
function note(value: Note): string { return value.copy().text; }
const plain = new Note();
const rich = new RichNote();
console.log(duplicate(plain) instanceof Note, duplicate(rich) instanceof RichNote);
console.log(named(plain), named(rich), note(rich), rich.copy().count);
const extracted = rich.copy;
console.log(extracted.call(rich).count, extracted === rich.copy);
const receiver: Note = rich;
console.log(receiver.copy === rich.copy, receiver.copy().text);

class Builder {
  value = 1;
  copy(): Builder { return new Builder(); }
  self(): this { return this; }
}
class DetailedBuilder extends Builder {
  label = "ready";
  copy(): DetailedBuilder { return new DetailedBuilder(); }
  self(): this { return this; }
}
const builder = new DetailedBuilder();
console.log(builder.copy().label, builder.self().label, builder.self() === builder);
function copyBuilder(value: Builder): Builder { return value.copy(); }
console.log(copyBuilder(builder) instanceof DetailedBuilder);

const createNote = (): Note => new Note();
const createDocument: () => Document = createNote;
console.log(createDocument === createNote, createDocument() instanceof Note);

function copiedViaMethod(value: Document): Document {
  const copy = value.copy;
  return copy.call(value);
}
console.log(copiedViaMethod(new Checklist()) instanceof Checklist);
console.log(copiedViaMethod(rich) instanceof RichNote);
