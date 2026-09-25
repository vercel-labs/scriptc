console.log("ab".repeat(NaN), "ab".repeat(null), "ab".repeat(undefined));
console.log("ab".repeat(false), "ab".repeat(true), "ab".repeat("0"));
console.log("ab".repeat("2"), "ab".repeat(" 3 "), "ab".repeat(2.9));

let calls = 0;
function count(choice) {
  calls++;
  if (choice === 0) return "2";
  if (choice === 1) return true;
  if (choice === 2) return null;
  return undefined;
}
for (let choice = 0; choice < 4; choice++) {
  console.log(choice, "x".repeat(count(choice)));
}
console.log("calls", calls);

let trace = "";
function receiver() { trace += "r"; return "z"; }
function argument() { trace += "a"; return "2"; }
console.log(receiver().repeat(argument()), trace);
