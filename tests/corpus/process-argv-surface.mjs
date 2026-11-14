// @no-node-shims
// process.argv, argv0, execPath and execArgv: the argument and executable
// surface a program reads at startup. The harness starts both worlds with
// no user arguments and no Node flags, so the array lengths agree; the
// argv[0]/argv[1] VALUES depend on the world (Node's executable and
// script path, the compiled binary's marker and its own path), so only
// their shape and identity print, as 990-process-basics records.
const argv = process.argv;
console.log("argv", Array.isArray(argv), argv.length, argv === process.argv);
console.log("argv-shape", argv.every((value) => typeof value === "string"), argv[0].length > 0, argv[1].length > 0);
console.log("argv-distinct", argv[0] !== argv[1]);
argv.push("extra");
console.log("argv-push", process.argv.length, process.argv[2] === "extra");
console.log("argv-pop", argv.pop() === "extra", process.argv.length);
console.log("argv0", typeof process.argv0, process.argv0.length > 0, process.argv0 === process.argv0);
console.log("execPath", typeof process.execPath, process.execPath.length > 0);
console.log("execPath-absolute", process.execPath.startsWith("/") || /^[A-Za-z]:\\/.test(process.execPath));
console.log("execPath-stable", process.execPath === process.execPath);
console.log("execArgv", Array.isArray(process.execArgv), process.execArgv.length, process.execArgv === process.execArgv);
console.log("execArgv-strings", process.execArgv.every((value) => typeof value === "string"));
console.log("distinct", process.execArgv !== process.argv, process.execArgv !== process.argv0);
const held = process;
console.log("stored", held.execPath === process.execPath, Array.isArray(held.execArgv), Array.isArray(held.argv));
