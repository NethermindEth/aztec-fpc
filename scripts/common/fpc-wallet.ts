import type { NoFrom } from "@aztec/aztec.js/account";
import type { InteractionWaitOptions, SendReturn } from "@aztec/aztec.js/contracts";
import type { SendOptions } from "@aztec/aztec.js/wallet";
import { DefaultMultiCallEntrypoint } from "@aztec/entrypoints/multicall";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { ExecutionPayload, TxExecutionRequest, TxSimulationResult } from "@aztec/stdlib/tx";
import { BaseWallet, type SimulateViaEntrypointOptions } from "@aztec/wallet-sdk/base-wallet";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

/**
 * EmbeddedWallet subclass that restores Aztec 4.1.0 behavior for three paths
 * broken by 4.2.0 changes affecting FPC fee-payment flows.
 *
 * 1. **sendTx pre-simulation**: EmbeddedWallet.sendTx() runs a mandatory
 *    simulation with inflated gas limits. The FPC contract's strict assertion
 *    `fj_fee_amount == max_fee` fails because inflated limits ≠ quoted amount.
 *    Fix: delegate sendTx() to BaseWallet, skipping the pre-simulation.
 *
 * 2. **AztecAddress.ZERO account lookup**: Account deployment uses
 *    `from: AztecAddress.ZERO` (the account doesn't exist yet). In 4.1.0,
 *    EmbeddedWallet returned a SignerlessAccount + multicall entrypoint for
 *    the zero address. In 4.2.0, this was removed — simulate and send paths
 *    call getAccountFromAddress(ZERO) which throws.
 *    Fix: intercept ZERO in simulateViaEntrypoint and
 *    createTxExecutionRequestFromPayloadAndFee, routing through
 *    DefaultMultiCallEntrypoint — the same mechanism the old code used.
 *
 * 3. **scopesFrom no longer treats ZERO as empty**: In 4.1.0,
 *    `scopesFrom(AztecAddress.ZERO)` returned `[]`, bypassing PXE key
 *    validation. In 4.2.0, it returns `[AztecAddress.ZERO]`, triggering
 *    "Key validation request denied" during proving for undeployed accounts.
 *    Fix: restore the empty-scopes behavior for ZERO.
 *
 * If Aztec restores zero-address handling and adds a skip-simulation option,
 * this subclass can be removed.
 */
export class FpcWallet extends EmbeddedWallet {
  override sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<SendReturn<W>> {
    return BaseWallet.prototype.sendTx.call(this, executionPayload, opts) as Promise<SendReturn<W>>;
  }

  protected override scopesFrom(
    from: AztecAddress | NoFrom,
    additionalScopes: AztecAddress[] = [],
  ): AztecAddress[] {
    if (from instanceof AztecAddress && from.equals(AztecAddress.ZERO)) {
      return additionalScopes;
    }
    return super.scopesFrom(from, additionalScopes);
  }

  protected override simulateViaEntrypoint(
    executionPayload: ExecutionPayload,
    opts: SimulateViaEntrypointOptions,
  ): Promise<TxSimulationResult> {
    if (opts.from instanceof AztecAddress && opts.from.equals(AztecAddress.ZERO)) {
      return this.#simulateViaMulticall(executionPayload, opts);
    }
    return super.simulateViaEntrypoint(executionPayload, opts);
  }

  protected override createTxExecutionRequestFromPayloadAndFee(
    ...args: Parameters<EmbeddedWallet["createTxExecutionRequestFromPayloadAndFee"]>
  ): Promise<TxExecutionRequest> {
    const [, from] = args;
    if (from instanceof AztecAddress && from.equals(AztecAddress.ZERO)) {
      return this.#createMulticallTxRequest(...args);
    }
    return super.createTxExecutionRequestFromPayloadAndFee(...args);
  }

  /**
   * Simulate via DefaultMultiCallEntrypoint for AztecAddress.ZERO, replicating
   * the 4.1.0 SignerlessAccount + multicall behavior.
   */
  async #simulateViaMulticall(
    executionPayload: ExecutionPayload,
    opts: SimulateViaEntrypointOptions,
  ): Promise<TxSimulationResult> {
    const { feeOptions, scopes, skipTxValidation, skipFeeEnforcement } = opts;
    const chainInfo = await this.getChainInfo();
    const entrypoint = new DefaultMultiCallEntrypoint();
    const txRequest = await entrypoint.createTxExecutionRequest(
      executionPayload,
      feeOptions.gasSettings,
      chainInfo,
    );
    return this.pxe.simulateTx(txRequest, {
      simulatePublic: true,
      skipFeeEnforcement,
      skipTxValidation,
      scopes,
    });
  }

  /**
   * Create a TxExecutionRequest via DefaultMultiCallEntrypoint for
   * AztecAddress.ZERO, replicating the 4.1.0 SignerlessAccount behavior.
   */
  async #createMulticallTxRequest(
    ...args: Parameters<EmbeddedWallet["createTxExecutionRequestFromPayloadAndFee"]>
  ): Promise<TxExecutionRequest> {
    const [executionPayload, , feeOptions] = args;
    const chainInfo = await this.getChainInfo();
    const entrypoint = new DefaultMultiCallEntrypoint();
    return entrypoint.createTxExecutionRequest(executionPayload, feeOptions.gasSettings, chainInfo);
  }
}
