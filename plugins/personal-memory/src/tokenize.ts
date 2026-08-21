const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export function tokenizeMemory(content: string): string[] {
  const normalized = content.normalize('NFKC').toLocaleLowerCase('en-US')
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(/[\p{Letter}\p{Number}_-]+/gu)) {
    const value = match[0]
    if (![...value].some(character => cjk.test(character))) tokens.add(value)
  }

  const characters = [...normalized].filter(character => cjk.test(character))
  for (let index = 0; index < characters.length; index += 1) {
    tokens.add(characters[index]!)
    if (index + 1 < characters.length) tokens.add(`${characters[index]}${characters[index + 1]}`)
  }
  return [...tokens].sort()
}
