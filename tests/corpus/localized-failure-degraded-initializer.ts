// Localized failure, stage L4, at a forward-captured binding: functions
// declared before a const capture it, and the const's initializer has an
// expression whose type does not compile. The statement lowers again with
// that expression degraded, and it initializes the binding the functions
// captured: before the declaration a call throws ReferenceError, after it
// the call reads the value.
type Hook = Map<string, (x: number) => string> | AbortSignal | (() => number) | Set<string>;
interface Plugin {
  name: string;
  hook: Hook;
}
function load(text: string): unknown {
  return JSON.parse(text);
}
function main(): void {
  function nameOf(): string {
    return plugin.name;
  }
  function attempt(): string {
    try {
      return nameOf();
    } catch (e) {
      return e instanceof ReferenceError ? "ReferenceError" : "other";
    }
  }
  console.log(attempt());
  const plugin = { name: (load('{"name":"tags","hook":null}') as Plugin).name };
  console.log(attempt(), nameOf().length);
}
main();
