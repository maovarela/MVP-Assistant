// llm.js
// LLM client with provider fallback chain — matches Runaldo's pattern.
//
// Reads provider config from env:
//   Primary    : LLM_API_KEY            / LLM_MODEL            / LLM_BASE_URL
//   Fallback 1 : LLM_FALLBACK_1_KEY     / LLM_FALLBACK_1_MODEL / LLM_FALLBACK_1_BASE_URL
//   Fallback 2 : LLM_FALLBACK_2_KEY     / LLM_FALLBACK_2_MODEL / LLM_FALLBACK_2_BASE_URL
//
// All providers must speak the OpenAI Chat Completions API (Gemini, Groq,
// DeepSeek, OpenAI, Together, etc. all work).

import OpenAI from "openai";
import { recordLlmCall } from "./memory.js";

// In-memory cooldown so we don't waste 1-3s per turn retrying providers that
// are consistently rate-limited. After a 429, the provider is skipped for
// COOLDOWN_MS — gives daily quotas a chance to reset, but doesn't pin the
// chain to a permanently-broken provider.
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const cooldownUntil = new Map();   // providerName -> epoch ms

function buildProviders() {
  const providers = [];

  if (process.env.LLM_API_KEY) {
    providers.push({
      name:     "primary",
      apiKey:   process.env.LLM_API_KEY,
      baseURL:  process.env.LLM_BASE_URL || undefined,
      model:    process.env.LLM_MODEL || "gemini-2.0-flash",
    });
  }

  for (const i of [1, 2]) {
    const key = process.env[`LLM_FALLBACK_${i}_KEY`];
    if (!key) continue;
    providers.push({
      name:     `fallback_${i}`,
      apiKey:   key,
      baseURL:  process.env[`LLM_FALLBACK_${i}_BASE_URL`] || undefined,
      model:    process.env[`LLM_FALLBACK_${i}_MODEL`] || "gpt-4o-mini",
    });
  }

  if (!providers.length) {
    throw new Error("No LLM provider configured. Set LLM_API_KEY at minimum.");
  }
  return providers;
}

let _providers = null;
export function getProviders() {
  if (!_providers) _providers = buildProviders();
  return _providers;
}

/**
 * Call the LLM chain. Returns the raw OpenAI ChatCompletion response from
 * the first provider that succeeds. Throws if all fail.
 *
 * opts: { messages, tools?, tool_choice?, max_tokens?, temperature?, model? }
 */
export async function callLLM(opts) {
  const { messages, tools, tool_choice, max_tokens = 2048, temperature = 0.7, providers } = opts;
  let lastError = null;

  // Optional filter — useful when a call needs a multimodal-capable provider
  // (PDF, audio) and we don't want to waste time/get confusing errors from
  // text-only fallbacks. Pass providers: ['primary'] to lock to Gemini.
  const candidates = providers
    ? getProviders().filter((p) => providers.includes(p.name))
    : getProviders();
  if (!candidates.length) {
    throw new Error(`No LLM provider matches filter ${JSON.stringify(providers)}`);
  }

  for (const p of candidates) {
    const cd = cooldownUntil.get(p.name);
    if (cd && Date.now() < cd) {
      const remaining = Math.ceil((cd - Date.now()) / 1000);
      console.log(`[llm] skipping ${p.name} (cooldown ${remaining}s)`);
      continue;
    }

    const model = opts.model || p.model;
    const start = Date.now();
    try {
      const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
      const params = { model, messages, max_tokens, temperature };
      if (tools)       params.tools = tools;
      if (tool_choice) params.tool_choice = tool_choice;

      console.log(`[llm] calling ${p.name} (${model})`);
      const response = await client.chat.completions.create(params);
      // Some "OpenAI-compatible" endpoints (notably OpenRouter free tiers)
      // return 200 OK with no choices array — usually rate limit / safety
      // filter / upstream timeout dressed as success. Treat as failure so
      // the next provider gets a turn instead of crashing the agent loop.
      if (!response?.choices?.[0]?.message) {
        const reason = response?.choices?.[0]?.finish_reason || "no choices in response";
        throw new Error(`malformed response from ${p.name}: ${reason}`);
      }
      const latency = Date.now() - start;
      const usage = response.usage || {};
      console.log(`[llm] ${p.name} ok — ${usage.total_tokens ?? "?"} tokens (${latency}ms)`);
      try {
        recordLlmCall({
          provider: p.name,
          model,
          prompt_tokens:     usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens:      usage.total_tokens,
          latency_ms:        latency,
          success:           true,
        });
      } catch (e) { console.warn(`[llm] recordLlmCall failed: ${e.message}`); }
      cooldownUntil.delete(p.name);
      return response;
    } catch (err) {
      const latency = Date.now() - start;
      console.warn(`[llm] ${p.name} failed: ${err.message}`);
      lastError = err;

      const status = err.status || err.statusCode;
      const rateLimited = status === 429 || /\b429\b|rate.?limit/i.test(err.message || "");
      if (rateLimited) {
        cooldownUntil.set(p.name, Date.now() + COOLDOWN_MS);
        console.log(`[llm] ${p.name} cooldown ${COOLDOWN_MS / 1000}s after 429`);
      }

      try {
        recordLlmCall({
          provider:   p.name,
          model,
          latency_ms: latency,
          success:    false,
          error:      (err.message || "unknown").slice(0, 500),
        });
      } catch (e) { console.warn(`[llm] recordLlmCall failed: ${e.message}`); }
    }
  }

  throw new Error(`All ${getProviders().length} LLM providers failed. Last: ${lastError?.message}`);
}

/**
 * Convenience: call LLM and return the assistant's text content directly
 * (no tool calls — for simple parsing tasks).
 */
export async function callLLMText(opts) {
  const response = await callLLM(opts);
  return response.choices[0]?.message?.content || "";
}
