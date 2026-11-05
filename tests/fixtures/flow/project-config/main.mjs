import { apply, begin, echo, finish, kindOf, pairOf, score, setHandler, write } from "./store.js";

begin();
write("a");
write("b");
process.stdout.write(finish());
process.stdout.write(finish());

const table = new Map([["x", 2]]);
console.log(score(table, "x"), score(table, "y"));
const payload = JSON.parse('{"kind":"event","extra":[1,2]}');
console.log(kindOf(payload), pairOf(payload, table), JSON.stringify(echo(payload)));
console.log(apply(3));
setHandler((n) => n * n);
console.log(apply(3));
