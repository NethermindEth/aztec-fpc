#!/usr/bin/env node
// Derived from @defi-wonderland/aztec-benchmark (cli/cli.ts, cli/profiler.ts, cli/systemInfo.ts)
// Copyright (c) 2025 Wonderland — MIT License
// See THIRD-PARTY-NOTICES in this directory for the full license text.
/**
 * Inline benchmark runner — replaces @defi-wonderland/aztec-benchmark CLI.
 *
 * Usage:
 *   node runner.mjs --config ../Nargo.toml --output-dir benchmarks --contracts fpc
 */

import fs from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { parseArgs } from 'node:util';

// ── System info ─────────────────────────────────────────────────────────────

function getSystemInfo() {
  let cpuModel = 'N/A', cpuCores = 0, totalMemoryGiB = 0, arch = 'N/A';
  try { cpuCores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length; } catch {}
  try { totalMemoryGiB = Math.round(os.totalmem() / (1024 ** 3)); } catch {}
  try { arch = (process.env.RUNNER_ARCH ?? os.arch()).toLowerCase(); } catch {}
  try { const c = os.cpus(); if (c?.[0]?.model) cpuModel = c[0].model.trim(); } catch {}
  return { cpuModel, cpuCores, totalMemoryGiB, arch };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const sumArray = (arr) => arr.reduce((a, b) => a + b, 0);
const sumGas = (gas) => (gas?.daGas ?? 0) + (gas?.l2Gas ?? 0);

// ── Profiler ────────────────────────────────────────────────────────────────

class Profiler {
  #skipProving;
  #feePaymentMethod;

  constructor(_wallet, options) {
    this.#skipProving = options?.skipProving ?? false;
    this.#feePaymentMethod = options?.feePaymentMethod;
  }

  async profile(fsToProfile) {
    const results = [];
    for (const item of fsToProfile) {
      const isNamed = 'interaction' in item && 'name' in item;
      results.push(await this.#profileOne(
        isNamed ? item.interaction : item,
        isNamed ? item.name : undefined,
      ));
    }
    return results;
  }

  async #profileOne(f, customName) {
    const name = customName ?? 'unknown_function';
    console.log(`Profiling ${name}...`);

    const origin = f.caller;
    const feeOpts = this.#feePaymentMethod
      ? { paymentMethod: this.#feePaymentMethod }
      : undefined;

    // 1. Simulate to estimate gas.
    const gas = (await f.action.simulate({
      from: origin,
      includeMetadata: true,
      fee: { estimateGas: true, estimatedGasPadding: 0, ...feeOpts },
    })).estimatedGas;

    // 2. Profile to get gate counts (and optionally proving time).
    const profileResults = await f.action.profile({
      profileMode: 'full',
      from: origin,
      skipProofGeneration: this.#skipProving,
      fee: feeOpts,
    });

    const provingTime = !this.#skipProving
      ? profileResults.stats?.timings?.proving
      : undefined;

    // 3. Send the tx (proves again internally).
    await f.action.send({ from: origin, fee: feeOpts });

    const result = {
      name,
      totalGateCount: sumArray(
        profileResults.executionSteps
          .map((s) => s.gateCount)
          .filter((c) => c !== undefined),
      ),
      gateCounts: profileResults.executionSteps.map((s) => ({
        circuitName: s.functionName,
        gateCount: s.gateCount || 0,
      })),
      gas,
      provingTime,
    };

    const daGas = gas?.gasLimits?.daGas ?? 'N/A';
    const l2Gas = gas?.gasLimits?.l2Gas ?? 'N/A';
    const provingDisplay = provingTime !== undefined ? `${provingTime}ms` : 'skipped';
    console.log(` -> ${name}: ${result.totalGateCount} gates, Gas (DA: ${daGas}, L2: ${l2Gas}), Proving: ${provingDisplay}`);
    return result;
  }

  async saveResults(results, filename) {
    const systemInfo = getSystemInfo();
    if (!results.length) {
      console.log(`No results to save for ${filename}. Saving empty report.`);
      fs.writeFileSync(filename, JSON.stringify({ summary: {}, results: [], gasSummary: {}, provingTimeSummary: {}, systemInfo }, null, 2));
      return;
    }
    const summary = Object.fromEntries(results.map((r) => [r.name, r.totalGateCount]));
    const gasSummary = Object.fromEntries(results.map((r) => [
      r.name,
      r.gas ? sumGas(r.gas.gasLimits) + sumGas(r.gas.teardownGasLimits) : 0,
    ]));
    const provingTimeSummary = Object.fromEntries(results.map((r) => [r.name, r.provingTime ?? 0]));

    const report = { summary, results, gasSummary, provingTimeSummary, systemInfo };
    console.log(`Saving results for ${results.length} methods in ${filename}`);
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  }
}

// ── Minimal TOML [benchmark] parser ─────────────────────────────────────────

function parseBenchmarks(tomlPath) {
  const content = fs.readFileSync(tomlPath, 'utf-8');
  const benchmarks = {};
  let inSection = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[benchmark]') { inSection = true; continue; }
    if (trimmed.startsWith('[') && inSection) break; // next section
    if (!inSection || !trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(\w+)\s*=\s*"(.+)"$/);
    if (m) benchmarks[m[1]] = m[2];
  }
  return benchmarks;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { values: opts } = parseArgs({
    options: {
      config:        { type: 'string', default: './Nargo.toml' },
      'output-dir':  { type: 'string', default: './benchmarks' },
      suffix:        { type: 'string', default: '' },
      contracts:     { type: 'string', multiple: true, default: [] },
      'skip-proving':{ type: 'boolean', default: false },
    },
    strict: false,
  });

  const nargoTomlPath = path.resolve(process.cwd(), opts.config);
  const outputDir     = path.resolve(process.cwd(), opts['output-dir']);
  const suffix        = opts.suffix;
  const specified     = opts.contracts;
  const skipProving   = opts['skip-proving'];

  if (!fs.existsSync(nargoTomlPath)) {
    console.error(`Error: Nargo.toml not found at ${nargoTomlPath}`);
    process.exit(1);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const available = parseBenchmarks(nargoTomlPath);
  const names = Object.keys(available);

  if (!names.length) {
    console.error('No contracts found in the [benchmark] section of Nargo.toml.');
    process.exit(1);
  }

  const toRun = specified.length
    ? names.filter((n) => specified.includes(n))
    : names;

  if (!toRun.length) {
    console.error(`Error: None of the specified contracts found: ${specified.join(', ')}`);
    process.exit(1);
  }

  console.log(`Found ${toRun.length} benchmark(s) to run: ${toRun.join(', ')}`);

  for (const contractName of toRun) {
    const benchmarkFilePath = path.resolve(path.dirname(nargoTomlPath), available[contractName]);
    const outputFilename    = `${contractName}${suffix}.benchmark.json`;
    const outputJsonPath    = path.join(outputDir, outputFilename);

    console.log(`--- Running benchmark for ${contractName}${suffix ? ` (suffix: ${suffix})` : ''} ---`);
    console.log(` -> Benchmark file: ${benchmarkFilePath}`);
    console.log(` -> Output report: ${outputJsonPath}`);

    if (!fs.existsSync(benchmarkFilePath)) {
      console.error(`Error: Benchmark file not found: ${benchmarkFilePath}`);
      process.exit(1);
    }

    try {
      const mod = await import(benchmarkFilePath);
      const BenchmarkClass = mod.default;
      if (!BenchmarkClass || typeof BenchmarkClass !== 'function' || typeof BenchmarkClass.prototype.getMethods !== 'function') {
        console.error(`Error: ${benchmarkFilePath} does not export a default class with a getMethods method.`);
        process.exit(1);
      }

      const instance = new BenchmarkClass();
      let ctx = {};

      if (typeof instance.setup === 'function') {
        console.log(`Running setup for ${contractName}...`);
        ctx = await instance.setup();
        console.log(`Setup complete for ${contractName}.`);
      }

      const profiler = new Profiler(ctx.wallet, { skipProving, feePaymentMethod: ctx.feePaymentMethod });
      console.log(`Getting methods to benchmark for ${contractName}...`);
      const interactions = instance.getMethods(ctx);

      if (!Array.isArray(interactions) || !interactions.length) {
        console.warn(`No benchmark methods returned for ${contractName}. Saving empty report.`);
        await profiler.saveResults([], outputJsonPath);
      } else {
        console.log(`Profiling ${interactions.length} methods for ${contractName}...`);
        const results = await profiler.profile(interactions);
        await profiler.saveResults(results, outputJsonPath);
      }

      if (typeof instance.teardown === 'function') {
        console.log(`Running teardown for ${contractName}...`);
        await instance.teardown(ctx);
        console.log(`Teardown complete for ${contractName}.`);
      }

      // Cleanup: PXE.stop() doesn't release all resources
      if (ctx.wallet) {
        const pxe = ctx.wallet.pxe;
        if (pxe?.blockStateSynchronizer) {
          await pxe.blockStateSynchronizer.blockStream?.stop();
          await pxe.blockStateSynchronizer.store?.close();
        }
        await ctx.wallet.stop();
        for (const h of process._getActiveHandles()) {
          if (h?.constructor?.name === 'Socket' && !h.destroyed) h.destroy();
        }
      }

      console.log(`--- Benchmark finished for ${contractName} ---`);
    } catch (error) {
      console.error(`Failed to run benchmark for ${contractName}:`, error);
      process.exit(1);
    }
  }

  console.log('All specified benchmarks completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
