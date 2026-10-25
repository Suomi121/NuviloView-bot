import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { denied } from './coordinator.mjs';

export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');
// Systematic (3,2) MDS code: two equal data symbols and their XOR parity.
// This is erasure recovery, NOT encryption or Byzantine error correction.
export function encodeErasure(bytes) {
  const input = Buffer.from(bytes), size = Math.ceil(input.length / 2);
  const a = Buffer.alloc(size), b = Buffer.alloc(size), p = Buffer.alloc(size);
  input.copy(a, 0, 0, size); input.copy(b, 0, size);
  for (let i = 0; i < size; i++) p[i] = a[i] ^ b[i];
  return { length: input.length, checksum: digestBytes(input), shards: [a,b,p], hashes: [a,b,p].map(digestBytes) };
}
export function decodeErasure(manifest, fragments) {
  if (manifest.codec !== 'xor-mds-3-2-v1' || !Number.isSafeInteger(manifest.length) || manifest.length < 0 ||
      !Array.isArray(manifest.hashes) || manifest.hashes.length !== 3 || new Set(fragments.map(s=>s.index)).size !== fragments.length) denied('EC_MANIFEST');
  const valid = fragments.filter(s => [0,1,2].includes(s.index) && Buffer.isBuffer(s.bytes) &&
    s.bytes.length === Math.ceil(manifest.length / 2) && digestBytes(s.bytes) === manifest.hashes[s.index]);
  if (valid.length < 2) denied('EC_INSUFFICIENT_SHARDS');
  const parts = new Map(valid.map(s=>[s.index,s.bytes]));
  if (!parts.has(0) || !parts.has(1)) {
    const missing = parts.has(0) ? 1 : 0, known = parts.get(1-missing), parity = parts.get(2);
    const restored = Buffer.alloc(known.length);
    for (let i=0;i<known.length;i++) restored[i]=known[i]^parity[i];
    if (digestBytes(restored) !== manifest.hashes[missing]) denied('EC_CHECKSUM');
    parts.set(missing,restored);
  }
  const result=Buffer.concat([parts.get(0),parts.get(1)]).subarray(0,manifest.length);
  if(digestBytes(result)!==manifest.checksum)denied('EC_CHECKSUM');
  return result;
}
export function sealArtifact(bytes, { sensitive = false, key = null, keyId = null } = {}) {
  if (!sensitive) return { bytes:Buffer.from(bytes), encryption:null };
  if (!Buffer.isBuffer(key) || key.length!==32 || !/^[a-zA-Z0-9:-]{1,80}$/.test(keyId??'')) denied('EC_ENCRYPTION_REQUIRED');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return {bytes:encrypted,encryption:{algorithm:'aes-256-gcm',keyId,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex')}};
}
export function openArtifact(bytes, encryption, key) {
  if(!encryption)return bytes;
  if(encryption.algorithm!=='aes-256-gcm'||!Buffer.isBuffer(key)||key.length!==32)denied('EC_KEY_REQUIRED');
  try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(encryption.iv,'hex'));d.setAuthTag(Buffer.from(encryption.tag,'hex'));return Buffer.concat([d.update(bytes),d.final()]);}
  catch{denied('EC_DECRYPTION');}
}
