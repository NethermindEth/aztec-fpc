// Vendored from @defi-wonderland/aztec-benchmark (action/comparison.cjs)
// Copyright (c) 2025 Wonderland — MIT License
// See THIRD-PARTY-NOTICES in this directory for the full license text.

const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');

const pinoLogger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: false,
      ignore: 'pid,hostname,time,level',
    },
  },
});

/**
 * Formats system info as a markdown table.
 * @param {object} systemInfo - The system info object from benchmark JSON.
 * @returns {string} Markdown table showing system hardware info.
 */
function formatSystemInfoTable(systemInfo) {
  if (!systemInfo) {
    return '| CPU | Cores | RAM | Arch |\n|-----|-------|-----|------|\n| N/A | N/A | N/A | N/A |\n';
  }

  const cpu = systemInfo.cpuModel || 'N/A';
  const cores = systemInfo.cpuCores || 'N/A';
  const ram = systemInfo.totalMemoryGiB ? `${systemInfo.totalMemoryGiB} GiB` : 'N/A';
  const arch = systemInfo.arch || 'N/A';

  return [
    '| CPU | Cores | RAM | Arch |',
    '|-----|-------|-----|------|',
    `| ${cpu} | ${cores} | ${ram} | ${arch} |`,
    '',
  ].join('\n');
}

/**
 * Extracts DA (Data Availability) gas from a benchmark result.
 * @param {object} result - The benchmark result object.
 * @returns {number} The DA gas value, or 0 if not found.
 */
const getDaGas = (result) => result?.gas?.gasLimits?.daGas ?? 0;
/**
 * Extracts L2 gas from a benchmark result.
 * @param {object} result - The benchmark result object.
 * @returns {number} The L2 gas value, or 0 if not found.
 */
const getL2Gas = (result) => result?.gas?.gasLimits?.l2Gas ?? 0;
/**
 * Extracts proving time from a benchmark result.
 * @param {object} result - The benchmark result object.
 * @returns {number} The proving time in milliseconds, or 0 if not found.
 */
const getProvingTime = (result) => result?.provingTime ?? 0;

/**
 * Formats the difference between two numbers as a string, including percentage change.
 * Handles cases like zero main value (infinite increase) or zero pr value (100% decrease).
 * @param {number} main - The base value.
 * @param {number} pr - The new value (from Pull Request).
 * @returns {string} A formatted string representing the difference, or an empty string if no significant change.
 */
const formatDiff = (main, pr) => {
  if (main === 0 && pr === 0) return ''; // Use empty string for no change if both zero
  if (main === 0) return '+Inf%'; // Handle infinite increase
  if (pr === 0) return '-100%'; // Handle 100% decrease

  const diff = pr - main;
  if (diff === 0) return ''; // Use empty string for no change

  const pct = (diff / main) * 100;
  const sign = diff > 0 ? '+' : '';

  if (Math.abs(pct) < 0.01 && Math.abs(diff) < 1) return ''; // Threshold for small changes
  // Format with commas and show percentage
  return `${sign}${diff.toLocaleString()} (${sign}${pct.toFixed(1)}%)`;
};

/**
 * Determines an emoji status based on benchmark metric changes and a threshold.
 * @param {object} metrics - An object containing main and pr values for gates, daGas, and l2Gas.
 * @param {number} threshold - The percentage threshold for significant change.
 * @returns {string} An emoji: '🚮' for removed, '🆕' for new, '🔴' for regression, '🟢' for improvement, '⚪' for no significant change.
 */
const getStatusEmoji = (metrics, threshold) => {
  const isRemoved = metrics.gates.pr === 0 && metrics.daGas.pr === 0 && metrics.l2Gas.pr === 0 &&
                  (metrics.gates.main > 0 || metrics.daGas.main > 0 || metrics.l2Gas.main > 0);
  const isNew = metrics.gates.main === 0 && metrics.daGas.main === 0 && metrics.l2Gas.main === 0 &&
              (metrics.gates.pr > 0 || metrics.daGas.pr > 0 || metrics.l2Gas.pr > 0);

  if (isRemoved) return '🚮';
  if (isNew) return '🆕';

  // Avoid division by zero, handle infinite increases
  const gateDiffPct = metrics.gates.main === 0 ? (metrics.gates.pr > 0 ? Infinity : 0) :
                    (metrics.gates.pr - metrics.gates.main) / metrics.gates.main;
  const daGasDiffPct = metrics.daGas.main === 0 ? (metrics.daGas.pr > 0 ? Infinity : 0) :
                    (metrics.daGas.pr - metrics.daGas.main) / metrics.daGas.main;
  const l2GasDiffPct = metrics.l2Gas.main === 0 ? (metrics.l2Gas.pr > 0 ? Infinity : 0) :
                    (metrics.l2Gas.pr - metrics.l2Gas.main) / metrics.l2Gas.main;

  const metricsDiffs = [gateDiffPct, daGasDiffPct, l2GasDiffPct].filter(m => isFinite(m));
  const hasInfiniteIncrease = [gateDiffPct, daGasDiffPct, l2GasDiffPct].some(m => m === Infinity);

  // Use threshold percentage directly
  const thresholdDecimal = threshold / 100.0;

  const hasRegression = hasInfiniteIncrease || metricsDiffs.some(m => m > thresholdDecimal);
  const hasImprovement = metricsDiffs.some(m => m < -thresholdDecimal);

  if (hasRegression) return '🔴'; // Regression
  if (hasImprovement) return '🟢'; // Improvement
  return '⚪'; // No significant change / within threshold
};

/**
 * Finds pairs of benchmark report files (base and PR/latest) in a directory.
 * Now includes new contracts that only have PR reports (no corresponding base report).
 * @param {string} reportsDir - The directory containing benchmark reports.
 * @param {string} baseSuffix - The suffix for base report filenames (e.g., '_base').
 * @param {string} prSuffix - The suffix for PR/latest report filenames (e.g., '_latest').
 * @returns {Array<object>} An array of pairs, each with contractName, baseJsonPath (or null), and prJsonPath.
 */
function findBenchmarkPairs(reportsDir, baseSuffix, prSuffix) {
  const pairs = [];
  const prSuffixPattern = `${prSuffix}.benchmark.json`;
  const baseSuffixPattern = `${baseSuffix}.benchmark.json`;

  try {
    const files = fs.readdirSync(reportsDir);
    for (const file of files) {
      if (file.endsWith(prSuffixPattern)) {
        // Extract contract name from PR filename
        const contractName = file.substring(0, file.length - prSuffixPattern.length);
        // Construct expected baseline filename
        const baseFilename = `${contractName}${baseSuffixPattern}`;
        const baseJsonPath = path.join(reportsDir, baseFilename);
        const prJsonPath = path.join(reportsDir, file);

        // Include all PR reports, whether or not they have a corresponding base report
        pairs.push({
          contractName,
          baseJsonPath: fs.existsSync(baseJsonPath) ? baseJsonPath : null,
          prJsonPath
        });
      }
    }
  } catch (error) {
    // Handle cases where the directory doesn't exist
    if (error.code === 'ENOENT') {
      pinoLogger.warn(`Reports directory not found: ${reportsDir}`);
    } else {
      pinoLogger.error(`Error reading reports directory ${reportsDir}: ${error}`);
    }
  }
  return pairs;
}

/**
 * Generates an HTML table comparing benchmark results for a single contract.
 * Handles new contracts where baseJsonPath may be null (no base report exists).
 * @param {object} pair - An object containing contractName, baseJsonPath (or null), and prJsonPath.
 * @param {number} threshold - The percentage threshold for highlighting regressions.
 * @returns {string} An HTML string representing the comparison table, or an error message.
 */
function generateContractComparisonTable(pair, threshold) {
  const { contractName, baseJsonPath, prJsonPath } = pair;
  const isNewContract = baseJsonPath === null;
  
  if (isNewContract) {
    pinoLogger.info(` Generating report for new contract: ${contractName} in ${prJsonPath}`);
  } else {
    pinoLogger.info(` Comparing: ${baseJsonPath} vs ${prJsonPath}`);
  }

  // Check that PR report exists
  if (!fs.existsSync(prJsonPath)) {
    return `*Error: PR report file missing for ${contractName}: ${prJsonPath}*`;
  }

  // Check that base report exists (if not a new contract)
  if (!isNewContract && !fs.existsSync(baseJsonPath)) {
    return `*Error: Base report file missing for ${contractName}: ${baseJsonPath}*`;
  }

  let mainData, prData;
  try {
     // For new contracts, use empty data structure for base
     if (isNewContract) {
       mainData = { results: [] };
     } else {
       mainData = JSON.parse(fs.readFileSync(baseJsonPath, 'utf-8'));
     }
     prData = JSON.parse(fs.readFileSync(prJsonPath, 'utf-8'));
  } catch(e) {
     return `*Error parsing benchmark JSON for ${contractName}: ${e.message}*`;
  }

   if (!mainData || !mainData.results || !prData || !prData.results) {
    return `*Skipping ${contractName}: Invalid JSON structure (missing results array).*`;
  }

  const comparison = {};
  const allFunctionNames = new Set([
    ...mainData.results.map(r => r.name),
    ...prData.results.map(r => r.name)
  ]);

  for (const name of allFunctionNames) {
     if (!name || name.startsWith('unknown_function') || name.includes('(FAILED)') || name === 'BENCHMARK_RUNNER_ERROR') {
      pinoLogger.info(` Skipping comparison for malformed/failed entry: ${name}`);
      continue;
    }
    const mainResult = mainData.results.find((r) => r.name === name);
    const prResult = prData.results.find((r) => r.name === name);

    comparison[name] = {
      gates: { main: mainResult?.totalGateCount ?? 0, pr: prResult?.totalGateCount ?? 0 },
      daGas: { main: getDaGas(mainResult), pr: getDaGas(prResult) },
      l2Gas: { main: getL2Gas(mainResult), pr: getL2Gas(prResult) },
      provingTime: { main: getProvingTime(mainResult), pr: getProvingTime(prResult) },
    };
  }

  const output = [
    '<table>',
    '<thead>',
    '<tr>',
    '  <th></th>',
    '  <th>Function</th>',
    '  <th colspan="3">Gates</th>',
    '  <th colspan="3">DA Gas</th>',
    '  <th colspan="3">L2 Gas</th>',
    '  <th colspan="3">Proving Time (ms)</th>',
    '</tr>',
    '<tr>',
    '  <th>Status</th>',
    '  <th></th>',
    '  <th>Base</th>',
    '  <th>PR</th>',
    '  <th>Diff</th>',
    '  <th>Base</th>',
    '  <th>PR</th>',
    '  <th>Diff</th>',
    '  <th>Base</th>',
    '  <th>PR</th>',
    '  <th>Diff</th>',
    '  <th>Base</th>',
    '  <th>PR</th>',
    '  <th>Diff</th>',
    '</tr>',
    '</thead>',
    '<tbody>',
  ];

  const sortedNames = Object.keys(comparison).sort();

  if (sortedNames.length === 0) {
      return "*No comparable functions found between reports.*";
  }

  for (const funcName of sortedNames) {
    const metrics = comparison[funcName];
    if (!metrics) continue;

    const statusEmoji = getStatusEmoji(metrics, threshold);
    output.push(
      '<tr>',
      `  <td align="center">${statusEmoji}</td>`,
      `  <td><code>${funcName}</code></td>`,
      // Gates
      `  <td align="right">${metrics.gates.main.toLocaleString()}</td>`,
      `  <td align="right">${metrics.gates.pr.toLocaleString()}</td>`,
      `  <td align="right">${formatDiff(metrics.gates.main, metrics.gates.pr)}</td>`,
      // DA Gas
      `  <td align="right">${metrics.daGas.main.toLocaleString()}</td>`,
      `  <td align="right">${metrics.daGas.pr.toLocaleString()}</td>`,
      `  <td align="right">${formatDiff(metrics.daGas.main, metrics.daGas.pr)}</td>`,
      // L2 Gas
      `  <td align="right">${metrics.l2Gas.main.toLocaleString()}</td>`,
      `  <td align="right">${metrics.l2Gas.pr.toLocaleString()}</td>`,
      `  <td align="right">${formatDiff(metrics.l2Gas.main, metrics.l2Gas.pr)}</td>`,
      // Proving Time
      `  <td align="right">${metrics.provingTime.main > 0 ? Math.round(metrics.provingTime.main).toLocaleString() : 'N/A'}</td>`,
      `  <td align="right">${metrics.provingTime.pr > 0 ? Math.round(metrics.provingTime.pr).toLocaleString() : 'N/A'}</td>`,
      `  <td align="right">${formatDiff(Math.round(metrics.provingTime.main), Math.round(metrics.provingTime.pr))}</td>`,
      '</tr>',
    );
  }

  output.push('</tbody>', '</table>');
  return output.join('\n');
};

/**
 * Main function to run the benchmark comparison.
 * It finds benchmark report pairs, generates comparison tables for each, and combines them into a single markdown output.
 * @param {object} inputs - The input parameters for the comparison.
 * @param {string} inputs.reportsDir - Directory where benchmark reports are stored.
 * @param {string} inputs.baseSuffix - Suffix for baseline report files.
 * @param {string} inputs.prSuffix - Suffix for PR/current report files.
 * @param {number} inputs.threshold - Percentage threshold for regressions.
 * @returns {string} A markdown string containing the full comparison report.
 */
function runComparison(inputs) {
  const { reportsDir, baseSuffix, prSuffix, threshold } = inputs;
  pinoLogger.info("Comparison script starting...");
  pinoLogger.info(` Reports Dir: ${reportsDir} (expected ./benchmarks)`);
  pinoLogger.info(` Base Suffix: '${baseSuffix}' (expected _base)`);
  pinoLogger.info(` PR Suffix: '${prSuffix}' (expected _latest)`);
  pinoLogger.info(` Threshold: ${threshold}%`);

  // Find pairs by scanning the directory
  const benchmarkPairs = findBenchmarkPairs(reportsDir, baseSuffix, prSuffix);

  if (!benchmarkPairs.length) {
    pinoLogger.info("No matching benchmark report pairs found in the directory.");
    return '# Benchmark Comparison\n\nNo matching benchmark report pairs found to compare.\n';
  }

  let markdownOutput = ['<!-- benchmark-diff -->\n', '# Benchmark Comparison\n'];

  // Sort pairs by contract name for consistent report order
  benchmarkPairs.sort((a, b) => a.contractName.localeCompare(b.contractName));

  // Read system info from benchmark report (all reports have the same info since they run on the same machine)
  let systemInfo = null;
  if (benchmarkPairs.length > 0) {
    try {
      const firstReport = JSON.parse(fs.readFileSync(benchmarkPairs[0].prJsonPath, 'utf-8'));
      systemInfo = firstReport.systemInfo;
    } catch (e) {
      pinoLogger.warn(`Could not read system info from benchmark report: ${e.message}`);
    }
  }

  // Add system info table (displayed once at the top)
  markdownOutput.push(formatSystemInfoTable(systemInfo));

  for (const pair of benchmarkPairs) {
    pinoLogger.info(`\nProcessing contract: ${pair.contractName}...`);
    const tableMarkdown = generateContractComparisonTable(pair, threshold);
    markdownOutput.push(`## Contract: ${pair.contractName}\n`);
    markdownOutput.push(tableMarkdown);
    markdownOutput.push('\n');
  }

  pinoLogger.info(`\nComparison report generated for ${benchmarkPairs.length} contract pair(s).`);
  return markdownOutput.join('\n');
}

module.exports = { runComparison }; 