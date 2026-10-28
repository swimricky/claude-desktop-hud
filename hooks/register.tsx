import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { HudAgent, HudEnv, HudGit, HudLimit, HudTodo, HudTool, HudUsage } from '../types'

// A claude-hud style HUD (expanded layout) for the desktop app, drawn in the
// band above the prompt. The terminal keeps claude-hud's own status line.

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const tools = atom({ plugin: 'desktop-hud', key: 'tools' } as const, [], { shape: 'tools-1' })
const agents = atom({ plugin: 'desktop-hud', key: 'agents' } as const, [], { shape: 'agents-1' })
const todos = atom({ plugin: 'desktop-hud', key: 'todos' } as const, [], { shape: 'todos-1' })
const usage = atom({ plugin: 'desktop-hud', key: 'usage' } as const, null, { shape: 'usage-1' })
const git = atom({ plugin: 'desktop-hud', key: 'git' } as const, null)
const env = atom({ plugin: 'desktop-hud', key: 'env' } as const, null)

// The desktop app's task list is this MCP tool; terminal sessions use TodoWrite or TaskCreate/TaskUpdate.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', PLAN_TOOL])
const MAX_TOOLS = 500
const TICK_MS = 10_000
// claude-hud's defaults: contextWarningThreshold, contextCriticalThreshold, bar width.
const CONTEXT_WARNING = 70
const CONTEXT_CRITICAL = 85
const BAR_WIDTH = 10

type Args = Record<string, unknown>
type Seg = { text: string; color?: Color; dim?: boolean; bold?: boolean; mono?: boolean }
type Row = Seg[]

const STATUSES: readonly unknown[] = ['pending', 'in_progress', 'completed']
const asStatus = (value: unknown): HudTodo['status'] =>
  STATUSES.includes(value) ? (value as HudTodo['status']) : 'pending'

function nextTodos(list: HudTodo[], tool: string, args: Args, createdId?: string): HudTodo[] {
  const items = tool === 'TodoWrite' ? args.todos : args.items
  if (Array.isArray(items)) {
    return items.map((item: Args) => ({ content: String(item.content ?? ''), status: asStatus(item.status) }))
  }
  if (tool === 'TaskCreate') {
    return createdId ? [...list, { id: createdId, content: String(args.subject ?? ''), status: 'pending' }] : list
  }
  if (tool === 'TaskUpdate') {
    if (args.status === 'deleted') return list.filter(todo => todo.id !== args.taskId)
    return list.map(todo =>
      todo.id !== args.taskId
        ? todo
        : {
            ...todo,
            content: typeof args.subject === 'string' ? args.subject : todo.content,
            status: args.status === undefined ? todo.status : asStatus(args.status),
          },
    )
  }
  // update_plan without items: { advance }, or { done: [n], start: n }, 1-based.
  const done = new Set(Array.isArray(args.done) ? args.done.map(Number) : [])
  let start = typeof args.start === 'number' ? args.start : undefined
  if (args.advance === true) {
    const current = list.findIndex(todo => todo.status === 'in_progress')
    if (current >= 0) done.add(current + 1)
    const pending = list.findIndex((todo, i) => i > current && todo.status === 'pending')
    if (pending >= 0) start ??= pending + 1
  }
  return list.map((todo, i): HudTodo =>
    done.has(i + 1) ? { ...todo, status: 'completed' } : i + 1 === start ? { ...todo, status: 'in_progress' } : todo,
  )
}

function shortPath(target: string, max = 20): string {
  if (target.length <= max) return target
  const file = target.split('/').pop() || target
  return file.length >= max ? `${file.slice(0, max - 1)}…` : `.../${file}`
}

function targetOf(args: Args): string | undefined {
  const path = args.file_path ?? args.notebook_path ?? args.path ?? args.pattern
  if (typeof path === 'string' && path) return shortPath(path)
  const command = args.command ?? args.url
  if (typeof command === 'string' && command) return command.length > 20 ? `${command.slice(0, 19)}…` : command
  return undefined
}

const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[[^\]]*\])?$/i

/** `claude-opus-5-5[1m]` → `Opus 5.5 [1m]`; aliases pass through. */
function modelName(id: string): string {
  const [, family, major, minor, suffix] = MODEL_ID.exec(id) ?? []
  if (!family) return id
  return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? `.${minor}` : ''}${suffix ? ` ${suffix}` : ''}`
}

/** `claude-haiku-5-5` → `haiku-5.5`, as claude-hud badges an agent. */
function shortModel(id: string | undefined): string | undefined {
  const [, family, major, minor] = MODEL_ID.exec(id ?? '') ?? []
  return family ? `${family.toLowerCase()}-${major}${minor ? `.${minor}` : ''}` : id
}

function span(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ${mins % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function elapsed(ms: number): string {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const bar = (percent: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

const contextColor = (p: number): Color => (p >= CONTEXT_CRITICAL ? 'error' : p >= CONTEXT_WARNING ? 'warning' : 'success')
const quotaColor = (p: number): Color => (p >= 90 ? 'error' : p >= 75 ? 'warning' : 'suggestion')
const width = (row: Row): number => row.reduce((n, seg) => n + seg.text.length, 0)
const SEP: Seg = { text: ' │ ', dim: true }

function joinRows(rows: Row[], sep: Seg): Row {
  return rows.flatMap((row, i) => (i === 0 ? row : [sep, ...row]))
}

function contextRow(u: HudUsage | null): Row {
  const percent = u?.percent ?? 0
  const row: Row = [
    { text: 'Context ', dim: true },
    { text: bar(percent), color: contextColor(percent), mono: true },
    { text: ` ${percent}%`, color: contextColor(percent) },
  ]
  // claude-hud adds the token breakdown once context reaches the critical threshold.
  if (u?.tokens !== undefined && percent >= CONTEXT_CRITICAL) {
    row.push({ text: ` (${tokens(u.tokens)}/${tokens(u.window)})`, dim: true })
  }
  return row
}

const LIMIT_LABELS: Record<string, string> = { five_hour: 'Usage', seven_day: 'Weekly', spend_limit: 'Spend' }

function usageRow(limits: HudLimit[], now: number): Row | null {
  if (limits.length === 0) return null
  return joinRows(
    limits.map(limit => {
      const resets = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
      const row: Row = [
        { text: `${LIMIT_LABELS[limit.kind] ?? limit.kind} `, dim: true },
        { text: bar(limit.percentUsed), color: quotaColor(limit.percentUsed), mono: true },
        { text: ` ${Math.round(limit.percentUsed)}%`, color: quotaColor(limit.percentUsed) },
      ]
      if (Number.isFinite(resets)) row.push({ text: ` (resets in ${span(resets)})`, dim: true })
      return row
    }),
    { text: ' | ', dim: true },
  )
}

function envRow(counts: HudEnv | null): Row | null {
  if (!counts) return null
  const parts = (
    [
      [counts.claudeMd, 'CLAUDE.md'],
      [counts.rules, 'rules'],
      [counts.mcps, 'MCPs'],
      [counts.hooks, 'hooks'],
    ] as const
  ).filter(([n]) => n > 0)
  if (parts.length === 0) return null
  return [{ text: parts.map(([n, label]) => `${n} ${label}`).join(' | '), dim: true }]
}

/** `◐ Edit: auth.ts | ✓ Read ×3 | +2 more`: the two newest running tools, then completed counts. */
function toolsRow(list: HudTool[]): Row | null {
  const rows: Row[] = list
    .filter(tool => !tool.isDone)
    .slice(-2)
    .map(tool => [
      { text: '◐ ', color: 'warning' },
      { text: tool.name.replace(/^mcp__.+__/, ''), color: 'suggestion' },
      ...(tool.target ? [{ text: `: ${tool.target}`, dim: true }] : []),
    ])
  const counts = new Map<string, number>()
  for (const tool of list) if (tool.isDone) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  for (const [name, count] of sorted.slice(0, 4)) {
    rows.push([{ text: '✓ ', color: 'success' }, { text: name.replace(/^mcp__.+__/, '') }, { text: ` ×${count}`, dim: true }])
  }
  if (sorted.length > 4) rows.push([{ text: `+${sorted.length - 4} more`, dim: true }])
  return rows.length > 0 ? joinRows(rows, { text: ' | ', dim: true }) : null
}

/** Up to three agents: running ones first, then those that finished in the last minute. */
function agentRows(list: HudAgent[], now: number): Row[] {
  const running = list.filter(agent => agent.endedAt === undefined).slice(-3)
  const slots = Math.min(2, 3 - running.length)
  const recent = list.filter(agent => agent.endedAt !== undefined && now - agent.endedAt <= 60_000)
  return [...running, ...(slots > 0 ? recent.slice(-slots) : [])].map(agent => {
    const badge = shortModel(agent.model)
    return [
      agent.endedAt === undefined ? { text: '◐ ', color: 'warning' } : { text: '✓ ', color: 'success' },
      { text: agent.type, color: 'planMode' },
      ...(badge ? [{ text: ` [${badge}]`, dim: true }] : []),
      ...(agent.description ? [{ text: `: ${agent.description.slice(0, 40)}`, dim: true }] : []),
      { text: ` (${elapsed((agent.endedAt ?? now) - agent.startedAt)})`, dim: true },
    ]
  })
}

/** `▸ Fix the bug (2/5)`, or `✓ All todos complete (5/5)`. */
function todosRow(list: HudTodo[]): Row | null {
  if (list.length === 0) return null
  const completed = list.filter(todo => todo.status === 'completed').length
  const progress: Seg = { text: ` (${completed}/${list.length})`, dim: true }
  const current = list.find(todo => todo.status === 'in_progress')
  if (current) return [{ text: '▸ ', color: 'warning' }, { text: current.content.slice(0, 50) }, progress]
  return completed === list.length ? [{ text: '✓ ', color: 'success' }, { text: 'All todos complete' }, progress] : null
}

async function refreshGit($: EngineInterface) {
  const run = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 }).catch(() => undefined)
  const [head, ...changes] = run?.exitCode === 0 ? run.stdout.split('\n') : []
  // `## main...origin/main [ahead 1]`, `## No commits yet on main`, `## HEAD (no branch)`.
  const branch = head?.slice(3).replace(/^No commits yet on /, '').split('...')[0]?.split(' ')[0]
  const status: HudGit | null = branch ? { branch, isDirty: changes.some(line => line.trim() !== '') } : null
  await update($, git, () => status)
}

const keysOf = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value) : [])
const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

async function readJson($: EngineInterface, path: string): Promise<Args> {
  const text = await $.fs.read(path).catch(() => '{}')
  try {
    return JSON.parse(text) as Args
  } catch {
    return {}
  }
}

// shortcut: skips symlinked rule files (claude-hud follows them); stat links if anyone keeps rules that way.
async function countRules($: EngineInterface, dir: string, depth = 0): Promise<number> {
  const entries = await $.fs.list(dir).catch(() => [])
  let count = 0
  for (const entry of entries) {
    if (entry.kind === 'dir' && depth < 4) count += await countRules($, `${dir}/${entry.name}`, depth + 1)
    else if (entry.kind === 'file' && entry.name.endsWith('.md')) count += 1
  }
  return count
}

/** CLAUDE.md files, rules, MCP servers and hooks, counted from the same files claude-hud reads. */
async function refreshEnv($: EngineInterface) {
  // shortcut: assumes the default config dir (~/.claude); read CLAUDE_CONFIG_DIR if you use one.
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const user = `${home}/.claude`
  const project = `${cwd}/.claude`
  const isUserDir = project === user
  const [userSettings, projectSettings, localSettings, claudeJson, mcpJson] = (await Promise.all([
    $.settings.read({ source: 'user' }).catch(() => ({})),
    isUserDir ? {} : $.settings.read({ source: 'project' }).catch(() => ({})),
    $.settings.read({ source: 'local' }).catch(() => ({})),
    readJson($, `${home}/.claude.json`),
    readJson($, `${cwd}/.mcp.json`),
  ])) as Args[]

  const userMcp = new Set([...keysOf(userSettings?.mcpServers), ...keysOf(claudeJson?.mcpServers)])
  for (const name of stringsOf(claudeJson?.disabledMcpServers)) userMcp.delete(name)
  const projectMcp = new Set([...keysOf(projectSettings?.mcpServers), ...keysOf(localSettings?.mcpServers)])
  const disabled = new Set(stringsOf(localSettings?.disabledMcpjsonServers))
  for (const name of keysOf(mcpJson?.mcpServers)) if (!disabled.has(name)) projectMcp.add(name)

  const mdFiles = [`${user}/CLAUDE.md`, `${cwd}/CLAUDE.md`, `${cwd}/CLAUDE.local.md`, `${project}/CLAUDE.local.md`]
  if (!isUserDir) mdFiles.push(`${project}/CLAUDE.md`)
  const found = await Promise.all(mdFiles.map(path => $.fs.exists(path).catch(() => false)))

  const counts: HudEnv = {
    claudeMd: found.filter(Boolean).length,
    rules: (await countRules($, `${user}/rules`)) + (isUserDir ? 0 : await countRules($, `${project}/rules`)),
    // A server named in both scopes counts twice, as in claude-hud.
    mcps: userMcp.size + projectMcp.size,
    hooks: keysOf(userSettings?.hooks).length + keysOf(projectSettings?.hooks).length + keysOf(localSettings?.hooks).length,
  }
  await update($, env, () => counts)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.session.usage()
    const snapshot: HudUsage = {
      startedAt: now.startedAt,
      window: now.context.window,
      percent: now.context.percent,
      tokens: now.context.tokens,
      limits: now.rateLimits,
    }
    await update($, usage, () => snapshot)
    await Promise.all([refreshGit($), refreshEnv($)])
    // Keeps the session duration and agent timers moving between events.
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const startedAt = await $.clock.now()
      await Promise.all([
        update($, tools, () => []),
        update($, agents, () => []),
        update($, todos, () => []),
        update($, usage, old => (old ? { startedAt, window: old.window, limits: old.limits } : null)),
      ])
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, old => ({
      startedAt: old?.startedAt ?? 0,
      window: e.context.window,
      percent: e.context.percent,
      tokens: e.context.tokens,
      limits: e.rateLimits,
    }))
    return next(e)
  })

  // Main-thread tool calls only, as claude-hud reads the main transcript.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === 'Agent') return next(e)
    const args = e as unknown as Args

    if (TODO_TOOLS.has(e.tool)) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        const createdId = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
        await update($, todos, list => nextTodos(list, e.tool, args, createdId))
      }
      return ran
    }

    const run: HudTool = { id: e.tool_use_id, name: e.tool, target: targetOf(args), isDone: false }
    await update($, tools, list => [...list, run].slice(-MAX_TOOLS))
    try {
      return await next(e)
    } finally {
      await update($, tools, list => list.map(tool => (tool.id === run.id ? { ...tool, isDone: true } : tool)))
    }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) {
      const agent: HudAgent = {
        id: started.agentId,
        type: e.subagentType || 'agent',
        description: e.description,
        model: started.model,
        startedAt: await $.clock.now(),
      }
      await update($, agents, list => [...list, agent].slice(-20))
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refreshGit($)
    } else {
      const endedAt = await $.clock.now()
      await update($, agents, list =>
        list.map(agent => (agent.id === e.agentId && agent.endedAt === undefined ? { ...agent, endedAt } : agent)),
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // claude-hud already draws the terminal's status line.
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const [model, cwd, now, u, status, counts, toolList, agentList, todoList] = await Promise.all([
      $.session.model(),
      $.session.cwd(),
      $.clock.now(),
      read($, usage),
      read($, git),
      read($, env),
      read($, tools),
      read($, agents),
      read($, todos),
    ])

    const project: Row = [
      { text: `[${modelName(model)}]`, color: 'claude' },
      SEP,
      { text: cwd.split('/').pop() || cwd, bold: true },
    ]
    if (status) {
      project.push(
        { text: ' git:(', dim: true },
        { text: status.branch, color: 'suggestion' },
        ...(status.isDirty ? [{ text: '*', color: 'warning' } as const] : []),
        { text: ')', dim: true },
      )
    }
    if (u?.startedAt) project.push(SEP, { text: `⏱ ${span(now - u.startedAt)}`, dim: true })

    // context and usage share a row when it fits, as claude-hud's default mergeGroups does.
    const context = contextRow(u)
    const limits = usageRow(u?.limits ?? [], now)
    const merged = limits && width(context) + 3 + width(limits) <= e.props.bodyColumns ? [joinRows([context, limits], SEP)] : [context, limits]

    const rows = [project, ...merged, envRow(counts), toolsRow(toolList), ...agentRows(agentList, now), todosRow(todoList)].filter(
      (row): row is Row => row !== null,
    )

    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {below}
        {rows.map(row => (
          <Box flexDirection="row">
            {row.map(seg => (
              <Text color={seg.color} dimColor={seg.dim} bold={seg.bold} mono={seg.mono}>
                {seg.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
