import { getSchnorrAccountContractAddress } from '@aztec/accounts/schnorr';
import { Fr } from '@aztec/aztec.js/fields';

const secret = Fr.fromHexString('0x1111111111111111111111111111111111111111111111111111111111111111');
const addr0 = await getSchnorrAccountContractAddress(secret, Fr.ZERO);
const addr1 = await getSchnorrAccountContractAddress(secret, Fr.ONE);
const addr2 = await getSchnorrAccountContractAddress(secret, new Fr(2n));
console.log('salt0', addr0.toString());
console.log('salt1', addr1.toString());
console.log('salt2', addr2.toString());
