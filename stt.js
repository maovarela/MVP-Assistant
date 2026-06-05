// stt.js
// Speech-to-text for Telegram voice notes. Uses an OpenAI-compatible
// /audio/transcriptions endpoint (Whisper). Configure with:
//   STT_API_KEY   — required to enable voice notes
//   STT_BASE_URL  — e.g. https://api.groq.com/openai/v1 (Groq Whisper, accepts ogg)
//   STT_MODEL     — default "whisper-large-v3"
//
// We keep this separate from llm.js because the chat providers (Gemini via the
// OpenAI-compat shim) don't reliably expose a transcription endpoint, and
// Telegram voice is OGG/Opus — Whisper backends (OpenAI, Groq) accept it directly.

import OpenAI, { toFile } from "openai";

export function isSttConfigured() {
  return Boolean(process.env.STT_API_KEY);
}

/**
 * Transcribe an audio buffer to text. Throws a clear error if STT isn't
 * configured so the caller can tell the user to type instead.
 */
export async function transcribeAudio(buffer, { filename = "voice.ogg" } = {}) {
  if (!process.env.STT_API_KEY) {
    throw new Error("voice transcription not configured (set STT_API_KEY — e.g. a Groq key with STT_BASE_URL=https://api.groq.com/openai/v1)");
  }
  const client = new OpenAI({
    apiKey:  process.env.STT_API_KEY,
    baseURL: process.env.STT_BASE_URL || undefined,
  });
  const file = await toFile(buffer, filename);
  const resp = await client.audio.transcriptions.create({
    file,
    model: process.env.STT_MODEL || "whisper-large-v3",
  });
  return (resp.text || "").trim();
}
