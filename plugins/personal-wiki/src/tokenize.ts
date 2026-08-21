const WORD = /[\p{Letter}\p{Number}]+/gu
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export function tokenizeWiki(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US')
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(WORD)) {
    const word = match[0]
    if ([...word].some(character => CJK.test(character))) {
      const characters = [...word]
      for (const character of characters) tokens.add(character)
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`)
      }
    } else {
      tokens.add(word)
    }
  }
  return [...tokens].sort((left, right) => left.localeCompare(right, 'en'))
}

export function wikiParagraphs(body: string): string[] {
  return body.split(/\n\s*\n/u).map(paragraph => paragraph.trim()).filter(Boolean)
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let output = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    output += character
    bytes += size
  }
  return output
}
