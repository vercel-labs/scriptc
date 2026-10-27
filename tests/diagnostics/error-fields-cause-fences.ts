// Node prints an error's own properties in creation order, which puts a
// declared `cause` among the class's other fields. Inspecting an error
// class that declares `cause` beside other fields has no lowering.
import * as util from "node:util";

class Retried extends Error {
  override cause: unknown = "first attempt";
  retries = 2;
}

console.log(util.inspect(new Retried("failed")));
