import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { getSchnorrAccountContractAddress } from '@aztec/accounts/schnorr';
import { Fr } from '@aztec/aztec.js/fields';

async function main() {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? 'https://v4-devnet-2.aztec-labs.com/';
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);

  const tests = await getInitialTestAccountsData();
  console.log('node', nodeUrl);
  for (let i = 0; i < Math.min(20, tests.length); i++) {
    const t = tests[i];
    const addr = await getSchnorrAccountContractAddress(t.secret, t.salt);
    const c = await node.getContract(addr);
    console.log(i, addr.toString(), c ? 'published' : 'not_published');
  }

  const deployer = Fr.fromHexString('0x1111111111111111111111111111111111111111111111111111111111111111');
  const deployerAddr = await getSchnorrAccountContractAddress(deployer, Fr.ZERO);
  const deployerPublished = await node.getContract(deployerAddr);
  console.log('deployer', deployerAddr.toString(), deployerPublished ? 'published' : 'not_published');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
