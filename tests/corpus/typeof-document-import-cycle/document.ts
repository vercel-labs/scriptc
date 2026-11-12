import { document } from "./dom.ts";

export class Document {
  title = "checker";

  // Deferred: a method body, so this reference runs after the cycle.
  ready(): boolean {
    return document !== undefined;
  }
}
