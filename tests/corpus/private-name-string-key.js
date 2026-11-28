// A private name is not a property key: the string "#secret" never names the
// class's #secret field. Node answers in, hasOwnProperty, Reflect.has and
// Object.keys without it, and a plain object whose own key is spelled
// "#secret" still answers it.
class Box {
  #secret = 1;

  read() {
    return this.#secret;
  }
}

class SecretBox extends Box {}

const box = new Box();
console.log("#secret" in box);
console.log(Object.prototype.hasOwnProperty.call(box, "#secret"));
console.log(box.hasOwnProperty("#secret"));
console.log(Object.keys(box));
console.log(Reflect.has(box, "#secret"));
console.log(Object.getOwnPropertyNames(box));
console.log("#secret" in new SecretBox());

const spelled = { "#secret": "own" };
console.log("#secret" in spelled, Object.keys(spelled), Reflect.has(spelled, "#secret"));
