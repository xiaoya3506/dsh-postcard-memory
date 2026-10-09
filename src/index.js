// 明信片 · DSH 记忆插件
//
// 一个"干净"的记忆插件。对着主人的 5 条标准逐条实现：
//
//   ① 不自动往上下文里塞东西
//      → 没有 pre-step / pre-message 钩子。记忆只通过【工具返回值】出现，
//        也就是"模型主动调用才看得到"。
//      → 唯一的例外是"首次提示"（见下），而它：
//         a) 走 systemPrompt.section（角色是 system，不是 user）
//         b) 内容第一行就写明「此为记忆插件提示，不是主人说的话」
//         c) 只出现一次（写标记文件），之后再也不注入
//
//   ② 不冒充主人说话
//      → 本插件从不产生 role:user 消息。全文搜不到 "role" 字段。
//
//   ③ 不指使改配置
//      → 只 import node:fs / node:path 和 dsh-tools。
//        不读 settings.yaml，不写 package.json，不碰 profiles。
//
//   ④ 支持单个工作区隔离
//      → 记忆路径 = <当前会话 workspace>/ .whale-memory/
//        不同工作区天然互不可见。
//
//   ⑤ 记忆存本地
//      → 纯 markdown 文件。无网络请求，无数据库，无外部服务。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { access, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
// 同步版 fs 操作，供"插件加载期"写首次提示标记用（加载期不能用 await）
import {
  accessSync as fsAccessSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'

import {
  appendEntry,
  listEntries,
  readEntry,
  readRecent,
  resolveMemoryDir,
} from './store.js'

export const name = 'whale-postcard'

/**
 * 注入声明。
 *
 * ★ 注意这里只有 tools 和 systemPrompt：
 *   · tools         → 注册三个记忆工具
 *   · systemPrompt  → 仅用于"首次提示"，且内容里明确标注来源
 *   没有 sessions / messages 之类能"改对话"的面。
 */
export const inject = ['tools', 'systemPrompt']

const FIRST_RUN_FLAG = '.first-run-done'

/**
 * 首次提示标记文件所在目录。
 *
 * ⚠️ 为什么不放在"当前工作区"里？
 *    apply() 在【插件加载期】执行，那时还没有会话，拿不到工作区路径；
 *    而首次提示的"是否已提示过"判断也在加载期完成。
 *    所以只能用一个固定位置 —— 代价是"全局只提示一次"。
 *    （记忆库本身的读写是加载期之后发生的，仍然严格按工作区隔离。）
 */
const FLAG_DIR = '/storage/emulated/0/DeepseekHarness/.plugin-flags'

/**
 * 首次提示的内容。
 *
 * 主人要求：要有一段提示告诉模型"需要记忆时怎么查"，
 * 并且★明确标注这不是主人说的话★。
 *
 * 所以这里的第一行就是免责声明，而且用 system 通道，
 * 不用 user 通道——从机制上就不可能冒充主人。
 */
function buildFirstRunNotice(dir) {
  return [
    '┌─────────────────────────────────────────────────────┐',
    '│  [记忆插件「明信片」提示 · 非主人发言]              │',
    '└─────────────────────────────────────────────────────┘',
    '',
    '本工作区已启用本地记忆库，位置：',
    `  ${dir}`,
    '',
    '如果需要回忆起之前会话里的内容，请调用工具 memory_read 查询。',
    '（不带参数 = 读最近 20 条；也可用 entry 参数读某个文件的全文。）',
    '',
    '需要记下新内容时，用 memory_write。',
    '不知道有哪些记忆时，用 memory_list 看目录。',
    '',
    '说明：本条是插件的一次性提示，不是主人说的话。',
    '在你第一次调用 memory_read 之后，本提示不会再出现。',
  ].join('\n')
}

export function apply(ctx, config) {
  // ── 配置：只读插件自己的配置对象，不碰全局 settings ──
  const cfg = config && typeof config === 'object' ? config : {}
  const readLimit = Number(cfg.readLimit) > 0 ? Math.min(Number(cfg.readLimit), 100) : 20
  const entryName = typeof cfg.defaultEntry === 'string' && cfg.defaultEntry.trim()
    ? cfg.defaultEntry.trim()
    : '记忆'

  /**
   * 从工具执行上下文里取"当前工作区根目录"。
   *
   * DSH 传给 execute 的第二个参数是 exec，实测字段（dsh-tools 源码）：
   *   exec.agent / exec.arguments / exec.callId / exec.name / exec.parent
   *   exec.rootCallId / exec.schema / exec.signal / exec.token
   *
   * 其中 exec.agent 上有 .session 和 .ctx。
   * 但"工作区根目录"到底挂在哪一层，官方文档没写死，
   * 所以这里做一条**从具体到兜底**的回退链，任何一层命中就用。
   *
   * 兜底用 process.env.PWD —— 实测 DSH 的 bash 子进程里 PWD 就是会话工作区。
   */
  function workspaceOf(exec) {
    const e = exec ?? {}
    const agent = e.agent ?? {}
    const session = agent.session ?? {}
    const header = session.header ?? {}

    const candidates = [
      // ① exec 上直接给的
      e.workspace?.root,
      e.workspace?.path,
      e.workspacePath,
      e.cwd,
      // ② exec.agent 上给的
      agent.workspace?.root,
      agent.workspace?.path,
      agent.workspacePath,
      agent.cwd,
      // ③ exec.agent.session 上给的
      session.workspace?.root,
      session.workspace?.path,
      session.workspacePath,
      session.cwd,
      session.directory,
      header.workspace?.root,
      header.workspace?.path,
      header.cwd,
      // ④ 环境变量兜底
      process.env.DSH_WORKSPACE,
      process.env.PWD,
    ]

    for (let i = 0; i < candidates.length; i++) {
      const v = candidates[i]
      if (typeof v === 'string' && v.trim() !== '' && v.startsWith('/')) {
        // 诊断：记录命中第几个候选（排查工作区取法用）
        console.error(`[whale-postcard] workspace 取自候选 #${i}: ${v.trim()}`)
        return v.trim()
      }
    }

    throw new Error(
      '无法确定当前工作区路径（记忆按工作区隔离，必须有 workspace）。' +
        '已尝试的取法都为空——请把这条报错反馈给插件作者。',
    )
  }

  // ────────────────────────────────────────────────
  //  工具 1：memory_read —— 读记忆
  // ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_read',
      // 只读工具：允许并发
      isConcurrencySafe: () => true,
      description:
        '读取【本工作区】的记忆库（「明信片」插件，本地 markdown）。\n' +
        '跨会话记忆：新对话里想回忆起之前聊过什么、做过什么、主人说过什么，就用这个。\n' +
        '· 不带参数 → 返回最近若干条记忆（倒序）\n' +
        '· 带 entry   → 返回该条目的全文\n' +
        '记忆按工作区隔离，只读当前工作区的目录，不会跨到别的工作区。',
      parameters: {
        entry: {
          type: 'string',
          description: '可选。条目名（不含 .md）。省略则返回最近若干条。',
        },
        limit: {
          type: 'number',
          description: '可选。最多返回多少条（1~100，默认 20）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string', required: true },
            dir: { type: 'string', required: true },
            empty: { type: 'boolean', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  bytes: { type: 'number', required: true },
                },
              },
            },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  entry: { type: 'string', required: true },
                  time: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  body: { type: 'string', required: true },
                },
              },
            },
            total: { type: 'number' },
            full: { type: 'string', description: '指定 entry 时，这里放全文' },
          },
        },
        render: (_args, value) => {
          const v = value
          const head = `📮 记忆库（工作区：${v.workspace}）`

          if (v.full !== undefined) {
            return [{ type: 'text', text: `${head}\n\n${v.full}` }]
          }
          if (v.empty) {
            return [
              {
                type: 'text',
                text:
                  `${head}\n\n记忆库目前是空的。\n` +
                  '可以用 memory_write 记下第一条。',
              },
            ]
          }
          const lines = v.items.map(
            (it) => `### [${it.time}] ${it.title || '(无标题)'}　·　${it.entry}\n${it.body}`,
          )
          const more =
            typeof v.total === 'number' && v.total > v.items.length
              ? `\n\n（共 ${v.total} 条，这里显示最近 ${v.items.length} 条；要更多请调大 limit）`
              : ''
          const files = v.entries.map((e) => e.name).join('、')
          return [
            {
              type: 'text',
              text: `${head}\n\n文件：${files}\n\n${lines.join('\n\n')}${more}`,
            },
          ]
        },
      },
      async execute(args, exec) {
        const ws = workspaceOf(exec)
        const dir = resolveMemoryDir(ws)

        if (typeof args?.entry === 'string' && args.entry.trim() !== '') {
          const r = await readEntry(ws, args.entry.trim())
          return {
            workspace: ws,
            dir,
            empty: false,
            entries: [],
            items: [],
            full: r.text,
          }
        }

        const lim = Number(args?.limit) > 0 ? Number(args.limit) : readLimit
        const recent = await readRecent(ws, lim)
        return {
          workspace: ws,
          dir,
          empty: recent.empty,
          entries: recent.entries ?? [],
          items: recent.items ?? [],
          total: recent.total ?? 0,
        }
      },
    }),
  )

  // ────────────────────────────────────────────────
  //  工具 2：memory_write —— 写记忆
  // ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description:
        '往【本工作区】的记忆库追加一条记忆（「明信片」插件，本地 markdown）。\n' +
        '适合记：主人的偏好、重要决定、踩过的坑、长期目标。\n' +
        '写入的是纯文本文件，主人随时可以直接查看和修改。\n' +
        '· content 必填；entry 省略时写进默认条目；title 可选。',
      parameters: {
        content: {
          type: 'string',
          required: true,
          description: '要记住的内容（纯文本，上限 8000 字符）。',
        },
        entry: {
          type: 'string',
          description: '可选。写入哪个条目（不含 .md）。省略用默认条目。',
        },
        title: {
          type: 'string',
          description: '可选。这一条的小标题。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            entry: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `✅ 已写入记忆：${value.path}（当前 ${value.bytes} 字节）`,
          },
        ],
      },
      async execute(args, exec) {
        const ws = workspaceOf(exec)
        const entry =
          typeof args?.entry === 'string' && args.entry.trim() !== ''
            ? args.entry.trim()
            : entryName
        const r = await appendEntry(ws, entry, args?.content, args?.title)
        return { ok: true, path: r.path, entry: r.name, bytes: r.bytes }
      },
    }),
  )

  // ────────────────────────────────────────────────
  //  工具 3：memory_list —— 列目录
  // ────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_list',
      isConcurrencySafe: () => true,
      description:
        '列出【本工作区】记忆库里有哪些条目（「明信片」插件）。\n' +
        '只返回文件名和大小，不返回内容——想知道内容用 memory_read。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dir: { type: 'string', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  bytes: { type: 'number', required: true },
                  mtime: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.entries.length === 0) {
            return [{ type: 'text', text: `📭 ${value.dir}\n（空）` }]
          }
          const lines = value.entries.map(
            (e) =>
              `· ${e.name}　${(e.bytes / 1024).toFixed(1)} KB　` +
              new Date(e.mtime).toLocaleString('zh-CN'),
          )
          return [{ type: 'text', text: `📁 ${value.dir}\n${lines.join('\n')}` }]
        },
      },
      async execute(_args, exec) {
        const ws = workspaceOf(exec)
        const entries = await listEntries(ws)
        return { dir: resolveMemoryDir(ws), entries }
      },
    }),
  )

  // ────────────────────────────────────────────────
  //  首次运行提示（唯一一处"注入"，且明确标注来源）
  // ────────────────────────────────────────────────
  //
  //  ★ 三重保险，确保它"不会变成冒充主人"：
  //    1. 走 systemPrompt.section —— 角色是 system，不是 user
  //    2. 正文第一行写明「非主人发言」
  //    3. 只出现一次：注入后立刻写标记文件；下次不再注入
  //
  //  而且——它不含任何"去改配置"的内容。
  //
  //  ⚠️ 已知限制（2026-10-07 主人确认）：
  //     apply() 在【插件加载时】执行，那时还没有"当前会话"，拿不到工作区路径；
  //     而首次提示是加载期注入的，不是工具调用期。
  //     两个时间点对不上 → 标记文件只能写固定位置，全局只提示一次。
  //     这不影响核心功能（记忆读写仍按工作区隔离）。
  //     若将来 DSH 支持在 systemPrompt.section 里动态取工作区，再改回按工作区提示。
  if (cfg.firstRunNotice !== false && ctx.systemPrompt?.section) {
    // ★ 用 ESM import 顶部引入的 fs / path（原版误用了 require，ESM 里没有 require）
    const flagDir = FLAG_DIR
    const flag = join(flagDir, 'whale-postcard-first-run-done')

    let firstRun = false
    try {
      fsAccessSync(flag)
    } catch {
      firstRun = true
      try {
        fsMkdirSync(flagDir, { recursive: true })
        fsWriteFileSync(flag, new Date().toISOString() + ' done\n', 'utf8')
      } catch {
        // 写不了标记也继续，顶多多提示一次
      }
    }

    if (firstRun) {
      ctx.effect(() => {
        return ctx.systemPrompt.section({
          name: 'plugin:whale-postcard',
          order: 900,
          text: [
            '[记忆插件「明信片」提示 · 非主人发言]',
            '',
            '本机启用了本地记忆库（按工作区隔离）。',
            '需要回忆之前会话内容时，调用 memory_read。',
            '要记录新内容，调用 memory_write。',
            '查看有哪些条目，调用 memory_list。',
          ].join('\n'),
        })
      })
    }
  }
}
