import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { AztecAddress } from '@aztec/aztec.js/addresses';

const addresses = [
  '0x18a15b90bea06cea7cbd06b3940533952aa9e5f94c157000c727321644d07af8',
  '0x0b2efe751af9a90a5f263f3fc5c268421454dcb41532e872fb5ab03f7fe29fac',
];

async function main() {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? 'https://v4-devnet-2.aztec-labs.com/';
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });

  for (const a of addresses) {
    const addr = AztecAddress.fromString(a);
    const contract = await node.getContract(addr);
    console.log('node.getContract', a, !!contract);
    try {
      const meta = await wallet.getContractMetadata(addr);
      console.log('wallet.getContractMetadata', a, JSON.stringify(meta));
    } catch (err) {
      console.log('wallet.getContractMetadata error', a, String(err));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
