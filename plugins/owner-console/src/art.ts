/**
 * Inline SVG ornaments that accompany the 文鳐 panel: a small 云纹 before card titles. The
 * product mark and seal are now the 11 深海觉醒 artwork, inlined from `src/artwork.ts`; this
 * module keeps only vector decorations that can follow `currentColor` in both themes.
 * Everything is decorative (`aria-hidden`) and ships inside the client bundle — no network.
 */
import { jsx } from 'react/jsx-runtime'

type Props = Record<string, unknown>
const s = (tag: string, props: Props, ...children: readonly unknown[]) => children.length === 0
  ? jsx(tag as never, props as never)
  : jsx(tag as never, { ...props, children: children.length === 1 ? children[0] : children } as never)

/** 楷体 stack for the classical subtitle; a system font, never fetched. */
export const KAI_FONT = "'STKaiti', 'KaiTi', 'Songti SC', 'STSong', serif"

/** One 祥云 curl: a soft cloud outline with an inner spiral. */
const CLOUD = 'M0 20c0-8 10-10 14-4 2-8 14-8 16 0 4-4 12-2 10 6 4 0 6 6 0 8H4c-6 0-6-8-4-10zM14 16c2 4-3 6-4 3M30 16c-1 4 4 5 5 2'

/** Small 云纹 mark placed before a card title. */
export function CloudMark() {
  return s('svg', { 'aria-hidden': 'true', focusable: 'false', 'data-owner-console-art': 'cloud', viewBox: '0 0 40 30', width: 16, height: 12,
    fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', style: { display: 'block', flex: 'none' } },
  s('path', { d: CLOUD }))
}

/** Short classical line shown under empty states. */
export const QUIET_PHRASE = '云水无事，小鳐静候'
