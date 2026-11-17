// A JavaScript override may declare more parameters than the base method it
// replaces. Node calls it with whatever the call site passes: a base-typed
// call supplies the base's arguments, a call through the subclass supplies
// its own, and parameters the call omits read undefined.

class Base {
  raycast() {
    return "base";
  }
}

class Sprite extends Base {
  /**
   * @param {string} raycaster
   * @param {number[]} intersects
   */
  raycast(raycaster, intersects) {
    const seen = intersects === undefined ? "none" : intersects.length + 1;
    return "sprite:" + raycaster + ":" + seen;
  }
}

/** @param {Base} view */
function throughBase(view) {
  return view.raycast();
}

const sprite = new Sprite();
console.log("own", sprite.raycast("camera", []));
console.log("base typed", throughBase(sprite));
console.log("extra", sprite.raycast("camera", []));
