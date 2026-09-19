const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const mixedScriptSegments =
  /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

export function tokenizeMemory(content: string): string[] {
  const normalized = content.normalize('NFKC').toLocaleLowerCase('en-US')
  const tokens = new Set<string>()

  for (const match of normalized.matchAll(/[\p{Letter}\p{Number}_-]+/gu)) {
    for (const segment of match[0].match(mixedScriptSegments) ?? []) {
      if (!cjk.test(segment)) {
        tokens.add(segment)
        continue
      }

      const characters = [...segment]
      for (let index = 0; index < characters.length; index += 1) {
        tokens.add(characters[index]!)
        if (index + 1 < characters.length) tokens.add(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }

  return [...tokens].sort()
}
