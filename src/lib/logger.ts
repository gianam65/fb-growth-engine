type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function makeLogger(minLevel: string) {
  const min = order[(minLevel as Level) ?? 'info'] ?? 1;
  const log = (lvl: Level, msg: string, data?: unknown) => {
    if (order[lvl] < min) return;
    const entry = { lvl, msg, ts: new Date().toISOString(), ...(data ? { data } : {}) };
    console.log(JSON.stringify(entry));
  };
  return {
    debug: (msg: string, data?: unknown) => log('debug', msg, data),
    info: (msg: string, data?: unknown) => log('info', msg, data),
    warn: (msg: string, data?: unknown) => log('warn', msg, data),
    error: (msg: string, data?: unknown) => log('error', msg, data),
  };
}
