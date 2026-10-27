// Object.assign copying a class instance into a fresh object: the result
// is a plain object holding the instance's own fields, never an instance,
// so a result the checker types as the class is refused rather than
// failing its checked cast at run time.
class Config {
  b = 1;
  a = 2;
}
const config = new Config();
const copy = Object.assign({}, config);
console.log(JSON.stringify(copy), Object.keys(copy).join(","));
