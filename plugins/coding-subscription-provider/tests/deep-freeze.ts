/** Test-only recursive freezer for plain DSH request fixtures. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || value instanceof AbortSignal || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}
