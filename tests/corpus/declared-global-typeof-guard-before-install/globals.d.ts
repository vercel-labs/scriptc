// A script-style declaration file: `document` and `counter` exist only as
// types. TypeScript erases them, so Node resolves a bare reference through
// the global object — the property the program stores there, and a
// ReferenceError on a read before that.
interface Doc {
  getElementById(id: string): { id: string } | null;
}
declare var document: Doc;
declare const counter: number;
