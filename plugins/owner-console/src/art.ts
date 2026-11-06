/**
 * Light inline SVG ornaments that accompany the 文鳐 banner: a vermilion seal, a sidebar
 * silhouette of the 《山海经》文鳐 (fish body, bird wings) and a small 云纹 for card titles.
 * Everything is decorative (`aria-hidden`), uses `currentColor` where it should follow the
 * theme, and ships inside the client bundle — no network, fonts or images.
 */
import { jsx } from 'react/jsx-runtime'

type Props = Record<string, unknown>
const s = (tag: string, props: Props, ...children: readonly unknown[]) => children.length === 0
  ? jsx(tag as never, props as never)
  : jsx(tag as never, { ...props, children: children.length === 1 ? children[0] : children } as never)

/** 朱红 seal ink and its paper-white carving. */
const ZHUHONG = '#b8322a'
const PAPER = '#fbeee6'
export const KAI_FONT = "'STKaiti', 'KaiTi', 'Songti SC', 'STSong', serif"

/** Sidebar glyph: a filled 文鳐 silhouette (body, forked tail, raised wing) legible at 16–18px. */
export function WenyaoGlyph(props: Readonly<{ size?: number }> = {}) {
  const size = props.size ?? 18
  return s('svg', { 'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', width: size, height: size,
    fill: 'currentColor', style: { display: 'block' } },
  s('path', { d: 'M4 14c4-4 10-4.5 14-3 2 .8 3.5 1.8 4 3-1 1.2-3 2.2-5 2.5-4 .7-9 .5-13-2.5zM4.6 14 1 10.4 2.2 14 1 17.6z' }),
  s('path', { d: 'M15 11.2C13 7 10 4 5.5 2.8c2 2.4 3 4.4 3.6 6-1.4-.4-3-.4-4.6 0 3 1.2 5.4 2 6.6 2.6z', fillOpacity: 0.8 }))
}

/** 朱红 vertical seal reading 文 / 鳐, with an inner rim like a carved border. */
export function WenyaoSeal(props: Readonly<{ height?: number }> = {}) {
  const height = props.height ?? 40
  return s('svg', { 'aria-hidden': 'true', focusable: 'false', 'data-owner-console-art': 'seal',
    viewBox: '0 0 24 44', width: Math.round(height * 24 / 44), height, style: { display: 'block', flex: 'none' } },
  s('rect', { x: 0.5, y: 0.5, width: 23, height: 43, rx: 2.5, fill: ZHUHONG }),
  s('rect', { x: 2.2, y: 2.2, width: 19.6, height: 39.6, rx: 1.2, fill: 'none', stroke: PAPER, strokeWidth: 0.9, strokeOpacity: 0.9 }),
  s('text', { x: 12, y: 20, textAnchor: 'middle', fontSize: 15, fontFamily: KAI_FONT, fill: PAPER }, '文'),
  s('text', { x: 12, y: 37.5, textAnchor: 'middle', fontSize: 15, fontFamily: KAI_FONT, fill: PAPER }, '鳐'),
  // worn ink specks
  s('path', { d: 'M5 9.5h1.2M18 31l.8.6M7 40.6h2', stroke: ZHUHONG, strokeWidth: 0.9 }))
}

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
