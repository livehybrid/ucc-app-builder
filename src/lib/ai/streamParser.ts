/**
 * Simple Server-Sent Events (SSE) parser for AI streams.
 * Handles the "data: ..." format from OpenRouter/OpenAI.
 */

export interface StartEvent {
  type: 'start';
}

export interface ContentEvent {
  type: 'content';
  content: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolCall: {
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  };
  index: number;
}

export interface DoneEvent {
  type: 'done';
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export type StreamEvent = StartEvent | ContentEvent | ToolCallEvent | DoneEvent | ErrorEvent;

export async function* parseStream(response: Response): AsyncGenerator<StreamEvent, void, unknown> {
  if (!response.body) {
    throw new Error('Response body is null');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let updatedBuffer = '';

  yield { type: 'start' };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      updatedBuffer += decoder.decode(value, { stream: true });
      const lines = updatedBuffer.split('\n');
      updatedBuffer = lines.pop() || ''; // Keep the last incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));

            // Handle standard OpenAI/OpenRouter chunk format
            const choice = json.choices?.[0];
            const delta = choice?.delta;

            if (delta?.content) {
              yield { type: 'content', content: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield {
                  type: 'tool_call',
                  toolCall: tc,
                  index: tc.index,
                };
              }
            }
          } catch (e: unknown) {
            // console.warn('Failed to parse SSE chunk:', trimmed);
          }
        }
      }
    }
  } catch (e: unknown) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}
