const stamp = () => new Date().toISOString().slice(11, 23);

const write = (stream, level, args) => {
  stream.write(`${stamp()} [${level}] ${args.map(format).join(' ')}\n`);
};

const format = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const logger = {
  info: (...args) => write(process.stdout, 'info', args),
  warn: (...args) => write(process.stderr, 'warn', args),
  error: (...args) => write(process.stderr, 'error', args),
  debug: (...args) => {
    if (process.env.DEBUG) write(process.stdout, 'debug', args);
  },
};

export default logger;
