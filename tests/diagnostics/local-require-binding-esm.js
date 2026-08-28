export {};

function require(specifier) {
  console.log("local", specifier);
}

require("node:path");
