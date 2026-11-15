// A JavaScript file: an executor's resolve called with no argument settles
// the promise with undefined. Node accepts the call in every shape below,
// and the compiled program prints the same output.
'use strict';

function requestAnimationFrame(callback) {
  setTimeout(callback, 0);
}

new Promise((resolve) => {
  requestAnimationFrame(() => resolve());
}).then((value) => console.log("frame", value));

new Promise((resolve) => {
  setTimeout(() => resolve(), 0);
}).then((value) => console.log("timer", value));

/** @type {Promise<void>} */
const typed = new Promise((resolve) => {
  setTimeout(() => resolve(), 0);
});
typed.then(() => console.log("typed"));

new Promise((resolve) => resolve("value")).then((value) => console.log("value", value));

new Promise((resolve) => resolve(undefined)).then((value) => console.log("explicit", value));
