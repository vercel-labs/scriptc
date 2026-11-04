counter = 41;

function bump() {
  counter = counter + 1;
}

function read() {
  return counter + 1;
}

function kind() {
  return typeof counter;
}

function missing() {
  return typeof neverWritten;
}

module.exports = { bump, read, kind, missing };
