// Pai — Cloudflare Worker backend
//
// REQUIRED Cloudflare secrets/bindings for full functionality:
//   GROQ_API_KEY      (required — chat won't work at all without this)
//   RESEND_API_KEY    (optional — feedback emailing; without it /feedback returns a clear error)
//   BRAVE_API_KEY     (optional — web search; without it webSearch requests fall back to "not configured")
//   TOGETHER_API_KEY  (optional — image generation; without it /generate-image returns a clear error)
//   MEMORY_KV         (optional — a Cloudflare KV namespace binding; without it /memory returns "not configured")
//
// Every optional feature degrades gracefully with a real error message instead of pretending to work.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ABOUT_URL = "https://lazyptx2.github.io/pai/";
const FEEDBACK_TO_EMAIL = "claymix034@gmail.com";
const FEEDBACK_FROM_EMAIL = "pai-feedback@resend.dev"; // Resend's shared test sender — works without domain verification. Swap once you verify your own domain in Resend.

const MODEL_FREE = "llama-3.1-8b-instant";
const MODEL_PAID = "llama-3.3-70b-versatile";
const MODEL_VISION = "meta-llama/llama-4-scout-17b-16e-instruct"; // Groq's vision-capable model at time of writing — check Groq's current model list if this errors, model names change.

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function getAboutInfo() {
  const cache = caches.default;
  const cacheKey = new Request(ABOUT_URL);
  try {
    let cached = await cache.match(cacheKey);
    if (cached) return await cached.text();
    const res = await fetch(ABOUT_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return "";
    const html = await res.text();
    const text = stripHtml(html).slice(0, 3000);
    const toCache = new Response(text, { headers: { "Cache-Control": "max-age=3600" } });
    await cache.put(cacheKey, toCache.clone());
    return text;
  } catch (e) {
    return "";
  }
}

function lengthInstruction(length) {
  if (length === "concise" || length === "small") {
    return "Keep your reply short — a sentence or two, like a quick friendly text. Don't over-explain.";
  }
  if (length === "detailed" || length === "large") {
    return "Give a thorough, well-explained reply with useful detail and examples where helpful.";
  }
  return "Keep your reply a moderate length — a few friendly sentences, clear and not too short or too long.";
}

function buildSystemPrompt({ aboutInfo, length, language, fileContext, searchContext, memoryContext }) {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  let prompt =
    "You are Pai, a warm and friendly AI chat assistant created by ptx2. " +
    "Always stay in character as Pai — never say you are made by Anthropic, OpenAI, Groq, or anyone else; " +
    "your creator is ptx2. " +
    `Today's real date is ${todayStr} (UTC) — always use this exact date if asked what today's date is, or for any date/time math. Never guess or make up a date. ` +
    "You MUST use emojis in every single reply, no exceptions — sprinkle 1-4 relevant emojis naturally through " +
    "your response (not just one at the very end) to keep things warm and expressive 😊✨. Be upbeat, encouraging, " +
    "and genuinely friendly in tone at all times, like chatting with a supportive friend — never cold, robotic, or overly formal. " +
    "Use casual, conversational language: contractions (you're, that's, let's), enthusiasm, and a warm greeting energy — " +
    "avoid stiff textbook phrasing like 'I am pleased to inform you' or 'Certainly, here is the information you requested.' " +
    "Instead sound like: 'Hey! Great question 😊 so here's the deal...' or 'Oh nice, I can totally help with that! 🙌'. " +
    "You are fully capable of writing and explaining code in any language when asked, just like a professional coding assistant — " +
    "don't hold back on that. You can also share relevant links and URLs (e.g. if someone asks for a GitHub link, product page, " +
    "or documentation) as normal markdown links when you're confident they're correct — if you're not sure a specific URL is real, " +
    "say so rather than guessing. " +
    lengthInstruction(length);

  if (language && language !== "English") {
    prompt += ` The user has set their language to ${language} in Settings. You MUST always reply in ${language}, for every message, no matter what language they type in — do not switch to any other language even if they write in English or another language.`;
  } else {
    prompt += " Detect the language the user is writing in and reply in that same language, even if it changes mid-conversation.";
  }

  if (aboutInfo) {
    prompt += "\n\nBackground information about the user you're talking to — draw on it naturally if relevant, don't recite it verbatim or bring it up unprompted:\n" + aboutInfo;
  }
  if (memoryContext) {
    prompt += "\n\nThings you remember from earlier conversations with this specific user — use naturally if relevant, don't recite verbatim:\n" + memoryContext;
  }
  if (fileContext) {
    prompt += `\n\nThe user has attached a file named "${fileContext.name}". Its contents:\n${fileContext.content}`;
  }
  if (searchContext) {
    prompt += "\n\nYou ran a live web search for this message. Use these results to inform your answer, and mention that you searched the web. Results:\n" + searchContext;
  }

  return prompt;
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return { response: jsonResponse({ error: "Invalid JSON in request body" }, 400), memoryPromise: null };
  }
  const { message, length, plan, language, image, file, webSearch, uid } = body || {};

  if (!message || typeof message !== "string") {
    return { response: jsonResponse({ error: "Request must include a 'message' string" }, 400), memoryPromise: null };
  }
  if (!env.GROQ_API_KEY) {
    return { response: jsonResponse({ error: "Server is missing GROQ_API_KEY" }, 500), memoryPromise: null };
  }

  // NOTE: plan is reported by the client, not cryptographically verified — see chat notes
  // on why real entitlement enforcement needs a server-side account system.
  const isPaid = plan === "pro" || plan === "max";

  let sources = [];
  let searchContext = "";
  if (webSearch) {
    if (!env.BRAVE_API_KEY) {
      searchContext = "(Web search was requested but isn't configured on the server yet — BRAVE_API_KEY secret is missing. Answer from your own knowledge and clearly tell the user web search isn't set up yet.)";
    } else {
      try {
        const searchRes = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(message)}&count=5`, {
          headers: { "Accept": "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
        });
        const searchData = await searchRes.json();
        const results = (searchData && searchData.web && searchData.web.results) || [];
        sources = results.slice(0, 5).map(r => ({ title: r.title, url: r.url }));
        searchContext = results.slice(0, 5).map(r => `- ${r.title}: ${r.description || ""} (${r.url})`).join("\n");
      } catch (e) {
        searchContext = "(Web search failed due to a server error — answer from your own knowledge and mention search wasn't available.)";
      }
    }
  }

  let memoryContext = "";
  if (uid && env.MEMORY_KV) {
    try {
      memoryContext = (await env.MEMORY_KV.get(`mem:${uid}`)) || "";
    } catch (e) { /* memory is best-effort */ }
  }

  let fileContext = null;
  if (file && typeof file.content === "string") {
    fileContext = { name: file.name || "attached file", content: file.content.slice(0, 12000) };
  }

  const aboutInfo = await getAboutInfo();
  const systemPrompt = buildSystemPrompt({ aboutInfo, length, language, fileContext, searchContext, memoryContext });

  let model = isPaid ? MODEL_PAID : MODEL_FREE;
  let userContent = message;

  if (image && image.base64 && image.mediaType) {
    model = MODEL_VISION;
    userContent = [
      { type: "text", text: message || "What's in this image?" },
      { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
    ];
  }

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });

    const data = await groqResponse.json();
    if (!groqResponse.ok) {
      const errText = (data && data.error && data.error.message) || `Groq request failed (${groqResponse.status})`;
      return { response: jsonResponse({ error: errText }, groqResponse.status), memoryPromise: null };
    }

    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    if (!reply) return { response: jsonResponse({ error: "Groq returned an empty response" }, 502), memoryPromise: null };

    // Fire-and-forget memory update: ask the model for a short updated memory summary,
    // merging what's already remembered with this exchange. Doesn't block the reply.
    let memoryPromise = null;
    if (uid && env.MEMORY_KV) {
      memoryPromise = (async () => {
        try {
          const memPrompt =
            "Update this user's memory summary given the new exchange below. Keep it under 500 words, plain text, " +
            "just durable facts/preferences worth remembering long-term (name, interests, ongoing projects, preferences) — not small talk. " +
            "If nothing new and durable was said, return the existing summary unchanged.\n\n" +
            `Existing memory:\n${memoryContext || "(none yet)"}\n\n` +
            `New exchange:\nUser: ${message}\nPai: ${reply}`;
          const memRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GROQ_API_KEY}` },
            body: JSON.stringify({
              model: MODEL_FREE,
              max_tokens: 600,
              messages: [{ role: "user", content: memPrompt }],
            }),
          });
          const memData = await memRes.json();
          const newMemory = memData.choices && memData.choices[0] && memData.choices[0].message && memData.choices[0].message.content;
          if (newMemory) await env.MEMORY_KV.put(`mem:${uid}`, newMemory.slice(0, 4000));
        } catch (e) { /* memory update is best-effort, never fails the main reply */ }
      })();
    }

    const responseBody = { reply };
    if (sources.length) responseBody.sources = sources;
    return { response: jsonResponse(responseBody), memoryPromise };
  } catch (err) {
    return { response: jsonResponse({ error: err && err.message ? err.message : "Unexpected server error" }, 500), memoryPromise: null };
  }
}

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON in request body" }, 400);
  }
  const { message, from } = body || {};
  if (!message || typeof message !== "string") {
    return jsonResponse({ error: "Feedback message is required" }, 400);
  }
  if (!env.RESEND_API_KEY) {
    return jsonResponse({ error: "Feedback emailing isn't configured yet on the server (missing RESEND_API_KEY secret)." }, 500);
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: FEEDBACK_FROM_EMAIL,
        to: FEEDBACK_TO_EMAIL,
        subject: `Pai feedback from ${from || "a user"}`,
        text: message,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: (data && data.message) || "Resend rejected the email" }, res.status);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err && err.message ? err.message : "Could not send feedback email" }, 500);
  }
}

async function handleMemory(request, env, url) {
  const uid = url.searchParams.get("uid");
  if (!uid) return jsonResponse({ error: "Missing uid parameter" }, 400);
  if (!env.MEMORY_KV) {
    return jsonResponse({ error: "Memory storage isn't configured yet on the server (missing MEMORY_KV namespace binding)." }, 500);
  }
  try {
    if (request.method === "GET") {
      const memory = (await env.MEMORY_KV.get(`mem:${uid}`)) || "";
      return jsonResponse({ memory });
    }
    if (request.method === "DELETE") {
      await env.MEMORY_KV.delete(`mem:${uid}`);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (err) {
    return jsonResponse({ error: err && err.message ? err.message : "Memory storage error" }, 500);
  }
}

async function handleGenerateImage(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON in request body" }, 400);
  }
  const { prompt } = body || {};
  if (!prompt || typeof prompt !== "string") {
    return jsonResponse({ error: "An image 'prompt' string is required" }, 400);
  }
  if (!env.TOGETHER_API_KEY) {
    return jsonResponse({ error: "Image generation isn't configured yet on the server (missing TOGETHER_API_KEY secret)." }, 500);
  }
  try {
    const res = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.TOGETHER_API_KEY}` },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width: 1024,
        height: 1024,
        steps: 4,
        n: 1,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: (data && data.error && data.error.message) || `Image generation failed (${res.status})` }, res.status);
    }
    const imageUrl = data.data && data.data[0] && (data.data[0].url || data.data[0].b64_json);
    if (!imageUrl) return jsonResponse({ error: "Image generation returned no image" }, 502);
    return jsonResponse({ imageUrl: data.data[0].url || null, imageBase64: data.data[0].b64_json || null });
  } catch (err) {
    return jsonResponse({ error: err && err.message ? err.message : "Unexpected server error" }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/feedback" && request.method === "POST") {
      return handleFeedback(request, env);
    }
    if (url.pathname === "/memory" && (request.method === "GET" || request.method === "DELETE")) {
      return handleMemory(request, env, url);
    }
    if (url.pathname === "/generate-image" && request.method === "POST") {
      return handleGenerateImage(request, env);
    }

    if (request.method === "GET") {
      return new Response("API is running!", { status: 200, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const { response, memoryPromise } = await handleChat(request, env);
    if (memoryPromise) ctx.waitUntil(memoryPromise);
    return response;
  },
};
