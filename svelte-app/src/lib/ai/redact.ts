export function redactPII(input: string): string {
  let out = input;
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  out = out.replace(/\b\+?\d[\d\s().-]{7,}\b/g, '[PHONE]');
  out = out.replace(/\b(?:[A-F0-9]{8}-){3,}[A-F0-9]{4}\b/gi, '[ID]');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '[TOKEN]');
  return out;
}

export function htmlToText(html?: string): string | undefined {
  if (!html) return undefined;
  try {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || undefined;
  } catch {
    return html.replace(/<[^>]*>/g, '');
  }
}


