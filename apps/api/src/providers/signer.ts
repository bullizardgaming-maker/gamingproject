import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { Signature, TypedDataEncoder, Wallet, computeAddress, getBytes, hexlify, recoverAddress, type TypedDataDomain, type TypedDataField } from 'ethers';

/**
 * Signs the EIP-712 escrow terms the contract checks on every deposit. Whoever holds
 * this key can approve deposits with any fee or recipient, so in production it
 * lives in a KMS/HSM and never leaves it: the API only asks the KMS to sign digests.
 */
export interface EscrowSigner {
  readonly kind: 'local' | 'aws_kms';
  address(): Promise<string>;
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string>;
}

/** Private key held in process memory (development, tests). */
export class LocalKeySigner implements EscrowSigner {
  readonly kind = 'local';
  private wallet: Wallet;
  constructor(privateKey: string) {
    this.wallet = new Wallet(privateKey);
  }
  async address() {
    return this.wallet.address;
  }
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>) {
    return this.wallet.signTypedData(domain, types, value);
  }
}

// secp256k1 group order; Ethereum only accepts the low-s form of a signature.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Minimal DER reader for an ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error('bad DER signature');
  };
  const len = () => {
    let l = der[i++]!;
    if (l & 0x80) {
      const n = l & 0x7f;
      l = 0;
      for (let k = 0; k < n; k++) l = (l << 8) | der[i++]!;
    }
    return l;
  };
  const int = () => {
    expect(0x02);
    const l = len();
    const v = BigInt(hexlify(der.subarray(i, i + l)));
    i += l;
    return v;
  };
  expect(0x30);
  len();
  return { r: int(), s: int() };
}

/** The uncompressed public key is the last 65 bytes of the SubjectPublicKeyInfo KMS returns. */
export function publicKeyFromSpki(spki: Uint8Array): string {
  const point = spki.subarray(spki.length - 65);
  if (point[0] !== 0x04) throw new Error('expected an uncompressed secp256k1 public key');
  return hexlify(point);
}

type KmsLike = Pick<KMSClient, 'send'>;

/**
 * AWS KMS asymmetric key (key spec ECC_SECG_P256K1, usage SIGN_VERIFY). KMS returns a DER
 * signature without a recovery id, so we normalise s and find v by recovering the address.
 */
export class AwsKmsSigner implements EscrowSigner {
  readonly kind = 'aws_kms';
  private cached?: string;
  constructor(
    private readonly keyId: string,
    private readonly kms: KmsLike = new KMSClient({}),
  ) {}

  async address() {
    if (!this.cached) {
      const res = await this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
      if (res.KeySpec && res.KeySpec !== 'ECC_SECG_P256K1') throw new Error(`KMS key ${this.keyId} is ${res.KeySpec}, expected ECC_SECG_P256K1`);
      this.cached = computeAddress(publicKeyFromSpki(res.PublicKey!));
    }
    return this.cached;
  }

  async signDigest(digest: string): Promise<string> {
    const res = await this.kms.send(new SignCommand({ KeyId: this.keyId, Message: getBytes(digest), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
    let { r, s } = parseDerSignature(res.Signature!);
    if (s > N / 2n) s = N - s;
    const hex32 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
    const address = await this.address();
    for (const v of [27, 28]) {
      const sig = Signature.from({ r: hex32(r), s: hex32(s), v });
      if (recoverAddress(digest, sig) === address) return sig.serialized;
    }
    throw new Error('KMS signature does not match the key’s address');
  }

  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>) {
    return this.signDigest(TypedDataEncoder.hash(domain, types, value));
  }
}
