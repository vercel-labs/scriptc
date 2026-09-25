// A parameterized JavaScript function sees every supplied argument, even
// when called through a value and when optional positions are omitted.
export {};

let evaluations = 0;
function next(value) {
  evaluations++;
  return value;
}

function inspect(first, second) {
  console.log(arguments.length, arguments[0], arguments[1], arguments[2], first, second);
}

inspect(next(10), next(20));
const indirect = inspect;
indirect(next(30));
inspect();
inspect(next(40), next(50), next(60));

const choose = function (first, second) {
  return arguments.length === 1 ? first : second;
};
console.log(choose(7), choose(8, 9), evaluations);

function withDefault(value = 41) {
  console.log(arguments.length, arguments[0], value);
}
withDefault();
withDefault(undefined);
withDefault(5);
