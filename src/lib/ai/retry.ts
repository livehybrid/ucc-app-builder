/**
 * Fetch wrapper with exponential backoff for transient errors.
 */

interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  backoffFactor?: number;
  retryableStatus?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffFactor: 2,
  retryableStatus: [429, 500, 502, 503, 504],
};

export class RetryError extends Error {
  constructor(
    message: string,
    public lastError: unknown,
    public status?: number
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let delay = opts.initialDelay;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      // If success, return immediately
      if (response.ok) {
        return response;
      }

      // Check if status is retryable
      if (opts.retryableStatus.includes(response.status)) {
        if (attempt < opts.maxRetries) {
          const retryAfter = response.headers?.get?.('Retry-After');
          let waitTime = delay;

          if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
              waitTime = seconds * 1000;
            }
          }

          console.log(
            `Request failed with ${response.status}. Retrying in ${waitTime}ms (Attempt ${attempt + 1}/${opts.maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          delay *= opts.backoffFactor;
          continue;
        }

        throw new Error('Max retries reached');
      }

      // Non-retryable HTTP errors fail immediately.
      throw new Error(`HTTP error! status: ${response.status}`);
    } catch (err: unknown) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const isNonRetryableHttpError =
        message.startsWith('HTTP error! status:') || message === 'Max retries reached';
      if (isNonRetryableHttpError) {
        throw err;
      }
      if (attempt < opts.maxRetries) {
        console.log(`Network error: ${message}. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= opts.backoffFactor;
        continue;
      }
      throw err;
    }
  }

  throw new RetryError(`Failed after ${opts.maxRetries} retries`, lastError);
}
