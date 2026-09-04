export {}

function outer(n: number): number {
  function even(k: number): number {
    if (k === 0) return 1
    return odd(k - 1)
  }

  function odd(k: number): number {
    if (k === 0) return 0
    return even(k - 1)
  }

  return even(n)
}

console.log(`r=${outer(4)}`)
