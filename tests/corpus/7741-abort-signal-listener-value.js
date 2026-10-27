// An AbortSignal's EventTarget methods read as values, in a program that
// never adds a listener or makes an EventTarget of its own: the shared
// functions are released at exit like every other value.
const holder = JSON.parse("{}");
holder.controller = new AbortController();
const signal = holder.controller.signal;
const add = signal.addEventListener;
console.log(typeof add, add.name, add.length, signal.dispatchEvent.name);
console.log("removeEventListener" in signal, signal.removeEventListener.length);
console.log(signal.aborted);
