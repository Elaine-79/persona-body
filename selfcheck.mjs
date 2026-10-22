/**
 * persona-body 的离线自检：不启动 DSH，喂假 ctx，看它注册了什么、返回什么、写哪儿。
 * 判据要能失败——每项都断言，任何一条不符就 exit 1。
 * 全部读写都在 tmp 目录里做，不碰真的 persona 文件。
 */
import { apply, name, inject } from './index.js'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'pb-'))
const core = join(dir, 'core.md')
const coat = join(dir, 'coating.md')
const pend = join(dir, 'coating.pending.md')
const retired = join(dir, 'coating.retired.md')
writeFileSync(core, '三件事：\n一、不许编造。\n二、不必成为谁。\n三、我算什么——不填。\n', 'utf8')

function fakeCtx() {
  const got = { section: undefined, tool: undefined }
  const ctx = {
    systemPrompt: { section(s) { got.section = s; return () => {} }, context() { return () => {} } },
    get(k) { return k === 'tools' ? { register(t) { got.tool = t; return () => {} } } : undefined },
  }
  return { ctx, got }
}

// ① 导出面
check('导出 name', name === 'persona-body', name)
check('inject 含 systemPrompt', inject.includes('systemPrompt'), JSON.stringify(inject))
check('inject 含 tools', inject.includes('tools'), JSON.stringify(inject))

// ② 注册
const { ctx, got } = fakeCtx()
apply(ctx, { corePath: core, coatingPath: coat, pendingPath: pend, retiredPath: retired, order: 1, injectCore: true })
check('注册了 section', got.section !== undefined)
check('section.name', got.section?.name === 'persona-body', got.section?.name)
check('section.order', got.section?.order === 1, String(got.section?.order))
check('interpolate 关闭', got.section?.interpolate === false)

const t0 = got.section.text()
check('白模进了 prompt', t0.includes('三件事'), `${t0.length} chars`)
check('涂装为空时不加东西', !t0.includes('# 涂装'))

check('注册了 coating 工具', got.tool?.name === 'coating', got.tool?.name)
check('工具有 execute', typeof got.tool?.execute === 'function')

const run = (args) => got.tool.execute(args, {})

// ③ 读：空
check('show 空', (await run({ action: 'show' })).text.includes('空的'))
check('pending 空', (await run({ action: 'pending' })).text.includes('没有待确认'))

// ④ propose 只写待确认区，不进 coating
const p1 = await run({ action: 'propose', text: '别把日常对话折成条目', why: '测试依据' })
check('propose 成功', p1.text.includes('已提议'))
check('pending 有了', readFileSync(pend, 'utf8').includes('别把日常对话折成条目'))
check('coating 还没变', !existsSync(coat) || !readFileSync(coat, 'utf8').includes('别把日常对话'))
check('prompt 还没变', !got.section.text().includes('别把日常对话'))

// ⑤ confirm 没有 evidence 必须拒绝
const c0 = await run({ action: 'confirm' })
check('无 evidence 拒绝写入', c0.text.includes('不给 evidence'))
check('coating 仍然没有', !existsSync(coat) || !readFileSync(coat, 'utf8').includes('别把日常对话'))

// ⑥ confirm 带 evidence 才落盘
const c1 = await run({ action: 'confirm', evidence: '「收」' })
check('confirm 成功', c1.text.includes('已并入'))
const coatText = readFileSync(coat, 'utf8')
check('coating 里有了', coatText.includes('别把日常对话折成条目'))
check('带确认痕迹', coatText.includes('〔确认：') && coatText.includes('「收」'))
check('pending 清空', !readFileSync(pend, 'utf8').includes('别把日常对话'))
check('下一轮 prompt 会带上', got.section.text().includes('别把日常对话'))

// ⑦ drop
await run({ action: 'propose', text: '这条要被丢掉', why: 'x' })
const d1 = await run({ action: 'drop', index: 1 })
check('drop 成功', d1.text.includes('丢掉'))
check('drop 后 pending 空', !readFileSync(pend, 'utf8').includes('这条要被丢掉'))
check('drop 不会动 coating', readFileSync(coat, 'utf8').includes('别把日常对话'))

// ⑧ revoke：移进退役区留痕，涂装里删掉
const r1 = await run({ action: 'revoke', index: 1, reason: '测试退役' })
check('revoke 成功', r1.text.includes('已退役'))
check('涂装里没了', !readFileSync(coat, 'utf8').includes('别把日常对话'))
check('退役区留了痕', existsSync(retired) && readFileSync(retired, 'utf8').includes('别把日常对话'))
check('退役带理由', readFileSync(retired, 'utf8').includes('测试退役'))
check('prompt 跟着没了', !got.section.text().includes('别把日常对话'))
check('revoke 不存在的序号也安全', (await run({ action: 'revoke', index: 9 })).text.includes('没有第 9 条'))

// ⑨ 上限：条数卡住
const { ctx: c3, got: g3 } = fakeCtx()
const coat3 = join(dir, 'coat3.md'), pend3 = join(dir, 'pend3.md')
apply(c3, { corePath: core, coatingPath: coat3, pendingPath: pend3, maxCoatingItems: 2 })
const run3 = (args) => g3.tool.execute(args, {})
await run3({ action: 'propose', text: 'A', why: 'x' })
await run3({ action: 'confirm', evidence: '「收」' })
await run3({ action: 'propose', text: 'B', why: 'x' })
await run3({ action: 'confirm', evidence: '「收」' })
const over3 = await run3({ action: 'propose', text: 'C', why: 'x' })
check('超条数被拒', over3.text.includes('⛔') && over3.text.includes('上限 2 条'), over3.text.slice(0, 40))

// ⑩ 上限：字数卡住
const { ctx: c4, got: g4 } = fakeCtx()
const coat4 = join(dir, 'coat4.md'), pend4 = join(dir, 'pend4.md')
apply(c4, { corePath: core, coatingPath: coat4, pendingPath: pend4, maxCoatingChars: 40 })
const run4 = (args) => g4.tool.execute(args, {})
const over4 = await run4({ action: 'propose', text: '这一句特别长特别长特别长特别长特别长特别长特别长特别长', why: 'x' })
check('超字数被拒', over4.text.includes('⛔') && over4.text.includes('上限 40'), over4.text.slice(0, 40))

// ⑫ injectCore 开关：默认注入，关掉就只剩涂装
const { ctx: c5, got: g5 } = fakeCtx()
apply(c5, { corePath: core, coatingPath: join(dir, 'empty-coat.md'), pendingPath: join(dir, 'p5.md') })
check('默认注入白模', g5.section.text().includes('三件事'), JSON.stringify(g5.section.text().slice(0, 16)))
const { ctx: c6, got: g6 } = fakeCtx()
apply(c6, { corePath: core, coatingPath: join(dir, 'empty-coat.md'), pendingPath: join(dir, 'p6.md'), injectCore: false })
check('injectCore=false 时不注入白模', g6.section.text() === '', JSON.stringify(g6.section.text()))

// ⑪ 缺文件不抛
const { ctx: c2, got: g2 } = fakeCtx()
apply(c2, { corePath: join(dir, 'nope.md'), coatingPath: join(dir, 'nope2.md'), pendingPath: join(dir, 'nope3.md') })
check('文件不存在时 section 返回空', g2.section.text() === '', JSON.stringify(g2.section.text()))

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
