// `import type` erases under Node's type stripping: twinned is never
// loaded, so no package is selected or refused, and its declared
// interface types a value the program builds itself.
import type { Greeting } from "twinned";

const greeting: Greeting = { text: "hello" };
console.log(greeting.text);
