// The public `arg` package (npm arg 5.0.2, MIT), compiled with the program:
// its specification holds constructors as type tags, and the package
// compares them with its own (`fn === Boolean`, `type === Number`), tests
// them with typeof and Array.isArray, and calls them with a value, a name
// and the previous value.
import arg from "arg";

function parse(argv: string[], permissive: boolean) {
  return arg(
    {
      "--help": Boolean,
      "--name": String,
      "--port": Number,
      "--tag": [String],
      "--verbose": arg.COUNT,
      "-h": "--help",
      "-n": "--name",
      "-p": "--port",
      "-t": "--tag",
      "-v": "--verbose",
    },
    { argv, permissive },
  );
}

const args = parse(
  ["resize", "-h", "--name", "site", "-p", "8080", "--tag", "a", "-t", "b", "--tag=c", "-vv", "rest"],
  false,
);
console.log(args._.join(","));
console.log(args["--help"], args["--name"], args["--port"], typeof args["--port"]);
console.log(args["--tag"]?.join("+"), args["--verbose"]);

for (const argv of [["--nope"], ["--name"], ["-hn"], ["--port", "--help"]]) {
  try {
    parse(argv, false);
  } catch (err) {
    if (err instanceof arg.ArgError) console.log(err.name, err.code, err.message);
    else console.log("another error");
  }
}

const loose = parse(["--nope", "--port", "-3", "--", "--name", "x"], true);
console.log(loose._.join(","), loose["--port"], loose["--name"]);
