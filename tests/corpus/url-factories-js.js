// The URL factories and file-URL functions from a JavaScript source:
// arguments are coerced the way Node's do, a missing required argument is
// Node's ERR_MISSING_ARGS or ERR_INVALID_ARG_TYPE, and an invalid URL is
// null from parse and false from canParse.
import { URL, fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";

const run = (label, fn) => {
  try {
    const value = fn();
    console.log(label, "ok", typeof value, JSON.stringify(value));
  } catch (error) {
    console.log(label, "throw", error.code, error.name, error.message);
  }
};

const urlObject = { toString: () => "https://a/b?q" };
const pathObject = { toString: () => "/a/b" };

run("canParse zero", () => URL.canParse());
run("canParse null", () => URL.canParse(null));
run("canParse number", () => URL.canParse(7));
run("canParse object", () => URL.canParse(urlObject));
run("canParse base number", () => URL.canParse("/x", 7));
run("canParse bad base", () => URL.canParse("/x", "not a url"));
run("canParse url base", () => URL.canParse("/x", new URL("https://a/b")));
run("parse zero", () => URL.parse()?.href);
run("parse null", () => URL.parse(null)?.href);
run("parse number", () => URL.parse(7)?.href);
run("parse object", () => URL.parse(urlObject)?.href);
run("parse no base", () => URL.parse("/x")?.href);
run("parse bad base", () => URL.parse("/x", "not a url"));
run("parse bad input", () => URL.parse("not a url"));

run("pathToFileURL zero", () => pathToFileURL()?.href);
run("pathToFileURL null", () => pathToFileURL(null)?.href);
run("pathToFileURL number", () => pathToFileURL(7)?.href);
run("pathToFileURL object", () => pathToFileURL(pathObject)?.href);
run("pathToFileURL windows", () => pathToFileURL("/a b", { windows: true })?.href);
run("pathToFileURL bad option", () => pathToFileURL("/a", { windows: "yes" })?.href);

run("fileURLToPath zero", () => fileURLToPath());
run("fileURLToPath null", () => fileURLToPath(null));
run("fileURLToPath number", () => fileURLToPath(7));
run("fileURLToPath object", () => fileURLToPath({ toString: () => "file:///a/b" }));
run("fileURLToPath URL", () => fileURLToPath(new URL("file:///a/b")));
run("fileURLToPath http", () => fileURLToPath("http://a/b"));
run("fileURLToPath bad option", () => fileURLToPath("file:///a", { windows: 1 }));
run("fileURLToPathBuffer zero", () => fileURLToPathBuffer());
run("fileURLToPathBuffer number", () => fileURLToPathBuffer(7));
run("fileURLToPathBuffer URL", () => fileURLToPathBuffer(new URL("file:///a/b")));
run("fileURLToPathBuffer bytes", () => Array.from(fileURLToPathBuffer("file:///a/%FFb")));

run("revoke zero", () => URL.revokeObjectURL());
run("revoke number", () => URL.revokeObjectURL(7));
run("revoke boolean", () => URL.revokeObjectURL(true));
run("revoke array", () => URL.revokeObjectURL(["blob:x"]));
run("revoke boxed", () => URL.revokeObjectURL(new String("blob:x")));

// toString and toJSON through an untyped receiver.
const url = new URL("https://a/b?c#d");
const stringify = (value) => value.toString();
const json = (value) => value.toJSON();
run("toString untyped", () => stringify(url));
run("toJSON untyped", () => json(url));
