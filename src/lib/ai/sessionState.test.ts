import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from './sessionState';

describe('SessionState', () => {
  let s: SessionState;
  beforeEach(() => {
    s = new SessionState();
  });

  it('sets and gets todos', () => {
    s.setTodos([
      { id: '1', content: 'plan', status: 'in_progress' },
      { id: '2', content: 'build', status: 'pending' },
    ]);
    expect(s.getTodos()).toHaveLength(2);
    expect(s.getTodos()[0].status).toBe('in_progress');
  });

  it('merges todos by id', () => {
    s.setTodos([{ id: '1', content: 'a', status: 'pending' }]);
    s.mergeTodos([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'pending' },
    ]);
    const todos = s.getTodos();
    expect(todos).toHaveLength(2);
    expect(todos.find((t) => t.id === '1')!.status).toBe('completed');
  });

  it('records and overwrites decisions by id', () => {
    s.recordDecision({
      id: 'd1',
      question: 'Auth?',
      decision: 'OAuth',
      rationale: 'secure',
    });
    s.recordDecision({
      id: 'd1',
      question: 'Auth?',
      decision: 'Basic',
      rationale: 'dev only',
    });
    expect(s.getDecisions()).toHaveLength(1);
    expect(s.getDecisions()[0].decision).toBe('Basic');
  });

  it('stores and reads memory', () => {
    s.setMemory('endpoint', 'https://api.example.com');
    expect(s.getMemory('endpoint')).toBe('https://api.example.com');
    expect(s.listMemoryKeys()).toEqual(['endpoint']);
  });

  it('summary is non-empty after activity', () => {
    s.setTodos([{ id: '1', content: 'x', status: 'pending' }]);
    s.recordDecision({ id: 'd1', question: 'q', decision: 'yes' });
    s.setMemory('k', 'v');
    const out = s.summary();
    expect(out).toMatch(/Todos:/);
    expect(out).toMatch(/Decisions:/);
    expect(out).toMatch(/Memory:/);
  });

  it('clear resets everything', () => {
    s.setTodos([{ id: '1', content: 'x', status: 'pending' }]);
    s.recordDecision({ id: 'd1', question: 'q', decision: 'yes' });
    s.setMemory('k', 'v');
    s.clear();
    expect(s.getTodos()).toEqual([]);
    expect(s.getDecisions()).toEqual([]);
    expect(s.listMemoryKeys()).toEqual([]);
  });
});
