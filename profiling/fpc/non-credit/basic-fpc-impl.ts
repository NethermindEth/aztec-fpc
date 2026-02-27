/**
 * NonCreditFpc implementation for the current FPC contract.
 *
 * Wraps: contracts/fpc  (fee_entrypoint)
 *
 * To add a new non-credit variant, create a sibling file that also implements
 * NonCreditFpc and handles its own quote hash / entrypoint selector internally.
 */

import type { NonCreditFpc, PreparePaymentInput, FpcPaymentMethod } from '../types.js';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { GasSettings } from '@aztec/stdlib/gas';
import { Fr } from '@aztec/foundation/curves/bn254';
import { FunctionCall, FunctionSelector, FunctionType, loadContractArtifact } from '@aztec/stdlib/abi';
import { ExecutionPayload } from '@aztec/stdlib/tx';
import { Contract } from '@aztec/aztec.js/contracts';
import { readFileSync } from 'fs';
import { signQuote, findArtifact, feeJuiceToAsset } from '../../profile-utils.mjs';

const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC"

// ── Payment method ────────────────────────────────────────────────────────────

class BasicFpcPaymentMethod implements FpcPaymentMethod {
  constructor(
    private readonly fpcAddress: AztecAddress,
    private readonly authwit: any,
    private readonly quoteSigFields: Fr[],
    private readonly authwitNonce: bigint,
    private readonly rateNum: bigint,
    private readonly rateDen: bigint,
    private readonly validUntil: bigint,
    private readonly gasSettings: GasSettings,
  ) {}

  getFeePayer() { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const selector = await FunctionSelector.fromSignature(
      'fee_entrypoint(Field,u128,u128,u64,[u8;64])',
    );
    const call = FunctionCall.from({
      name: 'fee_entrypoint',
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [
        new Fr(this.authwitNonce),
        new Fr(this.rateNum),
        new Fr(this.rateDen),
        new Fr(this.validUntil),
        ...this.quoteSigFields,
      ],
      returnTypes: [],
    });
    return new ExecutionPayload([call], [this.authwit], [], [], this.fpcAddress);
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

export class BasicFpcImpl implements NonCreditFpc {
  private constructor(
    readonly fpcAddress: AztecAddress,
    readonly operatorAddress: AztecAddress,
    readonly tokenAddress: AztecAddress,
    private readonly tokenContract: any,
  ) {}

  /** Deploy FPC and return a ready-to-use NonCreditFpc handle. */
  static async deploy(
    wallet: any,
    operatorAddress: AztecAddress,
    operatorPubKey: { x: bigint; y: bigint },
    tokenAddress: AztecAddress,
  ): Promise<BasicFpcImpl> {
    const artifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('FPC'), 'utf8')),
    );
    const tokenArtifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('Token'), 'utf8')),
    );

    const deploy = await Contract.deploy(wallet, artifact, [
      operatorAddress,
      operatorPubKey.x,
      operatorPubKey.y,
      tokenAddress,
    ]).send({ from: operatorAddress });

    return new BasicFpcImpl(
      deploy.address,
      operatorAddress,
      tokenAddress,
      Contract.at(tokenAddress, tokenArtifact, wallet),
    );
  }

  async preparePayment(input: PreparePaymentInput): Promise<FpcPaymentMethod> {
    const { wallet, userAddress, schnorr, operatorSigningKey,
            rateNum, rateDen, validUntil, gasSettings, authwitNonce } = input;

    // Compute charge: ceil(maxGasCost * rateNum / rateDen)
    const maxGasCost = maxGasCostNoTeardown(gasSettings);
    const charge = feeJuiceToAsset(maxGasCost, rateNum, rateDen);

    // Sign the quote (implementation-specific hash preimage lives here).
    const quoteSigFields = await signQuote(
      schnorr, operatorSigningKey,
      this.fpcAddress, this.tokenAddress,
      rateNum, rateDen, validUntil, userAddress,
      QUOTE_DOMAIN_SEP,
    );

    // Authwit: user authorises FPC to pull `charge` tokens.
    const authwit = await wallet.createAuthWit(userAddress, {
      caller: this.fpcAddress,
      action: this.tokenContract.methods.transfer_private_to_private(
        userAddress, this.operatorAddress, charge, authwitNonce,
      ),
    });

    return new BasicFpcPaymentMethod(
      this.fpcAddress, authwit, quoteSigFields,
      authwitNonce, rateNum, rateDen, validUntil, gasSettings,
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function maxGasCostNoTeardown(gs: GasSettings): bigint {
  return gs.maxFeesPerGas.feePerDaGas * BigInt(gs.gasLimits.daGas)
       + gs.maxFeesPerGas.feePerL2Gas * BigInt(gs.gasLimits.l2Gas);
}
