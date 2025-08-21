import { get } from 'svelte/store';
import { settings } from '$lib/stores/settings';
import { redactPII, htmlToText } from './redact';

export type AIResult = { text: string };

async function callOpenAI(prompt: string): Promise<AIResult> {
  const s = get(settings);
  const key = s.aiApiKey || '';
  const model = s.aiModel || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 })
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim?.() || '';
  return { text };
}

async function callAnthropic(prompt: string): Promise<AIResult> {
  const s = get(settings);
  const key = s.aiApiKey || '';
  const model = s.aiModel || 'claude-3-haiku-20240307';
  const url = 'https://api.anthropic.com/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim?.() || '';
  return { text };
}

async function callGemini(prompt: string): Promise<AIResult> {
  const s = get(settings);
  const key = s.aiApiKey || '';
  const model = s.aiModel || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim?.() || '';
  return { text };
}

export async function aiSummarizeEmail(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `You are a concise assistant. Provide a short bullet list of the most important points in this email, most important first. Keep it under 6 bullets.\n\nEmail:\n${redacted}`;
  const provider = s.aiProvider || 'openai';
  const out = provider === 'anthropic' ? await callAnthropic(prompt) : provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
  return out.text;
}

export async function aiDraftReply(subject: string, bodyText?: string, bodyHtml?: string): Promise<string> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `Write a brief, polite email reply. Keep it under 120 words.\nSubject: ${subject}\nEmail:\n${redacted}`;
  const provider = s.aiProvider || 'openai';
  const out = provider === 'anthropic' ? await callAnthropic(prompt) : provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
  return out.text;
}

export function findUnsubscribeTarget(headers?: Record<string,string>, html?: string): string | null {
  const listUnsub = headers?.['List-Unsubscribe'] || headers?.['List-Unsubscribe-Post'];
  if (listUnsub) {
    const matches = listUnsub.match(/<([^>]+)>/g) || [];
    for (const m of matches) {
      const url = m.slice(1,-1);
      if (url.startsWith('http')) return url;
      if (url.startsWith('mailto:')) return url;
    }
  }
  if (html) {
    const m = html.match(/href\s*=\s*"(https?:[^"']*unsubscribe[^"']*)"/i);
    if (m) return m[1];
  }
  return null;
}

export async function aiExtractUnsubscribeUrl(subject: string, bodyText?: string, bodyHtml?: string): Promise<string | null> {
  const s = get(settings);
  const text = bodyText || htmlToText(bodyHtml) || '';
  const redacted = redactPII(`${subject}\n\n${text}`);
  const prompt = `From the following email content, extract a single unsubscribe URL or mailto link if present. Respond with ONLY the URL, nothing else. If none is present, respond with "NONE".\n\n${redacted}`;
  const provider = s.aiProvider || 'openai';
  const out = provider === 'anthropic' ? await callAnthropic(prompt) : provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
  const line = (out.text || '').trim();
  if (!line || /^none$/i.test(line)) return null;
  if (/^(https?:|mailto:)/i.test(line)) return line;
  const match = line.match(/(https?:[^\s]+|mailto:[^\s]+)/i);
  return match ? match[1] : null;
}


