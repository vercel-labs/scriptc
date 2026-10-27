// Number.parseInt over untyped values in JavaScript, with and without a
// radix: the argument converts with ToString first ("undefined", "null",
// "1,2" for an array), then parses as the global parseInt does.
const config = JSON.parse('{"port":"8080","hex":"0xff","list":[3,4],"flag":true,"none":null}');
for (const key of ["port", "hex", "list", "flag", "none", "missing"]) {
  const value = config[key];
  console.log(key, Number.parseInt(value), Number.parseInt(value, 16), Number.parseInt(value, 36));
}
console.log("argv", Number.parseInt(process.argv[2]));
