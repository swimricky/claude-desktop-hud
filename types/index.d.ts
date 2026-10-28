export type HudTool = { id: string; name: string; target?: string; isDone: boolean }

export type HudAgent = {
  id: string
  type: string
  description: string
  model?: string
  startedAt: number
  endedAt?: number
}

export type HudTodo = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type HudUsage = {
  startedAt: number
  window: number
  percent?: number
  tokens?: number
  limits: HudLimit[]
}

export type HudGit = { branch: string; isDirty: boolean }

export type HudEnv = { claudeMd: number; rules: number; mcps: number; hooks: number }

declare module 'claude-code' {
  interface PluginState {
    'desktop-hud': {
      tools: Shaped<HudTool[]>
      agents: Shaped<HudAgent[]>
      todos: Shaped<HudTodo[]>
      usage: Shaped<HudUsage | null>
      git: HudGit | null
      env: HudEnv | null
    }
  }
}
