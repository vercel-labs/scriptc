// A package's "scriptc" import condition selects the implementation the
// compiled program uses; Node takes the default one.
import { register } from "#register";

console.log(register(() => "hook"));
