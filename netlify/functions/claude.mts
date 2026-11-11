
export default async (req: Request): Promise<Response> => {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

    if (!apiKey) {
      return json({ error: "AI service is not configured." }, 500);
    }

    const body = await req.json();
    const incoming = body?.messages;

    if (!Array.isArray(incoming) || incoming.length === 0) {
      return json({ error: "Please send a message." }, 400);
    }

    const messages = incoming.slice(-20).map((item: any) => {
      if (
        !["user", "assistant"].includes(item?.role) ||
        typeof item?.content !== "string" ||
        item.content.length > 4000
      ) {
        throw new Error("Invalid message format");
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
