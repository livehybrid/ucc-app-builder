/**
 * Per-session agent state: todo list, decision log, scratchpad memory.
 *
 * Kept intentionally small and in-memory. Server-side persistence lives under
 * `.ucc-agent/sessions/<id>.json` when the server-side agent loop is adopted
 * (see ROADMAP.md). For now the client holds its own copy.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface Decision {
  id: string;
  /** Short problem statement. */
  question: string;
  /** Chosen answer. */
  decision: string;
  /** Why this was chosen — becomes searchable context later. */
  rationale?: string;
  createdAt: string;
}

export class SessionState {
  private todos: Todo[] = [];
  private decisions: Decision[] = [];
  private memory = new Map<string, string>();

  // --- Todos ---------------------------------------------------------------

  setTodos(next: Todo[]): Todo[] {
    this.todos = next.map((t) => ({ ...t }));
    return this.getTodos();
  }

  mergeTodos(incoming: Todo[]): Todo[] {
    const byId = new Map(this.todos.map((t) => [t.id, t]));
    for (const t of incoming) {
      byId.set(t.id, { ...byId.get(t.id), ...t });
    }
    this.todos = Array.from(byId.values());
    return this.getTodos();
  }

  getTodos(): Todo[] {
    return this.todos.map((t) => ({ ...t }));
  }

  // --- Decisions -----------------------------------------------------------

  recordDecision(entry: Omit<Decision, 'createdAt'>): Decision {
    const decision: Decision = { ...entry, createdAt: new Date().toISOString() };
    const existingIdx = this.decisions.findIndex((d) => d.id === decision.id);
    if (existingIdx >= 0) this.decisions[existingIdx] = decision;
    else this.decisions.push(decision);
    return decision;
  }

  getDecisions(): Decision[] {
    return this.decisions.map((d) => ({ ...d }));
  }

  // --- Memory --------------------------------------------------------------

  setMemory(key: string, value: string): void {
    this.memory.set(key, value);
  }

  getMemory(key: string): string | undefined {
    return this.memory.get(key);
  }

  listMemoryKeys(): string[] {
    return Array.from(this.memory.keys()).sort();
  }

  dumpMemory(): Record<string, string> {
    return Object.fromEntries(this.memory.entries());
  }

  // --- Debug ---------------------------------------------------------------

  summary(): string {
    const parts: string[] = [];
    if (this.todos.length) {
      parts.push(
        'Todos:\n' + this.todos.map((t) => `  [${t.status.padEnd(11)}] ${t.content}`).join('\n')
      );
    }
    if (this.decisions.length) {
      parts.push(
        'Decisions:\n' +
          this.decisions.map((d) => `  - (${d.id}) ${d.question} → ${d.decision}`).join('\n')
      );
    }
    if (this.memory.size) {
      parts.push(
        'Memory:\n' +
          Array.from(this.memory.entries())
            .map(([k, v]) => `  ${k}: ${v.length > 80 ? v.slice(0, 80) + '…' : v}`)
            .join('\n')
      );
    }
    return parts.join('\n\n') || '(empty)';
  }

  clear(): void {
    this.todos = [];
    this.decisions = [];
    this.memory.clear();
  }
}

/** Module-level singleton mirroring the VFS pattern in `src/lib/vfs.ts`. */
export const sessionState = new SessionState();
