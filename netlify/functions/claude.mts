
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUESTS = 8;
const WINDOW_MS = 60_000;

const requestBuckets = new Map<string, { count: number; resetAt: number }>();

export default async (req: Request): Promise<Response> => {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!req.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "JSON content type required." }, 415);
  }

  const clientIp =
    req.headers.get("x-nf-client-connection-ip") || "unknown-client";

  const now = Date.now();

  for (const [key, bucket] of requestBuckets) {
    if (bucket.resetAt <= now) requestBuckets.delete(key);
  }

  const bucket = requestBuckets.get(clientIp);

  if (bucket && bucket.resetAt > now && bucket.count >= MAX_REQUESTS) {
    return json({ error: "Too many requests. Please try again shortly." }, 429);
  }

  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(clientIp, {
      count: 1,
      resetAt: now + WINDOW_MS,
    });
  } else {
    bucket.count++;
  }

  try {
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

    if (!apiKey) {
      return json({ error: "AI service is not configured." }, 500);
    }

    const contentLength = Number(req.headers.get("content-length") || 0);

    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request is too large." }, 413);
    }

    const rawBody = await req.text();

    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return json({ error: "Request is too large." }, 413);
    }

    let body: any;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }

    const incoming = body?.messages;

    if (
      !Array.isArray(incoming) ||
      incoming.length === 0 ||
    ) {
      return json({ error: "Invalid message list." }, 400);
    }

    let totalLength = 0;

    const messages = incoming.slice(-20).map((item: any, index: number) => {
      if (
        !item ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        item.content.trim().length === 0 ||
        item.content.length > 2000
      ) {
        throw new Error("Invalid message format");
      }

      totalLength += item.content.length;

      if (totalLength > 10000) {
        throw new Error("Conversation is too long");
      }

      const expectedRole = index % 2 === 0 ? "user" : "assistant";

      if (item.role !== expectedRole) {
        throw new Error("Invalid message order");
      }

      return {
        role: item.role,
        content: item.content,
      };
    });

    if (messages[messages.length - 1].role !== "user") {
      return json({ error: "The last message must be from the user." }, 400);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Anthropic API error:", result);
      return json({ error: "The AI service could not respond." }, 502);
    }

    const reply = (result.content || [])
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");

    return json({ reply: reply || "Please try again." });
  } catch (error) {
    console.error("ShopHub function error:", error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};
