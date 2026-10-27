// A JavaScript Error subclass that overrides name and message with accessor
// pairs, as quickjs-wasi's JSException does. Writing `.name` or `.message`
// on an ordinary Error builds the Error property dispatchers, whose branch
// for this class calls the JavaScript setters with an untyped value.
class GuestException extends Error {
  #name;
  #message;
  constructor(name, message) {
    super();
    this.#name = name;
    this.#message = message;
  }
  get name() {
    return this.#name;
  }
  set name(v) {
    this.#name = v;
  }
  get message() {
    return this.#message;
  }
  set message(v) {
    this.#message = `[${v}]`;
  }
}

const guest = new GuestException("GuestError", "boom");
console.log(guest.name, guest.message, String(guest));
guest.name = "Renamed";
guest.message = "changed";
console.log(guest.name, guest.message, String(guest));

const plain = new Error("plain");
plain.name = "PlainName";
plain.message = "plain message";
console.log(plain.name, plain.message, String(plain));

/** @type {Error[]} */
const errors = [plain, guest, new TypeError("bad")];
for (const err of errors) console.log(String(err));
try {
  throw guest;
} catch (caught) {
  console.log(caught instanceof GuestException, caught instanceof Error, String(caught));
}
