/**
 * Diagnostic: check which artifact version matches the deployed contracts.
 *
 * Run from the aztec-packages yarn-project directory so @aztec/* packages resolve:
 *   cd /path/to/aztec-packages/yarn-project
 *   node /path/to/aztec-fpc/profiling/check-class-ids.mjs
 */
import { getContractClassFromArtifact } from '@aztec/stdlib/contract';
import { readFileSync, existsSync }      from 'fs';
import { fileURLToPath }                 from 'url';
import { dirname, join }                 from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET    = join(__dirname, '../target');

async function classId(path) {
  if (!existsSync(path)) return '(file not found)';
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const cls = await getContractClassFromArtifact(artifact);
  return cls.id.toString();
}

const DEPLOYED_TOKEN = '0x27a7fa7774a92a567255a38e0f2f7ab0ab54a7322427c87dc49613d64cadc1fa';
const DEPLOYED_FPC   = '(unknown — will be shown below)';

console.log('Token class IDs:');
console.log('  current  :', await classId(join(TARGET, 'token_contract-Token.json')));
console.log('  .bak     :', await classId(join(TARGET, 'token_contract-Token.json.bak')));
console.log('  deployed :', DEPLOYED_TOKEN);

console.log('\nFPC class IDs:');
console.log('  current  :', await classId(join(TARGET, 'fpc-FPC.json')));
console.log('  .bak     :', await classId(join(TARGET, 'fpc-FPC.json.bak')));
