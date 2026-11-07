// The project marks the entry module itself to run in a Node island. The
// entry is the program the build compiles and stays native, so the mark
// cannot be honored: the build says so instead of ignoring it.
console.log("hello");
