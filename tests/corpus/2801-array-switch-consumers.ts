let discriminantCalls = 0;
function discriminant(): string | undefined {
  discriminantCalls++;
  return ["b"][0];
}
switch (discriminant()) {
  case "a":
    console.log("a");
    break;
  case "b":
    console.log("b");
    break;
  default:
    console.log("default");
}
console.log("discriminant calls", discriminantCalls);

function thrown(value: string): string {
  switch ([value][0]) {
    case "x": {
      throw new Error("x");
    }
    default:
      return "ok";
  }
}
console.log("switch", thrown("y"));
