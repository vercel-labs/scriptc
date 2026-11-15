// The shape overlay types a record at the declaration that creates it. A
// second name that refers to the record keeps referring to the same object,
// so a write through either name is visible through the other.
import { openRecord } from "shape-alias";

console.log(JSON.stringify(openRecord()));
