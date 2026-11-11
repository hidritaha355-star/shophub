
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INCOMING_MESSAGES = 100;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TOTAL_LENGTH = 10000;

const MAX_REQUESTS = 8;
const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 5000;

const requestBuckets = new Map<
  string,
  { count: number; resetAt: number }
>();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readBoundedBody(req: Request): Promise<string | null> {
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();

  for (const [key, bucket] of requestBuckets) {
    if (bucket.resetAt <= now) {
      requestBuckets.delete(key);
    }
  }

  const existing = requestBuckets.get(clientIp);

  if (existing && existing.count >= MAX_REQUESTS) {
    return false;
  }

  if (!existing) {
    if (requestBuckets.size >= MAX_TRACKED_CLIENTS) {
      const oldestKey = requestBuckets.keys().next().value;
      if (oldestKey) requestBuckets.delete(oldestKey);
    }

    requestBuckets.set(clientIp, {
      count: 1,
      resetAt: now + WINDOW_MS,
    });
  } else {
    existing.count++;
  }

  return true;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const contentType = req.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse({ error: "JSON content type required." }, 415);
  }

  const clientIp =
    req.headers.get("x-nf-client-connection-ip") || "unknown-client";

  if (!checkRateLimit(clientIp)) {
    return jsonResponse(
      { error: "Too many requests. Please try again shortly." },
      429
    );
  }

  try {
    const contentLength = req.headers.get("content-length");

    if (contentLength !== null) {
      const declaredLength = Number(contentLength);

      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > MAX_BODY_BYTES
      ) {
        return jsonResponse({ error: "Request is too large." }, 413);
      }
    }

    const rawBody = await readBoundedBody(req);

    if (rawBody === null) {
      return jsonResponse({ error: "Request is too large." }, 413);
    }

    let body: unknown;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON." }, 400);
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("messages" in body)
    ) {
      return jsonResponse({ error: "Invalid request data." }, 400);
    }

    const incoming = (body as { messages?: unknown }).messages;

    if (
      !Array.isArray(incoming) ||
      incoming.length === 0 ||
      incoming.length > MAX_INCOMING_MESSAGES
    ) {
      return jsonResponse({ error: "Invalid message list." }, 400);
    }

    const startIndex = Math.max(0, incoming.length - MAX_MESSAGES);
    const selectedMessages = incoming.slice(startIndex);

    const messages: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];

    let totalLength = 0;

    for (let index = 0; index < selectedMessages.length; index++) {
      const item = selectedMessages[index];
      const originalIndex = startIndex + index;

      if (
        typeof item !== "object" ||
        item === null ||
        !("role" in item) ||
        !("content" in item)
      ) {
        return jsonResponse({ error: "Invalid message format." }, 400);
      }

      const message = item as {
        role: unknown;
        content: unknown;
      };

      if (
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" ||
        message.content.trim().length === 0 ||
        message.content.length > MAX_MESSAGE_LENGTH
      ) {
        return jsonResponse({ error: "Invalid message format." }, 400);
      }

      const expectedRole =
        originalIndex % 2 === 0 ? "user" : "assistant";

      if (message.role !== expectedRole) {
        return jsonResponse({ error: "Invalid message order." }, 400);
      }

      totalLength += message.content.length;

      if (totalLength > MAX_TOTAL_LENGTH) {
        return jsonResponse({ error: "Conversation is too long." }, 400);
      }

      messages.push({
        role: message.role,
        content: message.content,
      });
    }

    if (messages[messages.length - 1].role !== "user") {
      return jsonResponse(
        { error: "The last message must be from the user." },
        400
      );
    }

    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY is missing.");
      return jsonResponse({ error: "AI service is not configured." }, 500);
    }

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2026-10-21",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          max_tokens: 700,
          system:
            "You are the friendly AI assistant for ShopHub, a digital products store. Reply in the visitor's language. Help visitors understand the store and its categories. The product catalog, prices, stock, and checkout are not yet active. Never invent products, prices, availability, or claim a purchase was completed. Be helpful, clear, and concise.",
          messages,
        }),
      }
    );

    let result: any;

    try {
      result = await response.json();
    } catch {
      console.error("Anthropic returned an invalid response.");
      return jsonResponse(
        { error: "The AI service could not respond." },
        502
      );
    }

    if (!response.ok) {
      console.error("Anthropic API request failed:", response.status);
      return jsonResponse(
        { error: "The AI service could not respond." },
        502
      );
    }

    const reply = Array.isArray(result?.content)
      ? result.content
          .filter(
            (item: any) =>
              item &&
              item.type === "text" &&
              typeof item.text === "string"
          )
          .map((item: any) => item.text)
          .join("\n")
      : "";

    return jsonResponse({
      reply: reply || "Please try again.",
    });
  } catch (error) {
    console.error("ShopHub function error:", error);

    return jsonResponse(
      { error: "Something went wrong. Please try again." },
      500
    );
  }
};
