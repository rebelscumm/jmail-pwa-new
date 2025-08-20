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
  '3h': {
    labelName: '3h',
    resolver: (nowLocal, d) => roundUp(DateTime.fromJSDate(nowLocal), d.roundMinutes).plus({ hours: 3 }).toJSDate()
  },
  '1d': {
    labelName: '1d',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      const candidate = dt.plus({ days: 1 }).set({ hour: d.anchorHour, minute: 0, second: 0, millisecond: 0 });
      return candidate.toJSDate();
    }
  },
  '6am': {
    labelName: '6am',
    resolver: (nowLocal, d) => {
      const dt = DateTime.fromJSDate(nowLocal);
      let candidate = dt.set({ hour: 6, minute: 0, second: 0, millisecond: 0 });
      if (candidate <= dt) candidate = candidate.plus({ days: 1 });
      return candidate.toJSDate();
    }
  }
};

export function resolveRule(ruleKey: string, zone: string, defaults = DEFAULTS): Date | null {
  const r = rules[ruleKey];
  if (!r) return null;
  const now = DateTime.now().setZone(zone).toJSDate();
  const result = r.resolver(now, defaults);
  if (!result) return null;
  const dt = DateTime.fromJSDate(result).setZone(zone);
  const nowDt = DateTime.fromJSDate(now).setZone(zone);
  return dt <= nowDt ? nowDt.plus({ minutes: 1 }).toJSDate() : dt.toJSDate();
}

