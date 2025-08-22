import type { SnoozeRule } from '$lib/types';
import { DateTime } from 'luxon';

export const DEFAULTS = { anchorHour: 5, roundMinutes: 5 };

function roundUp(dt: DateTime, minutes: number) {
  const mod = dt.minute % minutes;
  const add = mod === 0 && dt.second === 0 ? 0 : minutes - mod;
  return dt.plus({ minutes: add }).startOf('minute');
}

// Keep rules for previewing times in the SnoozePanel; actual scheduling is label-driven externally
export const rules: Record<string, SnoozeRule> = {
  '10m': {
    labelName: '10m',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ minutes: 10 }).toJSDate()
  },
  '30m': {
    labelName: '30m',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ minutes: 30 }).toJSDate()
  },
  '3h': {
    labelName: '3h',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ hours: 3 }).toJSDate()
  },
  '1h': {
    labelName: '1h',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ hours: 1 }).toJSDate()
  },
  '2h': {
    labelName: '2h',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ hours: 2 }).toJSDate()
  },
  '1d': {
    labelName: '1d',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      const candidate = dt.plus({ days: 1 }).set({ hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 });
      return candidate.toJSDate();
    }
  },
  '2d': { labelName: '2d', resolver: (n, d) => DateTime.fromJSDate(n).plus({ days: 2 }).set({ hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 }).toJSDate() },
  '3d': { labelName: '3d', resolver: (n, d) => DateTime.fromJSDate(n).plus({ days: 3 }).set({ hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 }).toJSDate() },
  '7d': { labelName: '7d', resolver: (n, d) => DateTime.fromJSDate(n).plus({ days: 7 }).set({ hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 }).toJSDate() },
  '6am': {
    labelName: '6am',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ hour: 6, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ days: 1 });
      return candidate.toJSDate();
    }
  },
  '2pm': {
    labelName: '2pm',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ days: 1 });
      return candidate.toJSDate();
    }
  },
  '7pm': {
    labelName: '7pm',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ days: 1 });
      return candidate.toJSDate();
    }
  },
  Monday: {
    labelName: 'Monday',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ weekday: 1, hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ weeks: 1 });
      return candidate.toJSDate();
    }
  },
  Friday: {
    labelName: 'Friday',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ weekday: 5, hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ weeks: 1 });
      return candidate.toJSDate();
    }
  },
  Desktop: { labelName: 'Desktop', resolver: () => null, persistent: true },
  'long-term': { labelName: 'long-term', resolver: () => null, persistent: true }
};

export function normalizeRuleKey(ruleKey: string): string {
  // Work on the leaf segment only (support nested labels like "Snooze/01 day" or "?jlmSnooze/zz-2Hour")
  const kFull = ruleKey.trim();
  const leaf = (kFull.split('/').pop() || kFull).trim();
  // Normalize common aliases/cases against the leaf
  const lower = leaf.toLowerCase();
  // Weekdays (accept full or short names, any case)
  const weekdayMap: Record<string, string> = {
    mon: 'Monday', monday: 'Monday',
    tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
    wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
    thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
    fri: 'Friday', friday: 'Friday',
    sat: 'Saturday', saturday: 'Saturday',
    sun: 'Sunday', sunday: 'Sunday'
  };
  if (weekdayMap[lower as keyof typeof weekdayMap]) return weekdayMap[lower as keyof typeof weekdayMap];

  // Specific times supported by the app: 6am, 2pm, 7pm
  // Accept formats like "6am", "6 am", "06:00", "6:00", "2pm", "2 pm", "14:00", "19:00"
  // am/pm variants
  const ampm = lower.match(/^(\d{1,2})\s?(a|p)\s?m$/);
  if (ampm) {
    const hour = parseInt(ampm[1], 10);
    const ap = ampm[2];
    if (ap === 'a' && hour === 6) return '6am';
    if (ap === 'p' && hour === 2) return '2pm';
    if (ap === 'p' && hour === 7) return '7pm';
  }
  // 24h or hh:mm formats
  const time24 = lower.match(/^(\d{1,2})(?::([0-5]\d))?$/);
  if (time24) {
    const hour = parseInt(time24[1], 10);
    const minutes = time24[2] ? parseInt(time24[2], 10) : 0;
    if (minutes === 0) {
      if (hour === 6) return '6am';
      if (hour === 14) return '2pm';
      if (hour === 19) return '7pm';
    }
  }
  const time24Colon = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (time24Colon) {
    const hour = parseInt(time24Colon[1], 10);
    const minutes = parseInt(time24Colon[2], 10);
    if (minutes === 0) {
      if (hour === 6) return '6am';
      if (hour === 14) return '2pm';
      if (hour === 19) return '7pm';
    }
  }
  // Desktop / long-term variants
  if (lower === 'desktop') return 'Desktop';
  if (lower === 'long-term' || lower === 'long term' || lower === 'longterm') return 'long-term';
  // Hours formats (support: 1hour, 01-hour, 1-hour, hour1, hour01, hour-01, plurals)
  const hourMatch = lower.match(/^(?:zz-)?(?:(\d{1,2})\s?-?\s?hour(?:s)?|hour-?(\d{1,2}))$/);
  if (hourMatch) {
    const n = parseInt(hourMatch[1] || hourMatch[2] || '0', 10);
    if (!Number.isNaN(n) && n > 0) return `${n}h`;
  }
  // Existing short aliases
  if (lower === 'zz-1hour' || lower === '1hour' || lower === '1 hr' || lower === '1 h') return '1h';
  if (lower === 'zz-2hour' || lower === '2hour' || lower === '2 hr' || lower === '2 h') return '2h';
  if (lower === '3hour' || lower === '3 hr' || lower === '3 h') return '3h';

  // Day formats like "01 day", "02 days", "9 days"
  if (/^\d{1,2}\sday(s)?$/i.test(leaf)) {
    const num = parseInt(leaf.slice(0, 2), 10);
    return `${num}d`;
  }
  // dayN, zdayN → Nd
  if (/^day\d+$/i.test(leaf)) return `${leaf.slice(3)}d`;
  if (/^zday\d+$/i.test(leaf)) return `${leaf.slice(4)}d`;
  // "0N days" where N is single digit
  if (/^0\d\sday(s)?$/i.test(leaf)) {
    const num = parseInt(leaf.slice(0, 2), 10);
    return `${num}d`;
  }
  // "\d+ days" without leading zero
  const daysMatch = lower.match(/^(\d{1,2})\s?day(?:s)?$/);
  if (daysMatch) return `${parseInt(daysMatch[1], 10)}d`;
  return leaf;
}

export function resolveRule(ruleKey: string, zone: string, defaults = DEFAULTS): Date | null {
  const key = normalizeRuleKey(ruleKey);
  if (/^(\d+)d$/.test(key)) {
    const days = Number(key.slice(0, -1));
    const dt = DateTime.now().setZone(zone).plus({ days }).set({ hour: defaults.anchorHour, minute: 0, second: 0, millisecond: 0 });
    const candidate = dt.toJSDate();
    const now = DateTime.now().setZone(zone).toJSDate();
    const candDt = DateTime.fromJSDate(candidate).setZone(zone);
    const nowDt = DateTime.fromJSDate(now).setZone(zone);
    return candDt <= nowDt ? nowDt.plus({ minutes: 1 }).toJSDate() : candDt.toJSDate();
  }
  const r = rules[key];
  if (!r) return null;
  const now = DateTime.now().setZone(zone).toJSDate();
  const result = r.resolver(now, defaults);
  if (!result) return null;
  const dt = DateTime.fromJSDate(result).setZone(zone);
  const nowDt = DateTime.fromJSDate(now).setZone(zone);
  return dt <= nowDt ? nowDt.plus({ minutes: 1 }).toJSDate() : dt.toJSDate();
}

