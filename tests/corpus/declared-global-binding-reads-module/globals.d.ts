// The module form of a declared global: this declaration file is a module
// (`export {}`), and the bindings `declare global` holds exist only as
// types. TypeScript erases them, so Node resolves a bare reference through
// the global object, exactly as it does for the script-style form.
export {};
interface Doc {
  getElementById(id: string): { id: string } | null;
}
declare global {
  const document: Doc;
  var counter: number;
}
