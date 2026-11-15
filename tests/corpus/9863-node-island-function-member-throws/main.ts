// @requires-libnode
// A checked conversion into a record that holds a function mints the
// function's adapter, and a call through it can throw: here the function is
// an island's, and no function of the program throws. The call site tests
// for the exception like any call of a function value, so the `catch` runs.
// (The values are stored in an array first, so the assertion is the checked
// conversion: the build names the two stores with SC6007.)
import { plain, thrower } from "member-pkg";

type Named = { name: string; label(): string };
const bag: unknown[] = [];
bag.push(thrower());
bag.push(plain());

function run(index: number): void {
  const value = bag[index] as Named;
  try {
    console.log(value.name, value.label());
  } catch (e) {
    console.log("caught", e instanceof Error ? e.message : "not an error");
  }
}
run(0);
run(1);
