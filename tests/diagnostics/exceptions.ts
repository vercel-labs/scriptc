// A catch CLAUSE that destructures compiles now (corpus 8603); a promise
// handler's destructuring parameter is the remaining SC1062 fence.
Promise.reject(new Error("boom")).catch(({ message }: any) => {
  console.log(message);
});
function f(): number {
  try {
    console.log("body");
  } finally {
    // A return inside finally replaces the pending completion.
    return 1;
  }
}
for (let i = 0; i < f(); i = i + 1) {
  try {
    if (i === 2) {
      break;
    }
  } finally {
    console.log("per-iteration cleanup");
  }
  while (i > 0) {
    try {
      console.log(i);
    } finally {
      continue;
    }
  }
}
