// Boa 0.21.x can panic while finalizing native Set iterators during config
// generation. Keep this array-backed implementation private to our transformer;
// neither Clash's global objects nor its built-in scripts are modified.
export class ProfileSet {
  constructor(values) {
    this.rows = []
    if (values != null) for (const value of values) this.add(value)
  }
  has(value) { return this.rows.some(row => row.live && (row.value === value || row.value !== row.value && value !== value)) }
  add(value) {
    if (!this.has(value)) this.rows.push({ value: value === 0 ? 0 : value, live: true })
    return this
  }
  delete(value) {
    const row = this.rows.find(row => row.live && (row.value === value || row.value !== row.value && value !== value))
    if (!row) return false
    row.live = false
    return true
  }
  clear() { for (const row of this.rows) row.live = false }
  get size() { return this.rows.filter(row => row.live).length }
  *values() { for (const row of this.rows) if (row.live) yield row.value }
  keys() { return this.values() }
  *entries() { for (const value of this.values()) yield [value, value] }
  [Symbol.iterator]() { return this.values() }
  forEach(callback, thisArg) { for (const value of this.values()) callback.call(thisArg, value, value, this) }
}

export function wrapProfileScript(source) {
  return '// GuardNook: scoped compatibility for Boa Set iterator finalization.\n'
    + 'const __guardCompatibleMain = (() => {\n'
    + `const Set = ${ProfileSet.toString()};\n${source}\nreturn main;\n})();\n`
    + 'function main(input, profileName) { return __guardCompatibleMain(input, profileName); }\n'
}
