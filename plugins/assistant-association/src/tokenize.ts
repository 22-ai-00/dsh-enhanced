const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const mixedScriptSegments =
  /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

export function tokenizeAssociationText(content: string): string[] {
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
        const current = characters[index]
        if (current !== undefined) {
          tokens.add(current)
          const next = characters[index + 1]
          if (next !== undefined) tokens.add(`${current}${next}`)
        }
      }
    }
  }

  return [...tokens].sort()
}

export function normalizeForAc(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US')
}

export function normalizeEntityKey(entity: string): string | null {
  const cleaned = normalizeForAc(entity).replace(/\s+/gu, ' ').trim()
  if (cleaned.length < 2 || cleaned.length > 128) return null
  return cleaned
}
