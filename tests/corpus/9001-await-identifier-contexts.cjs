// The reserved-word rule for `await` is a property of the POSITION, not of
// the enclosing function: an arrow's parameters inherit the enclosing
// async-ness, an arrow's body resets it, and PropertyName positions are
// ordinary IdentifierNames. The file is CommonJS because a module reserves
// `await` everywhere; Node accepts every program below in this script.
function sloppy(a = await) {
  var await = a + 1;
  return await;
}
console.log(sloppy(1));
async function nested() {
  const arrow = () => {
    var await = 7;
    return await;
  };
  function inner(a = await) {
    return a;
  }
  return [arrow(), inner(3)];
}
nested().then((pair) => console.log(pair[0], pair[1]));
const named = { await: 1 };
console.log(named.await, { await: 2 }.await);
class Member {
  await() {
    return 3;
  }
  static {
    const holder = { await: 4 };
    console.log(holder.await);
  }
}
console.log(new Member().await());
