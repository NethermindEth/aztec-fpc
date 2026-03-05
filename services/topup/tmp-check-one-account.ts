import pino from "pino";
import { createAztecNodeClient, waitForNode } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { AztecAddress } from '@aztec/aztec.js/addresses';

const pinoLogger = pino();

const address = process.argv[2];
if (!address) {
  throw new Error('missing address');
}

async function main() {
  const nodeUrl = process.env.AZTEC_NODE_URL ?? 'https://v4-devnet-2.aztec-labs.com/';
  const node = createAztecNodeClient(nodeUrl);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const addr = AztecAddress.fromString(address);
  const contract = await node.getContract(addr);
  const meta = await wallet.getContractMetadata(addr);
  pinoLogger.info('node.getContract', !!contract);
  pinoLogger.info('metadata', JSON.stringify(meta));
}

main().catch((err) => {
  pinoLogger.error(err);
  process.exit(1);
});
