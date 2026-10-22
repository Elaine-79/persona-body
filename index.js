/**
 * persona-body · 白模 + 涂装
 *
 * 为什么拆：
 *   白模 = 钉 / 锚 / 留白，可移植，换给谁都是白模。
 *   涂装 = 口吻、偏好、说话的样子，是长出来的，换模型要重涂。
 *   2026-10-22 实测：3,844 字整份人格喂 qwen3.5:9b 会崩，只喂白模它站得住。
 *
 * 红线：
 *   涂装的写入不自动化。谁的话进涂装，必须有人点头、留痕。
 *   自动写就是「写进去 → 读出来 → 再当证据用」那个闭环。
 *
 * 两道防线（2026-10-22 补）：
 *   上限：涂装条数 ≤ 24、总字数 ≤ 2000。超了 propose/confirm 都拒。
 *        理由：涂装一膨胀就是第二份人格，而「人格读成条款」这个病今天刚验过。
 *   退役：revoke 不是删除，是把条目移到 coating.retired.md，留痕可查。
 */

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'persona-body'

/** systemPrompt 用来注入；tools 缺席时只丢掉涂装工具，不影响注入。 */
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = {
  corePath: 'D:\\dsh-home\\persona\\core.md',
  coatingPath: 'D:\\dsh-home\\persona\\coating.md',
  pendingPath: 'D:\\dsh-home\\persona\\coating.pending.md',
  retiredPath: 'D:\\dsh-home\\persona\\coating.retired.md',
  order: 1,
  maxBytes: 12000,
  maxCoatingItems: 24,
  maxCoatingChars: 2000,
  // 白模要不要进 prompt。
  // 三层叠加：白模（骨架）+ 人格正文（身体）+ 涂装（长出来的）→ 默认注入。
  // 只有在换一个没身体的小模型时才该关；那时它需要骨架撑着。
  injectCore: true,
}

const COAT_HEAD = '# 涂装\n\n'
const PEND_HEAD = '# 待确认（提议区，不是涂装）\n\n'
const RETIRED_HEAD = '# 退役的涂装（revoke 来的，留痕不删）\n\n'

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 带 mtime 缓存：文件没改就不重复读盘。读失败一律当空——插件坏了不能让人格注入跟着炸。 */
function makeReader(path, maxBytes) {
  let cached = ''
  let cachedMtime = -1
  return function read() {
    try {
      const st = statSync(path)
      if (st.mtimeMs === cachedMtime) return cached
      const text = readFileSync(path, 'utf8')
      cached = text.length > maxBytes ? text.slice(0, maxBytes) : text
      cachedMtime = st.mtimeMs
      return cached
    } catch {
      cached = ''
      cachedMtime = -1
      return ''
    }
  }
}

function readOr(path, head) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return head
  }
}

function writeAll(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function bullets(text) {
  return text.split('\n').filter((ln) => ln.startsWith('- '))
}

function stripHead(text, head) {
  return text.replace(head.trim(), '').trim()
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const readCore = makeReader(cfg.corePath, cfg.maxBytes)
  const readCoating = makeReader(cfg.coatingPath, cfg.maxBytes)

  ctx.systemPrompt.section({
    name: 'persona-body',
    order: cfg.order,
    interpolate: false, // 人格里的 {{ }} 不能当模板变量解释
    text() {
      const core = cfg.injectCore ? readCore().trim() : ''
      const coating = readCoating().trim()
      if (!core && !coating) return ''
      const parts = []
      if (core) parts.push(core)
      if (coating) parts.push(coating)
      return parts.join('\n\n')
    },
  })

  const tools = ctx.get('tools')
  if (tools === undefined) return

  /** 涂装上限检查：条数 + 总字数，两道都卡。 */
  function overLimit(extraLine) {
    const lines = bullets(readOr(cfg.coatingPath, COAT_HEAD))
    const total = lines.join('').length + (extraLine ? extraLine.length : 0)
    if (lines.length + (extraLine ? 1 : 0) > cfg.maxCoatingItems) {
      return `涂装已经 ${lines.length} 条，上限 ${cfg.maxCoatingItems} 条。要么退役几条，要么把新的并进已有的。`
    }
    if (total > cfg.maxCoatingChars) {
      return `涂装总字数 ${total}，上限 ${cfg.maxCoatingChars}。涂装太长就是第二份人格了。`
    }
    return undefined
  }

  tools.register({
    name: 'coating',
    description:
      '涂装的读写入口。show / pending 只读；propose 只写待确认区（不进 prompt）；' +
      'confirm 才写进 coating.md，且必须给 evidence —— 人类明确点头的原话；' +
      'revoke 把某条移进退役区（留痕不删）；drop 丢掉待确认区的一条。' +
      '上限：涂装最多 24 条、2000 字。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'pending', 'propose', 'confirm', 'revoke', 'drop'] },
        text: { type: 'string', description: 'propose 的内容：一句口吻或偏好，写短' },
        why: { type: 'string', description: 'propose 的依据：哪句话、哪件事看出来的' },
        evidence: { type: 'string', description: 'confirm 专用：人类明确点头的原话，不能编' },
        index: { type: 'integer', description: 'revoke / drop 用：第几条，从 1 开始' },
        reason: { type: 'string', description: 'revoke 用：为什么要退' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: String(value && value.text) }],
    },
    async execute(args) {
      const action = args && args.action

      if (action === 'show') {
        const body = stripHead(readOr(cfg.coatingPath, COAT_HEAD), COAT_HEAD)
        const n = bullets(readOr(cfg.coatingPath, COAT_HEAD)).length
        return { text: body ? `${body}\n\n（${n} 条 / 上限 ${cfg.maxCoatingItems} 条 · ${cfg.maxCoatingChars} 字）` : '（涂装是空的）' }
      }

      if (action === 'pending') {
        const body = stripHead(readOr(cfg.pendingPath, PEND_HEAD), PEND_HEAD)
        return { text: body ? body : '（没有待确认的提议）' }
      }

      if (action === 'propose') {
        const text = String((args && args.text) || '').trim().replace(/\n/g, ' ')
        if (!text) return { text: '要写内容（text 不能空）' }
        const why = String((args && args.why) || '').trim().replace(/\n/g, ' ') || '未写'
        const line = `- [${today()}] ${text}  〔依据：${why}〕`
        const over = overLimit(line)
        if (over) return { text: '⛔ 不写：' + over }
        const cur = readOr(cfg.pendingPath, PEND_HEAD)
        writeAll(cfg.pendingPath, (cur.endsWith('\n') ? cur : cur + '\n') + line + '\n')
        return { text: '已提议（还没进 prompt）：\n' + line }
      }

      if (action === 'confirm') {
        const evidence = String((args && args.evidence) || '').trim().replace(/\n/g, ' ')
        if (!evidence) {
          return { text: '不给 evidence 不写盘。这里要的是人类明确点头的原话，不能编。' }
        }
        const lines = bullets(readOr(cfg.pendingPath, PEND_HEAD))
        if (lines.length === 0) return { text: '没有待确认的提议，什么都没做' }
        const over = overLimit(lines.join(''))
        if (over) return { text: '⛔ 不并入：' + over }
        let coat = readOr(cfg.coatingPath, COAT_HEAD)
        if (!coat.endsWith('\n')) coat += '\n'
        const moved = []
        for (const ln of lines) {
          const m = ln.match(/^- \[[^\]]*\]\s*(.*)$/)
          const body = (m ? m[1] : ln.slice(2)).replace('〔确认：', '〔旧确认：')
          const newLine = `- ${body} 〔确认：${today()} · ${evidence}〕`
          moved.push(newLine)
          coat += newLine + '\n'
        }
        writeAll(cfg.coatingPath, coat)
        writeAll(cfg.pendingPath, PEND_HEAD)
        return { text: `已并入 ${moved.length} 条（下一轮生效）：\n` + moved.join('\n') }
      }

      if (action === 'revoke') {
        const idx = Number((args && args.index) || 0)
        const reason = String((args && args.reason) || '').trim().replace(/\n/g, ' ') || '未写理由'
        const coatText = readOr(cfg.coatingPath, COAT_HEAD)
        const lines = coatText.split('\n')
        const picked = []
        for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('- ')) picked.push(i)
        if (idx < 1 || idx > picked.length) return { text: `涂装里没有第 ${idx} 条` }
        const retiredLine = lines[picked[idx - 1]]
        lines.splice(picked[idx - 1], 1)
        writeAll(cfg.coatingPath, lines.join('\n'))
        const ret = readOr(cfg.retiredPath, RETIRED_HEAD)
        writeAll(cfg.retiredPath, (ret.endsWith('\n') ? ret : ret + '\n') + `- [${today()} 退役] ${retiredLine.slice(2)} 〔理由：${reason}〕` + '\n')
        return { text: '已退役（在 coating.retired.md 留痕，下一轮不再生效）：\n' + retiredLine }
      }

      if (action === 'drop') {
        const idx = Number((args && args.index) || 0)
        const lines = readOr(cfg.pendingPath, PEND_HEAD).split('\n')
        const picked = []
        for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('- ')) picked.push(i)
        if (idx < 1 || idx > picked.length) return { text: `没有第 ${idx} 条` }
        const dropped = lines[picked[idx - 1]]
        lines.splice(picked[idx - 1], 1)
        writeAll(cfg.pendingPath, lines.join('\n'))
        return { text: '丢掉：' + dropped }
      }

      return { text: '未知 action：' + String(action) }
    },
  })
}
