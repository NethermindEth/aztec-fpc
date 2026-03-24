import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec/aztec.js/utils";

export type GetFeeJuiceBalance = (owner: AztecAddress) => Promise<bigint>;

export function createGetFeeJuiceBalance(node: AztecNode): GetFeeJuiceBalance {
  return (owner) => getFeeJuiceBalance(owner, node);
}
