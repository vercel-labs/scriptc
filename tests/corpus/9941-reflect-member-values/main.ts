// Reflect.apply and Reflect.getPrototypeOf as function values in a natively
// compiled CommonJS package: exported, guarded by `typeof`, stored, held in
// an object and passed as an argument; called through the binding and
// through call, apply and bind; identity, name and length as in Node.
import { report } from "shelf-probe";

for (const line of report()) console.log(line);
