// @define: process.env.NODE_ENV="production"
// Changing a variable `--define` fixes: the conditions its value decides were resolved at build time, so every form that names the variable is refused, also through a held `process.env` and as the value of a `delete`. Another variable stays writable.
const env = process.env;

process.env.NODE_ENV = "development";
process.env["NODE_ENV"] = "development";
env.NODE_ENV = "development";
delete process.env.NODE_ENV;
console.log(delete process.env.NODE_ENV);
console.log(delete process.env["NODE_ENV"]);
console.log(delete env.NODE_ENV);

process.env.OTHER = "changed";
delete process.env.OTHER;

if (process.env.NODE_ENV !== "production") {
  console.log("development");
} else {
  console.log(process.env.NODE_ENV === "production" ? "production" : "development");
}
