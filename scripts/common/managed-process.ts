import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";

export type ManagedProcess = {
  name: string;
  process: ChildProcessWithoutNullStreams;
  getLogs: () => string;
};

const managedProcessRegistry = new Set<ManagedProcess>();
let shutdownInProgress = false;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startManagedProcess(
  name: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): ManagedProcess {
  let logs = "";
  const processHandle = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  processHandle.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stdout.write(`[${name}] ${text}`);
  });
  processHandle.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    logs += text;
    process.stderr.write(`[${name}] ${text}`);
  });

  const managed: ManagedProcess = {
    name,
    process: processHandle,
    getLogs: () => logs,
  };
  managedProcessRegistry.add(managed);
  processHandle.on("exit", () => {
    managedProcessRegistry.delete(managed);
  });
  return managed;
}

export async function stopManagedProcess(proc: ManagedProcess): Promise<void> {
  if (proc.process.exitCode !== null) {
    managedProcessRegistry.delete(proc);
    return;
  }

  const pid = proc.process.pid;
  let signaled = false;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
      signaled = true;
    } catch {
      signaled = false;
    }
  }
  if (!signaled) {
    try {
      proc.process.kill("SIGTERM");
    } catch {
      managedProcessRegistry.delete(proc);
      return;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      managedProcessRegistry.delete(proc);
      return;
    }
    await sleep(100);
  }
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
      managedProcessRegistry.delete(proc);
      return;
    } catch {
      // Fallback to direct child kill if process groups are unavailable.
    }
  }
  try {
    proc.process.kill("SIGKILL");
  } catch {
    // Process may have already exited between checks.
  }
  managedProcessRegistry.delete(proc);
}

export async function stopAllManagedProcesses(): Promise<void> {
  for (const proc of Array.from(managedProcessRegistry).reverse()) {
    await stopManagedProcess(proc);
  }
}

export function installManagedProcessSignalHandlers(logPrefix: string): void {
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    void (async () => {
      console.error(
        `[${logPrefix}] Received ${signal}; stopping managed processes...`,
      );
      await stopAllManagedProcesses();
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

export async function waitForNodeReady(
  node: ReturnType<typeof createAztecNodeClient>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    waitForNode(node),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Timed out waiting for Aztec node after ${timeoutMs}ms`),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

export async function waitForHealth(
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying during boot.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for health endpoint: ${url}`);
}

export async function waitForLog(
  proc: ManagedProcess,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (proc.getLogs().includes(expected)) {
      return;
    }
    if (proc.process.exitCode !== null) {
      throw new Error(
        `Process ${proc.name} exited before logging "${expected}" (exit=${proc.process.exitCode})`,
      );
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${proc.name} log "${expected}". Recent logs:\n${proc
      .getLogs()
      .slice(-4000)}`,
  );
}
