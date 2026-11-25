// Bindings another module declares without an initializer and assigns only
// inside its exported functions.
import { current, hit, hits, register, remember, setCurrent, state } from "./state.ts";

console.log(typeof current, current === undefined, typeof hits, hits ?? "none");
setCurrent("first");
console.log(typeof current, current.name);
console.log(hit(), hit(), hits);
console.log(register("a"), register("b"));
console.log(remember("x"), remember("y"));
console.log(state());
