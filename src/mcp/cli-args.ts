export interface McpHttpOptions {
  port: number;
  host: string;
}

export function parseMcpHttpOptions(
  args: string[],
  env: Partial<Pick<NodeJS.ProcessEnv, "PORT" | "HOST">> = process.env,
): McpHttpOptions {
  const portStr = readArgValue(args, "--port") ?? env.PORT ?? "8787";
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portStr}. Must be 1-65535.`);
  }

  const host = readArgValue(args, "--host") ?? env.HOST ?? "127.0.0.1";
  if (!host) {
    throw new Error("Invalid --host: value cannot be empty.");
  }

  return { port, host };
}

function readArgValue(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
    if (arg === name) return args[i + 1] ?? "";
  }
  return undefined;
}
