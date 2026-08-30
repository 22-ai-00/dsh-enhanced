import { describe, expect, test } from 'vitest'
import { renderLarkAnswerElements } from '../src/answer-card.ts'

describe('Lark answer card renderer', () => {
  test('keeps ordinary authored Markdown in one element', () => {
    expect(renderLarkAnswerElements('**完成**\n\n- 第一项\n- 第二项')).toEqual([{
      tag: 'markdown',
      content: '**完成**\n\n- 第一项\n- 第二项',
      text_align: 'left',
    }])
  })

  test('renders headings and a GFM table as ordered native card elements', () => {
    const elements = renderLarkAnswerElements([
      '# 技能清单',
      '',
      '下面是完整列表。',
      '',
      '| **技能** | 用途 |',
      '| :--- | ---: |',
      '| `research` | **检索**资料 |',
      '| `skill` | 查看技能 |',
      '',
      '以上为当前结果。',
    ].join('\n'))

    expect(elements).toHaveLength(4)
    expect(elements[0]).toEqual({
      tag: 'markdown', content: '技能清单', text_align: 'left', text_size: 'heading-1',
    })
    expect(elements[1]).toEqual({
      tag: 'markdown', content: '下面是完整列表。', text_align: 'left',
    })
    expect(elements[2]).toMatchObject({
      tag: 'table',
      page_size: 2,
      row_height: 'auto',
      columns: [
        { name: 'col_0', display_name: '技能', data_type: 'lark_md', horizontal_align: 'left' },
        { name: 'col_1', display_name: '用途', data_type: 'lark_md', horizontal_align: 'right' },
      ],
      rows: [
        { col_0: '`research`', col_1: '**检索**资料' },
        { col_0: '`skill`', col_1: '查看技能' },
      ],
    })
    expect(elements[3]).toEqual({
      tag: 'markdown', content: '以上为当前结果。', text_align: 'left',
    })
    expect(JSON.stringify(elements)).not.toContain('| :--- | ---: |')
  })

  test('parses CRLF, escaped pipes, empty cells, and tables without outer pipes', () => {
    const elements = renderLarkAnswerElements([
      '名称 | 值 | 备注',
      ':--- | :---: | ---:',
      '`a\\|b` | x\\|y |',
    ].join('\r\n'))
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({
      tag: 'table',
      columns: [
        { horizontal_align: 'left' },
        { horizontal_align: 'center' },
        { horizontal_align: 'right' },
      ],
      rows: [{ col_0: '`a|b`', col_1: 'x|y', col_2: '' }],
    })
  })

  test('does not promote table-shaped text inside a fenced code block', () => {
    const source = '```md\n| 技能 | 用途 |\n| --- | --- |\n| a | b |\n```'
    expect(renderLarkAnswerElements(source)).toEqual([{
      tag: 'markdown', content: source, text_align: 'left',
    }])
  })

  test('preserves authored fences and leading indentation when headings split card elements', () => {
    const source = [
      '# 示例',
      '',
      '    ```',
      '    这是缩进代码，不是围栏',
      '',
      '~~~ js',
      'const value = 1',
      '',
      '',
      '~~~~   ',
    ].join('\r\n')

    expect(renderLarkAnswerElements(source)).toEqual([
      { tag: 'markdown', content: '示例', text_align: 'left', text_size: 'heading-1' },
      {
        tag: 'markdown',
        content: [
          '    ```',
          '    这是缩进代码，不是围栏',
          '',
          '~~~ js',
          'const value = 1',
          '',
          '',
          '~~~~   ',
        ].join('\n'),
        text_align: 'left',
      },
    ])
  })

  test('turns tables beyond the five-component provider limit into readable lists', () => {
    const source = Array.from({ length: 7 }, (_unused, index) => [
      `## 分组 ${index + 1}`,
      '',
      '| 技能 | 用途 |',
      '| --- | --- |',
      `| skill-${index + 1} | 说明-${index + 1} |`,
    ].join('\n')).join('\n\n')
    const elements = renderLarkAnswerElements(source)
    const tables = elements.filter(element => element.tag === 'table')
    const markdown = elements.filter(element => element.tag === 'markdown')

    expect(tables).toHaveLength(5)
    expect(markdown.some(element => element.content.includes('**技能：** skill-6'))).toBe(true)
    expect(markdown.some(element => element.content.includes('**用途：** 说明-7'))).toBe(true)
    expect(JSON.stringify(elements)).not.toContain('| --- | --- |')
  })

  test('turns tables wider than the provider column limit into a readable list', () => {
    const headers = Array.from({ length: 51 }, (_unused, index) => `列${index + 1}`)
    const source = [
      headers.join(' | '),
      headers.map(() => '---').join(' | '),
      headers.map((_header, index) => `值${index + 1}`).join(' | '),
    ].join('\n')
    const elements = renderLarkAnswerElements(source)

    expect(elements.every(element => element.tag === 'markdown')).toBe(true)
    expect(elements[0]).toMatchObject({
      content: expect.stringContaining('**列51：** 值51'),
    })
    expect(JSON.stringify(elements)).not.toContain(headers.map(() => '---').join(' | '))
  })

  test('leaves malformed table syntax intact instead of dropping source text', () => {
    const source = '| 技能 | 用途 |\n| not-a-divider | --- |\n| a | b |'
    expect(renderLarkAnswerElements(source)).toEqual([{
      tag: 'markdown', content: source, text_align: 'left',
    }])
  })
})
