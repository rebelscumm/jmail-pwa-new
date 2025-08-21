// Minimal subset of Luxon typings used in this project
declare module 'luxon' {
  export class DateTime {
    static now(): DateTime;
    static fromJSDate(d: Date): DateTime;
    // selected readonly fields used by the app
    readonly minute: number;
    readonly second: number;
    set(values: Partial<{ hour: number; minute: number; second: number; millisecond: number }>): DateTime;
    setZone(zone: string): DateTime;
    toUTC(): DateTime;
    toMillis(): number;
    plus(values: Partial<{ minutes: number; hours: number; days: number }>): DateTime;
    startOf(unit: string): DateTime;
    toJSDate(): Date;
  }
}

