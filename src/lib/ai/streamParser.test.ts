import { describe, it, expect } from 'vitest';
import { parseStream } from './streamParser';

describe('parseStream', () => {
  it('should parse simple content events', async () => {
    const stream = new ReadableStream({
      start(controller) {
        // Correct format: data: { choices: [{ delta: { content: "..." } }] }
        controller.enqueue(
          new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Hello"}}]}\n\n')
        );
        controller.enqueue(
          new TextEncoder().encode('data: {"choices": [{"delta": {"content": " World"}}]}\n\n')
        );
        controller.close();
      },
    });

    // Mock Response object
    const mockResponse = {
      body: stream,
    } as unknown as Response;

    const events = [];
    for await (const event of parseStream(mockResponse)) {
      events.push(event);
    }

    // Implementation yields 'start' first, then content, then 'done'
    expect(events).toHaveLength(4); // start + 2 content + done
    expect(events[0]).toEqual({ type: 'start' });
    expect(events[1]).toEqual({ type: 'content', content: 'Hello' });
    expect(events[2]).toEqual({ type: 'content', content: ' World' });
    expect(events[3]).toEqual({ type: 'done' });
  });

  it('should parse tool calls', async () => {
    const stream = new ReadableStream({
      start(controller) {
        const toolCall = {
          index: 0,
          id: 'call_123',
          function: { name: 'test_tool', arguments: '{}' },
        };
        controller.enqueue(
          new TextEncoder().encode(
            `data: {"choices": [{"delta": {"tool_calls": [${JSON.stringify(toolCall)}]}}]}\n\n`
          )
        );
        controller.close();
      },
    });

    const mockResponse = { body: stream } as unknown as Response;

    const events = [];
    for await (const event of parseStream(mockResponse)) {
      events.push(event);
    }

    expect(events).toHaveLength(3); // start + tool_call + done
    expect(events[0]).toEqual({ type: 'start' });
    expect(events[1]).toEqual({
      type: 'tool_call',
      toolCall: {
        index: 0,
        id: 'call_123',
        function: { name: 'test_tool', arguments: '{}' },
      },
      index: 0,
    });
    expect(events[2]).toEqual({ type: 'done' });
  });

  it('should handle split chunks', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices": [{"de'));
        controller.enqueue(new TextEncoder().encode('lta": {"content": "Split"}}]}\n\n'));
        controller.close();
      },
    });

    const mockResponse = { body: stream } as unknown as Response;

    const events = [];
    for await (const event of parseStream(mockResponse)) {
      events.push(event);
    }

    expect(events).toHaveLength(3); // start + content + done
    expect(events[0]).toEqual({ type: 'start' });
    expect(events[1]).toEqual({ type: 'content', content: 'Split' });
    expect(events[2]).toEqual({ type: 'done' });
  });
});
