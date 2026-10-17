import pino from 'pino';

export const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    error: pino.stdSerializers.err,
  },
  redact: {
    paths: ['*.password', '*.passwordHash', '*.token', '*.code', '*.refreshToken'],
    censor: '[REDACTED]',
  },
});
