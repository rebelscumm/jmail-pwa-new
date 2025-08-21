import type { SnoozeRule } from '$lib/types';
import { DateTime } from 'luxon';

export const DEFAULTS = { anchorHour: 5, roundMinutes: 5 };

function roundUp(dt: DateTime, minutes: number) {
  const mod = dt.minute % minutes;
  const add = mod === 0 && dt.second === 0 ? 0 : minutes - mod;
  return dt.plus({ minutes: add }).startOf('minute');
}

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

function normalizeRuleKey(ruleKey: string): string {
  const k = ruleKey.trim();
  // Normalize common aliases/cases
  const lower = k.toLowerCase();
  if (lower === 'zz-1hour' || lower === '1hour' || lower === '1 hr' || lower === '1 h') return '1h';
  if (lower === 'zz-2hour' || lower === '2hour' || lower === '2 hr' || lower === '2 h' || lower === 'zz-2hour') return '2h';
  if (lower === '3hour' || lower === '3 hr' || lower === '3 h' || lower === '3hour') return '3h';
  if (/^\d{2}\sday(s)?$/i.test(k)) {
    const num = parseInt(k.slice(0, 2), 10);
    return `${num}d`;
  }
  if (/^day\d+$/i.test(k)) return `${k.slice(3)}d`;
  if (/^zday\d+$/i.test(k)) return `${k.slice(4)}d`;
  return k;
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

