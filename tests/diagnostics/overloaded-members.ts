// Overloaded interface members compile as one stored function whose type
// joins the overloads; calls resolve per site, and a read of the member as a
// value is that function (tests/corpus/8937-overload-set-values). A set
// whose overloads do not join (here, a rest parameter beside a fixed one)
// keeps its fence.
interface Api {
  on(event: "a", handler: (x: number) => void): void;
  on(event: "b", handler: (x: string) => void): void;
}
const api: Api = {
  on(event: string, handler: (x: any) => void): void {
    handler(event === "a" ? 1 : "one");
  },
};
api.on("a", (x) => console.log(x + 1));

interface Emitter {
  emit(event: "many", ...values: number[]): void;
  emit(event: "one", value: string): void;
}
function fire(e: Emitter): void {
  e.emit("many", 1, 2);
}
console.log(typeof fire);
