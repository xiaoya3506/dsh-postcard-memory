// 明信片 · 存储层自测
//
// 不依赖 DSH 运行时，单独验证 store.js 的逻辑。
// 直接跑：node 测试/test-store.mjs

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveMemoryDir,
  safeName,
  appendEntry,
  readEntry,
  readRecent,
  listEntries,
  MEMORY_DIR,
} from '../src/store.js'

let pass = 0
let fail = 0

function ok(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`)
  }
}

async function expectThrow(label, fn, needle) {
  try {
    await fn()
    fail++
    console.log(`  ❌ ${label}  （本应抛错，却成功了）`)
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (needle && !msg.includes(needle)) {
      fail++
      console.log(`  ❌ ${label}  （错误信息不含 "${needle}"：${msg}）`)
    } else {
      pass++
      console.log(`  ✅ ${label}`)
    }
  }
}

const root = await mkdtemp(join(tmpdir(), 'postcard-test-'))
console.log(`测试目录：${root}\n`)

// ─────────────────────────────────────────
console.log('① 路径与隔离')
// ─────────────────────────────────────────
{
  const dir = resolveMemoryDir(root)
  ok('记忆目录在 workspace 之下', dir.startsWith(root), dir)
  ok('目录名正确', dir.endsWith(MEMORY_DIR))
}

await expectThrow('拒绝空 workspace', () => resolveMemoryDir(''), '非空字符串')
await expectThrow('拒绝越界路径（..）', () => resolveMemoryDir(root + '/../../etc'), '..')
await expectThrow('拒绝纯 ..', () => resolveMemoryDir('..'), '..')
await expectThrow('拒绝路径中段 ..', () => resolveMemoryDir('/a/b/../c'), '..')

// 两个不同工作区互不可见
{
  const wsA = join(root, 'wsA')
  const wsB = join(root, 'wsB')
  await mkdir(wsA, { recursive: true })
  await mkdir(wsB, { recursive: true })

  await appendEntry(wsA, '记忆', '这是 A 工作区的记忆', 'A 的条目')
  await appendEntry(wsB, '记忆', '这是 B 工作区的记忆', 'B 的条目')

  const a = await readRecent(wsA, 10)
  const b = await readRecent(wsB, 10)

  ok('A 工作区只读到自己的', a.items.every((i) => i.body.includes('A 工作区')))
  ok('B 工作区只读到自己的', b.items.every((i) => i.body.includes('B 工作区')))
  ok('A 看不到 B 的内容', !JSON.stringify(a).includes('B 工作区'))
  ok('B 看不到 A 的内容', !JSON.stringify(b).includes('A 工作区'))
}

// ─────────────────────────────────────────
console.log('\n② 文件名安全')
// ─────────────────────────────────────────
{
  ok('允许中文', safeName('记忆') === '记忆')
  ok('允许英文数字', safeName('facts_2026-10') === 'facts_2026-10')
}
await expectThrow('拒绝斜杠', () => safeName('a/b'), '')
await expectThrow('拒绝 ..', () => safeName('..'), '')
await expectThrow('拒绝反斜杠', () => safeName('a\\b'), '')
await expectThrow('拒绝空名', () => safeName(''), '')

// ─────────────────────────────────────────
console.log('\n③ 写入与读取')
// ─────────────────────────────────────────
{
  const ws = join(root, 'wsC')
  await mkdir(ws, { recursive: true })

  const r1 = await appendEntry(ws, '记忆', '第一条记忆', '测试一')
  ok('第一次写入成功', r1.bytes > 0, `${r1.bytes} 字节`)

  await appendEntry(ws, '记忆', '第二条记忆', '测试二')
  const r3 = await appendEntry(ws, '事实', '独立条目的内容')

  const list = await listEntries(ws)
  ok('列出 2 个条目', list.length === 2, list.map((e) => e.name).join(','))

  const entry = await readEntry(ws, '记忆')
  ok('读回条目包含两条', entry.text.includes('第一条') && entry.text.includes('第二条'))
  ok('读回条目带时间戳', /## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(entry.text))

  const recent = await readRecent(ws, 10)
  ok('readRecent 汇总到 3 条', recent.items.length === 3, `实际 ${recent.items.length}`)
  ok('条目归属正确', recent.items.some((i) => i.entry === '事实'))

  // 倒序检查（第一条应该是最后写的）
  ok(
    '时间倒序（最新在前）',
    recent.items[0].body.includes('独立条目') || recent.items[0].body.includes('第二条'),
  )

  await expectThrow('读不存在的条目不崩', () => readEntry(ws, '不存在'), '不存在')
}

// ─────────────────────────────────────────
console.log('\n④ 边界与防护')
// ─────────────────────────────────────────
{
  const ws = join(root, 'wsD')
  await mkdir(ws, { recursive: true })

  await expectThrow('拒绝空内容', () => appendEntry(ws, '记忆', ''), '不能为空')
  await expectThrow('拒绝空白内容', () => appendEntry(ws, '记忆', '   \n  '), '不能为空')

  const long = 'x'.repeat(9000)
  await expectThrow('拒绝超长单条', () => appendEntry(ws, '记忆', long), '过长')

  // 文件大小上限（不断追加直到超限）
  let hitCap = false
  try {
    for (let i = 0; i < 80; i++) {
      await appendEntry(ws, '大文件', 'y'.repeat(4000), `第 ${i} 块`)
    }
  } catch (err) {
    hitCap = String(err?.message ?? '').includes('上限')
  }
  ok('文件大小上限生效', hitCap)
}

// ─────────────────────────────────────────
console.log('\n⑤ 文件确实是本地 markdown')
// ─────────────────────────────────────────
{
  const ws = join(root, 'wsE')
  await mkdir(ws, { recursive: true })
  await appendEntry(ws, '可读性', '用户应该能直接打开这个文件看到这句话', '人类可读')

  const dir = resolveMemoryDir(ws)
  const raw = await readFile(join(dir, '可读性.md'), 'utf8')
  ok('文件以 # 标题开头', raw.startsWith('# 可读性'))
  ok('内容是人类可读的中文', raw.includes('用户应该能直接打开'))
  ok('是纯文本（无二进制）', raw === Buffer.from(raw, 'utf8').toString('utf8'))

  const all = await listEntries(ws)
  ok('只有 .md 文件', all.every((e) => e.name.endsWith('.md')))
}

// ─────────────────────────────────────────
console.log('\n⑥ 源码层面的"干净"检查')
// ─────────────────────────────────────────
{
  const idx = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  const sto = await readFile(new URL('../src/store.js', import.meta.url), 'utf8')

  // ★ 只检查"真正的代码"，剔除注释——
  //   否则注释里写着"不碰 settings"反而会被判成"碰了 settings"。
  const strip = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 http:// 里的 //）
  const code = strip(idx) + '\n' + strip(sto)

  ok('没有 role:user 注入', !/role\s*:\s*['"]user['"]/.test(code))
  ok('没有写 settings', !/settings\.ya?ml/i.test(code))
  ok('没有改 package.json', !/writeFile\([^)]*package\.json/.test(code))
  ok('没有 http 请求', !/\bfetch\s*\(/.test(code) && !/https?:\/\//.test(code))
  ok('没有 child_process', !/child_process/.test(code))
  ok('没有 eval', !/(?<![\w.])eval\s*\(/.test(code))
  ok('没有 pre-step 钩子', !/preStep|beforeMessage|onMessage/i.test(code))
  ok(
    '只 import node 内建与 dsh-tools',
    [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .every((s) => s.startsWith('node:') || s.startsWith('.') || s === '@deepseek-ai/dsh-tools'),
  )
  ok('写操作只落在记忆目录', !/writeFile\(/.test(sto) || /join\(dir/.test(sto))
}

// ─────────────────────────────────────────
console.log('\n⑦ 首次提示的"非冒充"检查')
// ─────────────────────────────────────────
{
  const idx = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  ok('首次提示含免责声明', idx.includes('非用户发言'))
  ok('首次提示走 systemPrompt', idx.includes('systemPrompt.section'))
  ok('首次提示只出现一次', idx.includes('FIRST_RUN_FLAG'))

  // 提示正文里不能出现"去改配置"这类指令。
  // 只检查 buildFirstRunNotice 函数的返回值区间。
  const start = idx.indexOf('function buildFirstRunNotice')
  const end = idx.indexOf('export function apply')
  const notice = start >= 0 && end > start ? idx.slice(start, end) : ''
  ok('提示函数存在', notice.length > 0)
  ok(
    '提示里不含"改配置"指令',
    notice.length > 0 && !/promptLang|settings|\.ya?ml|config/i.test(notice),
  )
}

// ─────────────────────────────────────────
await rm(root, { recursive: true, force: true })

console.log('\n' + '═'.repeat(46))
console.log(`  通过 ${pass}　失败 ${fail}`)
console.log('═'.repeat(46))
process.exit(fail === 0 ? 0 : 1)
