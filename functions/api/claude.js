
export async function onRequestPost({ request, env }) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "AI service is not configured." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  if (!Array.isArray(body.messages)) {
    return json({ error: "Messages are required." }, 400);
  }

  const messages = body.messages
    .filter(item =>
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string"
    )
    .slice(-20)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 4000)
    }));

  if (
    !messages.length ||
    messages[messages.length - 1].role !== "user"
  ) {
    return json({ error: "Invalid conversation." }, 400);
  }

  try {
    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.ANTHROPIC_API_KEY}`,
          "anthropic-version": "2026-10-21"
        },
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          max_tokens: 700,
          system: "You are the helpful ShopHub assistant. Help visitors understand digital products, ebooks, planners, and templates. Be friendly, concise, and honest. Do not invent product details.",
          messages
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return json({ error: "AI provider request failed." }, 502);
    }

    const reply = Array.isArray(data.content)
      ? data.content
          .filter(block => block.type === "text")
          .map(block => block.text)
          .join("\n")
          .trim()
      : "";

    if (!reply) {
      return json({ error: "Empty AI response." }, 502);
    }

    return json({ reply });
  } catch {
    return json({ error: "AI service unavailable." }, 502);
  }
}
