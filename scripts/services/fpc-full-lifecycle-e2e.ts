function printHelp(): void {
  console.log(`Usage: bun run e2e:full-lifecycle [--help]

Step 1 scaffold is in place.
This runner is intentionally minimal until later plan steps are implemented.
`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  throw new Error(
    "Issue #85 plan step 1 completed: entrypoint wired. Runner implementation is pending later steps.",
  );
}

await main();
