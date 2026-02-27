/**
 * CreditFpc implementation for the current CreditFPC contract.
 *
 * Wraps: contracts/credit_fpc  (pay_and_mint + pay_with_credit)
 *
 * To add a new credit variant, create a sibling file that also implements
 * CreditFpc and handles its own entrypoint selectors and quote logic internally.
 */

import type { CreditFpc, PreparePaymentInput, FpcPaymentMethod } from '../types.js';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { GasSettings } from '@aztec/stdlib/gas';
import { Fr } from '@aztec/foundation/curves/bn254';
import { FunctionCall, FunctionSelector, FunctionType, loadContractArtifact } from '@aztec/stdlib/abi';
import { ExecutionPayload } from '@aztec/stdlib/tx';
import { Contract } from '@aztec/aztec.js/contracts';
import { readFileSync } from 'fs';
import { signQuote, findArtifact, feeJuiceToAsset } from '../../profile-utils.mjs';

const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC"

// ── Payment methods ───────────────────────────────────────────────────────────

/** pay_and_mint: exchange tokens for credit, become fee payer in the same tx. */
class TopUpPaymentMethod implements FpcPaymentMethod {
  constructor(
    private readonly fpcAddress: AztecAddress,
    private readonly authwit: any,
    private readonly quoteSigFields: Fr[],
    private readonly authwitNonce: bigint,
    private readonly rateNum: bigint,
    private readonly rateDen: bigint,
    private readonly validUntil: bigint,
    private readonly mintAmount: bigint,
    private readonly gasSettings: GasSettings,
  ) {}

  getFeePayer() { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const selector = await FunctionSelector.fromSignature(
      'pay_and_mint(Field,u128,u128,u64,[u8;64],u128)',
    );
    const call = FunctionCall.from({
      name: 'pay_and_mint',
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
        new Fr(this.mintAmount),
      ],
      returnTypes: [],
    });
    return new ExecutionPayload([call], [this.authwit], [], [], this.fpcAddress);
  }
}

/** pay_with_credit: spend existing credit notes, no token transfer needed. */
class CreditPaymentMethod implements FpcPaymentMethod {
  constructor(
    private readonly fpcAddress: AztecAddress,
    private readonly gasSettings: GasSettings,
  ) {}

  getFeePayer() { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const selector = await FunctionSelector.fromSignature('pay_with_credit()');
    const call = FunctionCall.from({
      name: 'pay_with_credit',
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [],
      returnTypes: [],
    });
    return new ExecutionPayload([call], [], [], [], this.fpcAddress);
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

export class CreditFpcImpl implements CreditFpc {
  private constructor(
    readonly fpcAddress: AztecAddress,
    readonly operatorAddress: AztecAddress,
    readonly tokenAddress: AztecAddress,
    private readonly tokenContract: any,
  ) {}

  /** Deploy CreditFPC and return a ready-to-use CreditFpc handle. */
  static async deploy(
    wallet: any,
    operatorAddress: AztecAddress,
    operatorPubKey: { x: bigint; y: bigint },
    tokenAddress: AztecAddress,
  ): Promise<CreditFpcImpl> {
    const artifact = loadContractArtifact(
      JSON.parse(readFileSync(findArtifact('CreditFPC'), 'utf8')),
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

    return new CreditFpcImpl(
      deploy.address,
      operatorAddress,
      tokenAddress,
      Contract.at(tokenAddress, tokenArtifact, wallet),
    );
  }

  async prepareTopUp(
    input: PreparePaymentInput & { mintAmount: bigint },
  ): Promise<FpcPaymentMethod> {
    const { wallet, userAddress, schnorr, operatorSigningKey,
            rateNum, rateDen, validUntil, gasSettings, authwitNonce, mintAmount } = input;

    // Charge is derived from mintAmount (not maxGasCost) — mirrors pay_and_mint logic.
    const charge = feeJuiceToAsset(mintAmount, rateNum, rateDen);

    const quoteSigFields = await signQuote(
      schnorr, operatorSigningKey,
      this.fpcAddress, this.tokenAddress,
      rateNum, rateDen, validUntil, userAddress,
      QUOTE_DOMAIN_SEP,
    );

    const authwit = await wallet.createAuthWit(userAddress, {
      caller: this.fpcAddress,
      action: this.tokenContract.methods.transfer_private_to_private(
        userAddress, this.operatorAddress, charge, authwitNonce,
      ),
    });

    return new TopUpPaymentMethod(
      this.fpcAddress, authwit, quoteSigFields,
      authwitNonce, rateNum, rateDen, validUntil, mintAmount, gasSettings,
    );
  }

  prepareCreditPayment(gasSettings: GasSettings): FpcPaymentMethod {
    return new CreditPaymentMethod(this.fpcAddress, gasSettings);
  }
}
