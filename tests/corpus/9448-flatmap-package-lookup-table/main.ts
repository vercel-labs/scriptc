// A package builds a lookup table when its module is evaluated, with
// Object.fromEntries(Object.entries(table).flatMap(([name, entry]) =>
// cond ? [[key, name]] : [])). The package is compiled into the program, so
// the table is built at start-up: the program must start and read it.
import { BY_CODE, nameOf } from "size-kit";
console.log(nameOf("s"), nameOf("l"), nameOf("x"), Object.keys(BY_CODE).join(","));
