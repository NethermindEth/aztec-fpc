import pino from "pino";
import { getSchnorrAccountContractAddress } from '@aztec/accounts/schnorr';
import { Fr } from '@aztec/aztec.js/fields';

const pinoLogger = pino();

const secret = Fr.fromHexString('0x1111111111111111111111111111111111111111111111111111111111111111');
const addr0 = await getSchnorrAccountContractAddress(secret, Fr.ZERO);
const addr1 = await getSchnorrAccountContractAddress(secret, Fr.ONE);
const addr2 = await getSchnorrAccountContractAddress(secret, new Fr(2n));
pinoLogger.info('salt0', addr0.toString());
pinoLogger.info('salt1', addr1.toString());
pinoLogger.info('salt2', addr2.toString());
