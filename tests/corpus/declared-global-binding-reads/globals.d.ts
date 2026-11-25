// A script-style declaration file, listed in the project's files: the
// globals it declares exist only as types. TypeScript erases every one of
// them, so Node has no variable to read and resolves a bare reference
// through the global object — the value the program assigned there, or its
// ReferenceError when nothing did.
interface Doc {
  getElementById(id: string): { id: string } | null;
}
declare var document: Doc;
declare const counter: number;
declare var flags: boolean[];
declare var unused: string;
