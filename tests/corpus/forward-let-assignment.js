// A `let` declared below the nested function that assigns it: the function
// runs only after the declaration, so the write is ordinary JavaScript.
function store() {
  function set() {
    cached = 1;
  }
  let cached;
  set();
  return cached;
}
console.log(store());

// The same declaration read and written before it runs is in the temporal
// dead zone: both throw the catchable ReferenceError. Afterwards the read
// leaves the zone with undefined, and a write still lands.
function ordered() {
  function set() {
    cached = 2;
  }
  function read() {
    return cached;
  }
  try {
    read();
  } catch (e) {
    console.log("early read", e.name);
  }
  try {
    set();
  } catch (e) {
    console.log("early write", e.name);
  }
  let cached;
  console.log("declared", read());
  set();
  console.log("filled", read());
}
ordered();
