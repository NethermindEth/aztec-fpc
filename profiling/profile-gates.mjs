/**
 * One-shot FPC gate count profiler.
 *
 * Deploys Token + FPC on a running local network, mints tokens, builds
 * authwits, and profiles FPC.fee_entrypoint — all in a single run.
 *
 * Environment:
 *   AZTEC_NODE_URL  — node endpoint (default http://127.0.0.1:8080)
 */

const NODE_URL     = process.env.AZTEC_NODE_URL || 'http://127.0.0.1:8080';
const PXE_DATA_DIR = '/tmp/profile-fpc-pxe';

// 1:1 rate
const RATE_NUM    = 1n;
const RATE_DEN    = 1n;
// Keep quote ttl safely below the contract cap (MAX_QUOTE_TTL_SECONDS = 3600).
const QUOTE_TTL_SECONDS = 3500n;
const TX_NONCE    = BigInt(Date.now());

const QUOTE_DOMAIN_SEP = 0x465043n; // "FPC" as field

// ── Imports ───────────────────────────────────────────────────────────────────
import { createAztecNodeClient }       from '@aztec/aztec.js/node';
import { Contract }                    from '@aztec/aztec.js/contracts';
import { getInitialTestAccountsData }  from '@aztec/accounts/testing';
import { Fr }                          from '@aztec/foundation/curves/bn254';
import { Schnorr }                     from '@aztec/foundation/crypto/schnorr';
import { AztecAddress }                from '@aztec/stdlib/aztec-address';
import {
  FunctionCall, FunctionSelector, FunctionType, loadContractArtifact,
} from '@aztec/stdlib/abi';
import { ExecutionPayload }            from '@aztec/stdlib/tx';
import { Gas, GasFees, GasSettings }  from '@aztec/stdlib/gas';
import { deriveSigningKey }            from '@aztec/stdlib/keys';
import { createPXE, getPXEConfig }     from '@aztec/pxe/server';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import {
  findArtifact, feeJuiceToAsset, SimpleWallet, signQuote, printFpcGateTable,
} from './profile-utils.mjs';

// ── Custom FeePaymentMethod for our FPC ───────────────────────────────────────
class CustomFPCPaymentMethod {
  constructor(fpcAddress, transferAuthWit, quoteSigFields, transferNonce, rateNum, rateDen, validUntil, gasSettings) {
    this.fpcAddress      = fpcAddress;
    this.transferAuthWit = transferAuthWit;
    this.quoteSigFields  = quoteSigFields;
    this.transferNonce   = transferNonce;
    this.rateNum         = rateNum;
    this.rateDen         = rateDen;
    this.validUntil      = validUntil;
    this.gasSettings     = gasSettings;
  }

  getFeePayer()    { return Promise.resolve(this.fpcAddress); }
  getGasSettings() { return this.gasSettings; }

  async getExecutionPayload() {
    const selector = await FunctionSelector.fromSignature('fee_entrypoint(Field,u128,u128,u64,[u8;64])');

    const feeCall = FunctionCall.from({
      name: 'fee_entrypoint',
      to: this.fpcAddress,
      selector,
      type: FunctionType.PRIVATE,
      hideMsgSender: false,
      isStatic: false,
      args: [
        new Fr(this.transferNonce),
        new Fr(this.rateNum),
        new Fr(this.rateDen),
        new Fr(this.validUntil),
        ...this.quoteSigFields,
      ],
      returnTypes: [],
    });

    return new ExecutionPayload(
      [feeCall],
      [this.transferAuthWit],
      [],
      [],
      this.fpcAddress,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== FPC Gate Count Profiler ===\n');

  // ── Connect to node ─────────────────────────────────────────────────────────
  const node = createAztecNodeClient(NODE_URL);
  console.log('Connected to node at', NODE_URL);

  // Derive VALID_UNTIL from L2 chain time, not host wall-clock time.
  // The local node clock can drift from Date.now(), causing false expiry.
  const latestHeader = await node.getBlockHeader('latest');
  const l2Timestamp = latestHeader.globalVariables.timestamp;
  const VALID_UNTIL = l2Timestamp + QUOTE_TTL_SECONDS;
  console.log(`L2 timestamp: ${l2Timestamp}, VALID_UNTIL: ${VALID_UNTIL}`);

  // ── Start embedded PXE (clean slate each run) ──────────────────────────────
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  mkdirSync(PXE_DATA_DIR, { recursive: true });
  const pxeConfig = {
    ...getPXEConfig(),
    dataDirectory: PXE_DATA_DIR,
    l1Contracts: await node.getL1ContractAddresses(),
  };
  const pxe = await createPXE(node, pxeConfig);
  console.log('PXE started');

  // ── Create wallet + register test accounts ─────────────────────────────────
  const wallet = new SimpleWallet(pxe, node);
  const testAccounts = await getInitialTestAccountsData();
  const [userData, operatorData] = testAccounts;

  const userAddress     = await wallet.addSchnorrAccount(userData.secret, userData.salt);
  const operatorAddress = await wallet.addSchnorrAccount(operatorData.secret, operatorData.salt);
  console.log('user:    ', userAddress.toString());
  console.log('operator:', operatorAddress.toString());

  // ── Derive operator Schnorr signing key + public key ─────────────────────
  const schnorr            = new Schnorr();
  const operatorSigningKey = deriveSigningKey(operatorData.secret);
  const operatorPubKey     = await schnorr.computePublicKey(operatorSigningKey);
  console.log('operator pubkey x:', operatorPubKey.x.toString());
  console.log('operator pubkey y:', operatorPubKey.y.toString());

  // ── Load & normalize artifacts ─────────────────────────────────────────────
  const tokenArtifactPath = findArtifact('Token');
  const fpcArtifactPath   = findArtifact('FPC');
  const noopArtifactPath  = findArtifact('Noop');
  console.log('Token artifact:', tokenArtifactPath);
  console.log('FPC artifact:  ', fpcArtifactPath);
  console.log('Noop artifact: ', noopArtifactPath);

  const tokenArtifact = loadContractArtifact(
    JSON.parse(readFileSync(tokenArtifactPath, 'utf8')),
  );
  const fpcArtifact = loadContractArtifact(
    JSON.parse(readFileSync(fpcArtifactPath, 'utf8')),
  );
  const noopArtifact = loadContractArtifact(
    JSON.parse(readFileSync(noopArtifactPath, 'utf8')),
  );

  // ── Deploy Token ───────────────────────────────────────────────────────────
  // constructor_with_minter(name, symbol, decimals, minter, upgrade_authority)
  // userAddress doubles as minter for this profiling run.
  console.log('\nDeploying Token...');
  const tokenDeploy = await Contract.deploy(
    wallet, tokenArtifact,
    ['TestToken', 'TST', 18, userAddress, AztecAddress.ZERO],
    'constructor_with_minter',
  ).send({ from: userAddress });
  const tokenAddress = tokenDeploy.address;
  console.log('Token:', tokenAddress.toString());

  // ── Deploy FPC ─────────────────────────────────────────────────────────────
  // Constructor: (operator, operator_pubkey_x, operator_pubkey_y, accepted_asset)
  console.log('Deploying FPC...');
  const fpcDeploy = await Contract.deploy(
    wallet, fpcArtifact,
    [operatorAddress, operatorPubKey.x, operatorPubKey.y, tokenAddress],
  ).send({ from: userAddress });
  const fpcAddress = fpcDeploy.address;
  console.log('FPC:  ', fpcAddress.toString());

  // ── Deploy Noop (minimal app tx placeholder for profiling) ────────────────
  console.log('Deploying Noop...');
  const noopDeploy = await Contract.deploy(wallet, noopArtifact, []).send({ from: userAddress });
  const noopAddress = noopDeploy.address;
  console.log('Noop: ', noopAddress.toString());

  // ── Contract wrappers for method calls ────────────────────────────────────
  const tokenAsUser  = Contract.at(tokenAddress, tokenArtifact, wallet);
  const noopContract = Contract.at(noopAddress, noopArtifact, wallet);

  // ── Compute gas-dependent charge ───────────────────────────────────────────
  const minFees = await node.getCurrentMinFees();
  const PADDING = 1.5;
  const feeDa = BigInt(Math.ceil(Number(minFees.feePerDaGas) * PADDING));
  const feeL2 = BigInt(Math.ceil(Number(minFees.feePerL2Gas) * PADDING));
  const DA_GAS  = 786432n;
  const L2_GAS  = 6540000n;
  const maxGasCost = feeDa * DA_GAS + feeL2 * L2_GAS;
  const charge     = feeJuiceToAsset(maxGasCost, RATE_NUM, RATE_DEN);

  console.log(`\nfeePerDaGas=${feeDa} feePerL2Gas=${feeL2}`);
  console.log(`max gas cost: ${maxGasCost} | token charge: ${charge}`);

  // ── Mint tokens to user ────────────────────────────────────────────────────
  const mintAmount = charge + 1000n;
  console.log(`\nMinting ${mintAmount} tokens to user...`);
  await tokenAsUser.methods
    .mint_to_private(userAddress, mintAmount)
    .send({ from: userAddress });
  console.log('Minted.');

  // ── Quote signature: operator signs quote hash (inline Schnorr verification in FPC) ─
  const quoteSigFields = await signQuote(
    schnorr, operatorSigningKey, fpcAddress, tokenAddress,
    RATE_NUM, RATE_DEN, VALID_UNTIL, userAddress, QUOTE_DOMAIN_SEP,
  );
  console.log('Quote signature created.');

  // ── Transfer authwit: user authorises FPC to pull `charge` tokens ──────────
  // FPC calls: Token.transfer_private_to_private(user, operator, charge, TX_NONCE)
  const transferAuthWit = await wallet.createAuthWit(userAddress, {
    caller: fpcAddress,
    action: tokenAsUser.methods.transfer_private_to_private(
      userAddress, operatorAddress, charge, TX_NONCE,
    ),
  });
  console.log('Transfer authwit created.');

  // ── Gas settings matching the computed charge ──────────────────────────────
  const gasSettings = GasSettings.default({
    gasLimits:     new Gas(Number(DA_GAS), Number(L2_GAS)),
    maxFeesPerGas: new GasFees(feeDa, feeL2),
  });

  const feePayment = new CustomFPCPaymentMethod(
    fpcAddress, transferAuthWit, quoteSigFields, TX_NONCE, RATE_NUM, RATE_DEN, VALID_UNTIL, gasSettings,
  );

  // ── Profile ────────────────────────────────────────────────────────────────
  console.log('\nProfiling (this takes a few minutes)...');
  const result = await noopContract.methods
    .noop()
    .profile({
      fee: { paymentMethod: feePayment, gasSettings },
      from: userAddress,
      additionalScopes: [operatorAddress],
      profileMode: 'full',
      skipProofGeneration: false,
    });

  // ── Print FPC-only results ──────────────────────────────────────────────────
  printFpcGateTable('fee_entrypoint', result.executionSteps, 'FPC');

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await pxe.stop?.();
  rmSync(PXE_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
