export type EmbeddingBatchOutputLine = {
  custom_id?: string;
  error?: { message?: string };
  response?: {
    status_code?: number;
    body?:
      | {
          data?: Array<{
            embedding?: number[];
          }>;
          usage?: { prompt_tokens?: number; total_tokens?: number };
          error?: { message?: string };
        }
      | string;
  };
};

export function applyEmbeddingBatchOutputLine(params: {
  line: EmbeddingBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
  /** PLAN-50: accumulates provider-reported tokens across the batch output. */
  tokens?: { total: number };
}) {
  const customId = params.line.custom_id;
  if (!customId) {
    return;
  }
  params.remaining.delete(customId);

  const errorMessage = params.line.error?.message;
  if (errorMessage) {
    params.errors.push(`${customId}: ${errorMessage}`);
    return;
  }

  const response = params.line.response;
  const statusCode = response?.status_code ?? 0;
  if (statusCode >= 400) {
    const messageFromObject =
      response?.body && typeof response.body === "object"
        ? (response.body as { error?: { message?: string } }).error?.message
        : undefined;
    const messageFromString = typeof response?.body === "string" ? response.body : undefined;
    params.errors.push(`${customId}: ${messageFromObject ?? messageFromString ?? "unknown error"}`);
    return;
  }

  if (params.tokens && response?.body && typeof response.body === "object") {
    const usage = response.body.usage;
    const reported = usage?.total_tokens ?? usage?.prompt_tokens;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      params.tokens.total += reported;
    }
  }
  const data =
    response?.body && typeof response.body === "object" ? (response.body.data ?? []) : [];
  const embedding = data[0]?.embedding ?? [];
  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}

/**
 * PLAN-50: best-effort text of a batch request for token estimation when the provider's
 * output carries no usage. Collects every string under an `input`, `text` or `content` key.
 */
export function extractBatchRequestText(request: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (
          key === "input" ||
          key === "text" ||
          key === "content" ||
          key === "parts" ||
          key === "body" ||
          key === "request"
        ) {
          visit(item, depth + 1);
        }
      }
    }
  };
  visit(request, 0);
  return parts.join(" ");
}
