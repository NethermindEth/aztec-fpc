const UINT_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function requiredEnvGroup(groupLabel: string, ...names: string[]): string {
  const value = firstEnv(...names);
  if (!value) {
    throw new Error(`Missing required env var (${groupLabel}): ${names.join(", ")}`);
  }
  return value;
}

export function loadEnvIfPresent(filePath: string): void {
  const loadEnvFile = (
    process as typeof process & {
      loadEnvFile?: (path: string) => void;
    }
  ).loadEnvFile;
  if (!loadEnvFile) {
    return;
  }
  try {
    loadEnvFile(filePath);
  } catch (error) {
    const maybeErr = error as { code?: string };
    if (maybeErr.code !== "ENOENT") {
      throw error;
    }
  }
}

export function sameAddress(a: { toString(): string }, b: { toString(): string }): boolean {
  return a.toString().toLowerCase() === b.toString().toLowerCase();
}

export function parsePositiveInt(name: string, raw: string): number {
  if (!UINT_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${name} must be an unsigned integer. Got: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer. Got: ${raw}`);
  }
  return parsed;
}

export function parseJsonArray(name: string, raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a valid JSON array. Got: ${raw}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array. Got: ${typeof parsed}`);
  }
  return parsed;
}
