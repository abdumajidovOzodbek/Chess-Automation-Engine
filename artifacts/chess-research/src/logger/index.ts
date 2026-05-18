import pino from "pino";

const isProduction = process.env["NODE_ENV"] === "production";

const baseLogger = pino(
  isProduction
    ? { level: process.env["LOG_LEVEL"] ?? "info" }
    : {
        level: process.env["LOG_LEVEL"] ?? "debug",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
);

export function createLogger(name: string): pino.Logger {
  return baseLogger.child({ module: name });
}

export { baseLogger as logger };
