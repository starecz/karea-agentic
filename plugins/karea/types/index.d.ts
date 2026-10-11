export type ActiveTask = { shortid: string; id: string; title: string; status: string }
export type LocalEvent = { at: number; label: string; isSynced: boolean }
export type RemoteChange = { at: number; lines: string[] }
export type ContextAge = { title: string; updatedAt: number; lastEditedMode: string }
export type Touched = { shortid: string; title: string; pending: string[] }
export type ChipState = { tone: 'synced' | 'behind' | 'remote' | 'none'; mark: string; label: string }
export type SyncSnapshot = { status: string; notes: string[]; context: Record<string, string> }
export type HistoryRow = {
  field: string
  oldValue: string | null
  newValue: string | null
  mode: string
  createdAt: string
}

declare module 'claude-code' {
  interface PluginState {
    karea: {
      active: ActiveTask | null
      pending: string[]
      events: LocalEvent[]
      lastSyncAt: number
      remote: RemoteChange | null
      watermark: number
      contextAges: ContextAge[]
      touched: Touched[]
      lastPromptAt: number
      needsReread: boolean
      clearArmed: boolean
      lastPrompt: string
      chipNow: ChipState | null
      snapshot: SyncSnapshot | null
      turnWrote: boolean
      earlier: { prompt: string; answer: string } | null
      openDecisions: { text: string; age: number }[]
      lastCheckAt: number
      seenChanges: string[]
    }
  }
}
