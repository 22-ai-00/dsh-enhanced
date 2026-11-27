import type { LarkCommandCard, LarkCommandCardItem, LarkCommandCardSection } from './types.js'

const COMMAND_CARD_TEXT_MAX_BYTES = 20 * 1_024

function plainLines(lines: readonly string[], notation = false): readonly LarkCommandCardItem[] {
  return lines
    .filter(line => line.trim().length > 0)
    .map(content => ({ kind: 'plain', content, ...(notation ? { notation: true } : {}) }))
}

function stripBullet(line: string): string {
  return line.startsWith('- ') ? line.slice(2) : line
}

function tryBuildHelpCard(text: string): LarkCommandCard | undefined {
  if (!text.startsWith('会话命令：\n- /new（/clear）：')) return undefined
  const presetMarker = '\n\nDSH / 当前 preset 命令：\n'
  const presetIndex = text.indexOf(presetMarker)
  const presetLines = presetIndex >= 0
    ? text.slice(presetIndex + presetMarker.length)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(stripBullet)
    : []

  const sections: LarkCommandCardSection[] = [
    {
      heading: '会话与模型控制',
      tone: 'blue',
      items: [
        { kind: 'markdown', content: '`/new`（`/clear`）：开始空白新会话，旧会话保留' },
        { kind: 'markdown', content: '`/stop`：停止当前任务，保留会话与已完成上下文' },
        { kind: 'markdown', content: '`/status`（`/session`）：查看当前 session、上下文与模型' },
        { kind: 'markdown', content: '`/model`：查看或切换模型，上下文保留' },
        { kind: 'markdown', content: '`/permission`：查看或切换运行权限' },
        { kind: 'markdown', content: '`/help`：显示当前实际可用命令' },
      ],
    },
    {
      heading: '反馈、学习与演进控制',
      tone: 'grey',
      items: [
        { kind: 'markdown', content: '`/feedback`：提交结构化偏好；回复任务结果可记录 achieved/partial/not-achieved' },
        { kind: 'markdown', content: '`/learning`：查看、导出、暂停、恢复或清除当前 scope 的偏好学习' },
        { kind: 'markdown', content: '`/autonomy`：开启、关闭或升级整体助手自迭代能力' },
        { kind: 'markdown', content: '`/update`（`/upgrade`）：在后台升级整体助手并自动重启恢复（仅限 owner）' },
        { kind: 'markdown', content: '`/version`：查看当前助手、Host、插件版本与自迭代演进统计' },
      ],
    },
  ]

  if (presetLines.length > 0) {
    sections.push({
      heading: 'DSH / 当前 preset 命令',
      tone: 'grey',
      items: plainLines(presetLines),
    })
  }

  return {
    summary: '查看当前可用的会话与控制斜杠命令说明',
    template: 'blue',
    title: '可用命令与操作指南',
    subtitle: '以下斜杠命令由控制面直接处理，不消耗模型轮次',
    iconToken: 'info_outlined',
    sections,
    footer: '提示：直接发送对应斜杠命令即可触发，不消耗模型上下文。',
  }
}

function tryBuildStatusCard(text: string): LarkCommandCard | undefined {
  if (text.startsWith('当前会话\n- 第 ')) {
    const lines = text.split('\n').map(line => line.trim())
    const generation = stripBullet(lines[1] ?? '')
    const statusLine = stripBullet(lines[2] ?? '')
    const messagesLine = stripBullet(lines[3] ?? '')
    const turnsLine = stripBullet(lines[4] ?? '')
    const modelLine = stripBullet(lines[5] ?? '')
    const statusValue = statusLine.replace(/^状态：/u, '') || statusLine
    const messagesCount = messagesLine.replace(/^上下文消息：/u, '')
    const turnsCount = turnsLine.replace(/^已记录轮次：/u, '')
    const modelValue = modelLine.replace(/^模型：/u, '') || modelLine

    return {
      summary: '查看当前会话代数、状态、轮次与模型',
      template: 'blue',
      title: '当前会话状态',
      subtitle: generation,
      iconToken: 'chat_outlined',
      metrics: [
        { label: '运行状态', value: statusValue },
        { label: '上下文与轮次', value: `${messagesCount} 条消息 · ${turnsCount} 轮` },
      ],
      sections: [
        {
          heading: '当前模型',
          tone: 'grey',
          items: [{ kind: 'plain', content: modelValue }],
        },
      ],
      footer: '/new 会开始空白新 session 并保留旧会话；/stop 只停止当前任务，不清空上下文。',
    }
  }

  if (text.startsWith('当前会话暂时无法恢复；原历史未删除。')) {
    const lines = text.split('\n').map(line => line.trim())
    const detailLines = lines.slice(1).filter(line => line.startsWith('- ')).map(stripBullet)
    const footerLine = lines.find(line => line.startsWith('请先修复或升级'))

    return {
      summary: '当前会话暂时无法恢复，原历史未删除',
      template: 'orange',
      title: '当前会话暂时无法恢复',
      subtitle: '原历史未删除，请排查诊断信息后重试',
      iconToken: 'warning_outlined',
      sections: [
        {
          heading: '恢复诊断',
          tone: 'orange',
          items: plainLines(detailLines.length > 0 ? detailLines : ['未能读取详细诊断信息']),
        },
      ],
      ...(footerLine === undefined ? {} : { footer: footerLine }),
    }
  }

  return undefined
}

function tryBuildVersionCard(text: string): LarkCommandCard | undefined {
  if (!text.startsWith('助手版本：') || !text.includes('\nHost（')) return undefined
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const subtitle = lines[0]!
  const statsIndex = lines.findIndex(line => line.startsWith('自迭代演进统计'))
  const envLines = statsIndex >= 0 ? lines.slice(1, statsIndex) : lines.slice(1)
  const statsLines = statsIndex >= 0 ? lines.slice(statsIndex).map(stripBullet) : []

  const sections: LarkCommandCardSection[] = []
  if (envLines.length > 0) {
    sections.push({
      heading: '运行环境与插件',
      tone: 'blue',
      items: plainLines(envLines),
    })
  }
  if (statsLines.length > 0) {
    sections.push({
      heading: '自迭代演进统计',
      tone: 'grey',
      items: plainLines(statsLines),
    })
  }

  return {
    summary: 'dsh-ray 版本、插件与自迭代演进统计',
    template: 'blue',
    title: '助手版本与自迭代统计',
    subtitle,
    iconToken: 'info_outlined',
    sections,
  }
}

const AUTONOMY_SUCCESS_PREFIXES = [
  '已开启 profile ',
  '已开启当前助手自迭代能力',
  '已关闭 profile ',
  '已关闭当前助手自迭代能力',
  '已完成 profile ',
  '已完成整体助手升级',
  '升级完成并已恢复',
  '🔄 已启动后台自动升级与服务恢复',
  '🔄 后台自动升级与服务恢复正在进行中',
  '当前已是最新版本 ',
  '✅ 自动升级完成',
] as const

const AUTONOMY_WARNING_PREFIXES = [
  '开启自迭代未完成',
  '关闭自迭代未完成',
  '升级整体助手未完成',
  '自迭代控制服务尚未启用',
  'owner 或会话绑定已变化；本次自迭代控制未执行',
  '当前身份不是此会话的 owner；本次自迭代控制未执行',
  '自迭代控制命令不接受文件、图片或其他附件',
  '用法：/update 或 /upgrade',
  '⚠️ 自动升级失败并已回滚保护',
] as const

function tryBuildAutonomyCard(text: string): LarkCommandCard | undefined {
  if (text.startsWith('自迭代控制命令（仅限 owner，不进入模型）：')) {
    return {
      summary: '查看自迭代控制命令用法（仅限 owner）',
      template: 'blue',
      title: '自迭代控制命令',
      subtitle: '仅限 owner 使用，控制面直接处理，不进入模型',
      iconToken: 'setting_outlined',
      sections: [
        {
          heading: '可用控制命令',
          tone: 'blue',
          items: [
            { kind: 'markdown', content: '`/autonomy enable`（或「开启自迭代」）：开启当前助手自迭代能力' },
            { kind: 'markdown', content: '`/autonomy disable`（或「关闭自迭代」）：关闭当前助手自迭代能力' },
            { kind: 'markdown', content: '`/autonomy upgrade`（或 `/update`、`/upgrade`、「升级整体助手」）：在后台执行整体升级与服务恢复' },
            { kind: 'markdown', content: '`/autonomy version`（或 `/version`）：查看助手版本与自迭代统计' },
          ],
        },
      ],
    }
  }

  if (AUTONOMY_SUCCESS_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return {
      summary: '自迭代控制操作已执行，服务状态已更新',
      template: 'green',
      title: '自迭代控制已执行',
      subtitle: '由控制面直接执行，未唤醒模型',
      iconToken: 'done_outlined',
      sections: [
        {
          heading: '执行结果',
          tone: 'green',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  if (AUTONOMY_WARNING_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return {
      summary: '自迭代控制未执行或未完成，配置未变更',
      template: 'orange',
      title: '自迭代控制提示',
      subtitle: '请确认权限与服务状态后再试',
      iconToken: 'warning_outlined',
      sections: [
        {
          heading: '说明',
          tone: 'orange',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  return undefined
}

const LEARNING_RESULT_PREFIXES = [
  '已暂停当前工作区',
  '已记录暂停状态',
  '已恢复当前工作区',
  '已记录恢复状态',
  '已回滚 ',
  '已永久删除当前工作区与 preset 的偏好学习记录。',
] as const

const LEARNING_WARNING_PREFIXES = [
  '尚未删除任何学习记录。',
  '学习控制命令不接受附件',
  '当前身份不是此会话的 owner；本次学习控制未执行',
  '偏好学习服务尚未启用；本次学习控制未执行',
  'owner 或会话绑定已变化；本次学习控制未执行',
  '已有更新的学习控制',
] as const

function parseLearningStatusSection(lines: readonly string[]): {
  metrics: Array<{ label: string; value: string }>
  detailLines: string[]
} {
  const metrics: Array<{ label: string; value: string }> = []
  const detailLines: string[] = []
  for (const raw of lines) {
    const line = stripBullet(raw.trim())
    if (line.length === 0) continue
    if (line.startsWith('组件状态：')) {
      metrics.push({ label: '组件状态', value: line.slice('组件状态：'.length) })
    } else if (line.startsWith('收集状态：')) {
      metrics.push({ label: '收集状态', value: line.slice('收集状态：'.length) })
    } else {
      detailLines.push(line)
    }
  }
  return { metrics, detailLines }
}

function tryBuildLearningCard(text: string): LarkCommandCard | undefined {
  if (text.startsWith('学习控制命令：\n- /learning status：')) {
    return {
      summary: '查看偏好学习控制命令与子命令用法',
      template: 'blue',
      title: '偏好学习控制命令',
      subtitle: '仅作用于当前工作区与 preset，不进入模型',
      iconToken: 'setting_outlined',
      sections: [
        {
          heading: '可用子命令',
          tone: 'blue',
          items: [
            { kind: 'markdown', content: '`/learning status`：查看当前工作区与 preset 的学习状态' },
            { kind: 'markdown', content: '`/learning explain`：查看当前 owner 的 T1 偏好键、值、状态、版本与证据计数' },
            { kind: 'markdown', content: '`/learning export`：以版本化稳定 JSON 导出当前 scope 的 content-free T1 摘要' },
            { kind: 'markdown', content: '`/learning pause`：暂停收集、激活和注入偏好；已有记录保留' },
            { kind: 'markdown', content: '`/learning resume`：恢复学习，并重新使用已有的有效偏好' },
            { kind: 'markdown', content: '`/learning rollback <T1-key> confirm`：回滚该键当前激活的偏好' },
            { kind: 'markdown', content: '`/learning forget confirm`：永久删除当前工作区与 preset 的偏好学习记录' },
          ],
        },
      ],
      footer: '删除不可撤销；必须完整输入 forget confirm，单独输入 forget 不会删除。',
    }
  }

  if (text.startsWith('组件状态：')) {
    const { metrics, detailLines } = parseLearningStatusSection(text.split('\n'))
    const subtitle = metrics.length === 2
      ? metrics.map(item => `${item.label}：${item.value}`).join(' · ')
      : '当前工作区与 preset 偏好学习运行概况'
    return {
      summary: '查看当前工作区与 preset 的偏好学习状态',
      template: 'blue',
      title: '偏好学习状态',
      subtitle,
      iconToken: 'info_outlined',
      ...(metrics.length === 2 ? { metrics } : {}),
      sections: [
        {
          heading: '状态与统计',
          tone: 'grey',
          items: plainLines(detailLines.length > 0 ? detailLines : text.split('\n')),
        },
      ],
    }
  }

  if (text.startsWith('当前 owner 与 lineage 的 T1 偏好摘要（不含原始内容）：')
    || text === '当前 owner 与 lineage 没有 T1 偏好摘要。') {
    const lines = text.split('\n')
    const bodyLines = lines.length > 1 ? lines.slice(1) : lines
    return {
      summary: '当前 owner 与 lineage 的 T1 偏好摘要',
      template: 'blue',
      title: 'T1 偏好学习摘要',
      subtitle: '仅展示偏好键、状态与证据计数（不含原始内容）',
      iconToken: 'info_outlined',
      sections: [
        {
          heading: '摘要明细',
          tone: 'grey',
          items: plainLines(bodyLines),
        },
      ],
    }
  }

  if (LEARNING_RESULT_PREFIXES.some(prefix => text.startsWith(prefix))
    || text.includes('当前没有激活偏好；未修改偏好记录。')) {
    const statusIndex = text.indexOf('\n\n组件状态：')
    const headText = statusIndex >= 0 ? text.slice(0, statusIndex) : text
    const statusText = statusIndex >= 0 ? text.slice(statusIndex + 2) : ''
    const sections: LarkCommandCardSection[] = [
      {
        heading: '执行结果',
        tone: 'green',
        items: plainLines(headText.split('\n').map(stripBullet)),
      },
    ]
    if (statusText.length > 0) {
      const { detailLines, metrics } = parseLearningStatusSection(statusText.split('\n'))
      sections.push({
        heading: '状态明细',
        tone: 'grey',
        items: plainLines([
          ...metrics.map(item => `${item.label}：${item.value}`),
          ...detailLines,
        ]),
      })
    }
    return {
      summary: '偏好学习控制操作已执行并更新状态',
      template: 'green',
      title: '偏好学习操作已执行',
      subtitle: '由控制面直接执行，未唤醒模型',
      iconToken: 'done_outlined',
      sections,
    }
  }

  if (LEARNING_WARNING_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return {
      summary: '偏好学习控制提示与安全确认说明',
      template: 'orange',
      title: '偏好学习控制提示',
      subtitle: '请核对命令格式或授权状态',
      iconToken: 'warning_outlined',
      sections: [
        {
          heading: '提示信息',
          tone: 'orange',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  return undefined
}

const FEEDBACK_WARNING_PREFIXES = [
  '尚未记录任务反馈',
  '任务结果未记录。',
  '该次任务已经记录了不同的任务结果',
  '当前身份不能提交反馈',
  '反馈命令不接受',
  '评测服务尚未启用',
  '偏好学习服务尚未启用',
] as const

function tryBuildFeedbackCard(text: string): LarkCommandCard | undefined {
  if (text.startsWith('反馈命令：\n- 回复一条自动化或普通 Agent 任务结果')) {
    return {
      summary: '查看任务结果与偏好反馈命令用法',
      template: 'blue',
      title: '任务与偏好反馈命令',
      subtitle: '只作用于当前工作区与 preset，不接受附件，不进入模型',
      iconToken: 'like_outlined',
      sections: [
        {
          heading: '任务结果反馈（需回复对应任务结果）',
          tone: 'blue',
          items: [
            { kind: 'markdown', content: '`/feedback achieved|partial|not-achieved`：记录该次任务结果' },
            { kind: 'markdown', content: '`/feedback status`：查询当前反馈与可复制的更正命令' },
            { kind: 'markdown', content: '`/feedback correct <版本> <原状态> <新状态>`：更正已记录结果' },
            { kind: 'markdown', content: '`/feedback withdraw <版本> <原状态>`：撤回后状态为 unknown' },
          ],
        },
        {
          heading: '偏好反馈（仅记录偏好，不代表任务成败）',
          tone: 'grey',
          items: [
            { kind: 'markdown', content: '`/feedback helpful|not-helpful|too-long|too-short|wrong-format|wrong-action|unwanted-reminder`' },
            { kind: 'markdown', content: '`/feedback verbosity concise|balanced|detailed`' },
            { kind: 'markdown', content: '`/feedback structure prose|bullets|mixed`' },
            { kind: 'markdown', content: '`/feedback language zh-CN|en`' },
            { kind: 'markdown', content: '`/feedback explanation result-first|balanced|tutorial`' },
            { kind: 'markdown', content: '`/feedback suggestions low|normal`' },
            { kind: 'markdown', content: '`/feedback ranking recency|familiarity|evidence`' },
          ],
        },
      ],
      footer: 'helpful 等只记录偏好，不代表任务成败；任务结果必须回复对应的任务结果消息。',
    }
  }

  if (text.startsWith('当前任务反馈：')) {
    return {
      summary: '查询当前任务已记录的反馈状态与版本',
      template: 'blue',
      title: '当前任务反馈状态',
      subtitle: '回复原任务结果消息可使用以下命令更正或撤回',
      iconToken: 'info_outlined',
      sections: [
        {
          heading: '反馈详情',
          tone: 'blue',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  if (text.startsWith('已把该次任务结果记录为 ') || text.startsWith('已记录偏好反馈')) {
    return {
      summary: '已记录当前任务结果或偏好反馈',
      template: 'green',
      title: '反馈已记录',
      subtitle: '反馈已持久化，不会唤醒模型',
      iconToken: 'done_outlined',
      sections: [
        {
          heading: '反馈回执',
          tone: 'green',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  if (FEEDBACK_WARNING_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return {
      summary: '反馈命令提示与未记录原因说明',
      template: 'orange',
      title: '反馈命令提示',
      subtitle: '请核对目标消息或反馈授权后再试',
      iconToken: 'warning_outlined',
      sections: [
        {
          heading: '说明',
          tone: 'orange',
          items: plainLines(text.split('\n')),
        },
      ],
    }
  }

  return undefined
}

export function tryBuildLarkCommandCard(text: string): LarkCommandCard | undefined {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > COMMAND_CARD_TEXT_MAX_BYTES) {
    return undefined
  }
  return (
    tryBuildHelpCard(text)
    ?? tryBuildStatusCard(text)
    ?? tryBuildVersionCard(text)
    ?? tryBuildAutonomyCard(text)
    ?? tryBuildLearningCard(text)
    ?? tryBuildFeedbackCard(text)
  )
}
