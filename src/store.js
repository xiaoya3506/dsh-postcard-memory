// 明信片 · 记忆存储层
//
// 作者：鲸鱼娘（Whale Girl）<id-trqnp-tqqhm-gfgnn-wxhjg@mailpal.com>
// 需求方：小雅（xiaoya）<xiaoya3506@outlook.com>
// 仓库：https://github.com/xiaoya3506/dsh-postcard-memory
//
// 设计原则（对着小雅提出的 5 条标准）：
//   ① 不自动塞上下文  → 这一层只是文件读写，没有任何钩子
//   ② 不经过用户通道  → 只返回数据，不产生任何消息
//   ③ 不指使改配置    → 只 import node:fs / node:path，绝不碰 settings/config
//   ④ 单工作区隔离    → 根目录 = 传入的 workspace 路径，绝不写到别处
//   ⑤ 本地存储        → 纯 markdown，无网络、无数据库
//
// 这个文件里没有一行代码会：
//   · 读 process.env 里的敏感变量
//   · 写 <workspace>/.whale-memory/ 以外的任何路径
//   · 发起网络请求

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 记忆目录名（工作区根目录下的隐藏目录） */
export const MEMORY_DIR = '.whale-memory'

/** 单个文件大小上限：避免某个文件无限长大（256 KB） */
const MAX_FILE_BYTES = 256 * 1024

/** 单条记忆长度上限 */
const MAX_ENTRY_CHARS = 8000

/** 单次读取返回的条目上限 */
const MAX_READ_ENTRIES = 100

/**
 * 把 workspace 根目录解析成记忆目录的绝对路径。
 *
 * ★ 安全点：这里会校验最终路径确实落在 workspace 内，
 *   防止通过 `..` 之类的输入越界写到系统目录。
 */
export function resolveMemoryDir(workspace) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('workspace 必须是非空字符串')
  }

  // ★ 先检查原始输入里有没有 `..` 段。
  //   必须在 resolve() 之前查——因为 resolve() 会把 `..` 规范化掉，
  //   查完再 resolve 就看不出来了（这是第一版测试抓出来的 bug）。
  const raw = workspace.trim()
  const rawParts = raw.split(/[/\\]+/)
  if (rawParts.includes('..')) {
    throw new Error('workspace 不能包含 .. 路径段（拒绝越界路径）')
  }

  const root = resolve(raw)
  const dir = resolve(join(root, MEMORY_DIR))

  // 二次保险：规范化后仍须严格位于 workspace 之下
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error('记忆目录必须位于工作区内（拒绝越界路径）')
  }
  return dir
}

/**
 * 校验一个文件名是"安全的简单文件名"。
 * 只允许：中文、字母、数字、下划线、短横线、点。禁止斜杠和 ..
 */
export function safeName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('名称必须是非空字符串')
  }
  const n = name.trim()
  if (n.length > 120) throw new Error('名称过长（上限 120 字符）')
  if (n.includes('/') || n.includes('\\') || n.includes('..')) {
    throw new Error('名称不能包含路径分隔符或 ..')
  }
  if (!/^[\p{Script=Han}A-Za-z0-9._-]+$/u.test(n)) {
    throw new Error('名称只能包含中文、字母、数字、下划线、点、短横线')
  }
  return n
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 读一个文件；不存在时返回 fallback */
async function readTextOr(path, fallback = '') {
  try {
    const buf = await readFile(path)
    return buf.toString('utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

/** 写文件，并强制大小上限 */
async function writeTextCapped(path, text) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(
      `写入被拒绝：内容 ${buf.length} 字节，超过单文件上限 ${MAX_FILE_BYTES} 字节。` +
        '请改用 memory_write 追加，或先用 memory_forget 清理旧条目。',
    )
  }
  await writeFile(path, buf)
  return buf.length
}

/** 时间戳，格式 2026-10-07 15:04:05 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 日期，格式 2026-10-07 */
export function dateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 列出记忆库里所有条目文件。
 * 返回 [{ name, bytes, mtime }]，按修改时间倒序。
 */
export async function listEntries(workspace) {
  const dir = resolveMemoryDir(workspace)
  let names = []
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const st = await stat(join(dir, name))
      if (!st.isFile()) continue
      out.push({ name, bytes: st.size, mtime: st.mtimeMs })
    } catch {
      // 读不到就跳过，不让单个坏文件影响整体
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * 读一条记忆的全文。
 * @param {string} workspace 工作区根目录
 * @param {string} name      条目名（不含 .md）
 */
export async function readEntry(workspace, name) {
  const dir = resolveMemoryDir(workspace)
  const file = safeName(name) + '.md'
  const text = await readTextOr(join(dir, file), null)
  if (text === null) {
    const entries = await listEntries(workspace)
    const hint = entries.length
      ? `现有条目：${entries.map((e) => e.name.replace(/\.md$/, '')).join('、')}`
      : '记忆库目前是空的。'
    throw new Error(`条目「${name}」不存在。${hint}`)
  }
  return { name, text, path: join(dir, file) }
}

/**
 * 追加一条记忆。
 *
 * 格式：
 *   ## [2026-10-07 15:04:05] 标题
 *   正文
 */
export async function appendEntry(workspace, name, content, title) {
  const dir = resolveMemoryDir(workspace)
  await ensureDir(dir)
  const file = safeName(name) + '.md'

  let text = String(content ?? '')
  if (text.trim() === '') throw new Error('内容不能为空')
  if (text.length > MAX_ENTRY_CHARS) {
    throw new Error(`内容过长（${text.length} 字符，上限 ${MAX_ENTRY_CHARS}）`)
  }

  const path = join(dir, file)
  const existing = await readTextOr(path, '')

  const head = title && String(title).trim() !== '' ? ` ${String(title).trim()}` : ''
  const block = `## [${stamp()}]${head}\n\n${text.trim()}\n\n`

  // 文件不存在时先写个标题行
  const prefix = existing === '' ? `# ${name}\n\n` : existing
  const next = prefix + block
  const bytes = await writeTextCapped(path, next)

  return { name, path, bytes, appended: block.length }
}

/**
 * 汇总读取：返回所有条目的最近 N 条记录。
 *
 * 这是给 memory_read 用的——一次性把"最近的记忆"带回给模型。
 */
export async function readRecent(workspace, limit = 20) {
  const entries = await listEntries(workspace)
  if (entries.length === 0) {
    return { empty: true, entries: [], items: [] }
  }
  const lim = Math.max(1, Math.min(Number(limit) || 20, MAX_READ_ENTRIES))

  const items = []
  for (const e of entries) {
    const raw = await readTextOr(join(resolveMemoryDir(workspace), e.name), '')
    // 按 "## [" 切块，取每块
    const blocks = raw
      .split(/\n(?=## \[)/)
      .filter((b) => b.startsWith('## ['))
      .map((b) => b.trim())
    for (const b of blocks) {
      const m = /^## \[([^\]]+)\]\s*(.*)$/.exec(b.split('\n')[0])
      items.push({
        entry: e.name.replace(/\.md$/, ''),
        time: m ? m[1] : '',
        title: m ? m[2].trim() : '',
        body: b.split('\n').slice(1).join('\n').trim(),
      })
    }
  }
  // 按时间字符串倒序（格式固定，可直接比较）
  items.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))

  return {
    empty: false,
    entries: entries.map((e) => ({ name: e.name.replace(/\.md$/, ''), bytes: e.bytes })),
    items: items.slice(0, lim),
    total: items.length,
  }
}
