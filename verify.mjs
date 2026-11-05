// Standalone badge verifier: resolves the badge on Concordium testnet and checks card integrity.
// Usage: node verify.mjs   (reads run_results.json + cis8004_mainnet.wasm in this folder)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import * as dapp from '@concordium/rust-bindings/dapp';

const R = JSON.parse(readFileSync(new URL('./run_results.json', import.meta.url), 'utf8'));

function extractCds() {
  const b = readFileSync(new URL('./cis8004_mainnet.wasm', import.meta.url));
  function u(buf, off) { let r = 0, s = 0, i = off; while (true) { const x = buf[i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return [r, i]; }
  let off = 8;
  while (off < b.length) {
    const id = b[off]; const [size, p] = u(b, off + 1); const end = p + size;
    if (id === 0) { const [nlen, q] = u(b, p); if (b.slice(q, q + nlen).toString('utf8') === 'concordium-schema') return b.slice(q + nlen, end).toString('hex'); }
    off = end;
  }
  throw new Error('no concordium-schema section in wasm');
}
const CDS = extractCds();

function uleb(n) { const out = []; let v = BigInt(n); while (true) { const b = Number(v & 0x7fn); v >>= 7n; if (v !== 0n) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); }
function ulebRead(buf, off) { let n = 0n, sh = 0n, i = off; while (true) { const x = buf[i++]; n |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7n; } return [n, i]; }

// CIS-4 token address v2: base58check([ver=02][index ULEB][subindex ULEB][token bytes])
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) { let n = 0n; for (const c of s) { const d = B58A.indexOf(c); if (d < 0) throw new Error('bad base58 char'); n = n * 58n + BigInt(d); } let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex; let z = 0; for (const c of s) { if (c === '1') z++; else break; } return Buffer.concat([Buffer.alloc(z), Buffer.from(hex, 'hex')]); }
function b58encode(buf) { let n = 0n; for (const x of buf) n = (n << 8n) | BigInt(x); let out = ''; while (n > 0n) { out = B58A[Number(n % 58n)] + out; n /= 58n; } for (const x of buf) { if (x === 0) out = '1' + out; else break; } return out; }
function b58check(payload) { const c = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4); return b58encode(Buffer.concat([payload, c])); }

// shortcut: the only public testnet grpc-web endpoint (grpc.testnet.concordium.com:20000) suffers multi-minute outages; retry with backoff and allow `node verify.mjs <host> <port> [tls]` to point at another node, upgrade to an endpoint list if a better public mirror appears
const [,, argHost, argPort, argTls] = process.argv;
const client = new sdk.ConcordiumGRPCWebClient(argHost ?? 'grpc.testnet.concordium.com', Number(argPort ?? 20000), { useTls: argTls === 'tls' });
async function rpc(f, tries = 8) { for (let i = 0; ; i++) { try { return await f() } catch (e) { if (i >= tries - 1) throw new Error(e.message + ' (all retries exhausted; the public testnet gRPC endpoint may be in an outage window, re-run or pass another node host/port)'); await new Promise((r) => setTimeout(r, 4000)) } } }

// 1. parse badge (verify base58 checksum too)
const raw = b58decode(R.badge);
const payload = raw.subarray(0, raw.length - 4), cks = raw.subarray(raw.length - 4);
const calcCks = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
if (Buffer.compare(cks, calcCks) !== 0) { console.error('[1] badge base58check checksum INVALID'); process.exit(1); }
if (payload[0] !== 2) { console.error('[1] badge version byte != 2'); process.exit(1); }
const [bIdx, p2] = ulebRead(payload, 1);
const [bSub, p3] = ulebRead(payload, p2);
const tokenBytes = payload.subarray(p3); // CIS-8004 badges carry the fixed 8-byte TokenIdU64 here
const contract = { index: bIdx, subindex: bSub };
console.log('[1] badge decodes (checksum OK, v2) to contract <%s,%s>, token bytes %s', contract.index, contract.subindex, tokenBytes.toString('hex'));

// 2. on-chain agent state via CIS-8004 agentOf view (parameter = CDS-serialized TokenIdU64 hex string)
const paramHex = dapp.serializeReceiveContractParameters(JSON.stringify(R.tokenIdHex), CDS, 'CIS-8004', 'agentOf', 0, true);
const res = await rpc(() => client.invokeContract({ contract, method: sdk.ReceiveName.fromString('CIS-8004.agentOf'), parameter: sdk.Parameter.fromBuffer(Buffer.from(paramHex, 'hex')) }));
if (res.tag !== 'success') { console.error('[2] agentOf invoke failed:', JSON.stringify(res.reason ?? res).slice(0, 200)); process.exit(1); }
const state = JSON.parse(dapp.deserializeReceiveReturnValue(Buffer.from(sdk.ReturnValue.toBuffer(res.returnValue)).toString('hex'), CDS, 'CIS-8004', 'agentOf', 0, true));
const sj = JSON.stringify(state);
console.log('[2] agentOf ->', sj.slice(0, 300));

// 3. fetch served card + hash
const cardUrl = R.agentCardUrl ?? `https://raw.githubusercontent.com/DSP-AID/concordium-agent-registry-pack/main/agent-card.json`;
const cardResp = await rpc(() => fetch(cardUrl, { signal: AbortSignal.timeout(30000) }));
const cardBytes = Buffer.from(await cardResp.arrayBuffer());
const cardSha = createHash('sha256').update(cardBytes).digest('hex');
console.log('[3] card HTTP', cardResp.status, 'sha256', cardSha);

// 4. module source identity: testnet module bytes == downloaded official mainnet wasm bytes
const modRef = sdk.ModuleReference.fromHexString(R.moduleRef);
const src = await rpc(() => client.getModuleSource(modRef));
const onchain = Buffer.isBuffer(src.source) ? src.source : Buffer.from(src.source);
const local = readFileSync(new URL('./cis8004_mainnet.wasm', import.meta.url));
console.log('[4] module <ref %s...> bytes equal to official mainnet wasm:', R.moduleRef.slice(0, 16), onchain.equals(local));

// 5. badge re-derivation from run_results (independent recomputation)
const rebuilt = b58check(Buffer.concat([Buffer.from([2]), uleb(R.contract.index), uleb(R.contract.subindex), Buffer.from(R.tokenIdHex, 'hex')]));
console.log('[5] badge re-derived from results:', rebuilt === R.badge);

const checks = {
  badge_checksum_and_layout_ok: Buffer.compare(cks, calcCks) === 0 && payload[0] === 2,
  badge_matches_results: contract.index.toString() === R.contract.index && contract.subindex.toString() === R.contract.subindex && tokenBytes.toString('hex') === R.tokenIdHex,
  badge_rederived: rebuilt === R.badge,
  owner_is_registration_account: sj.includes(R.address),
  status_active: /"Active"|active/i.test(sj),
  agent_uri_pinned_onchain: sj.includes('raw.githubusercontent.com'),
  card_served_ok: cardResp.status === 200 && cardBytes.toString().includes(R.badge),
  card_sha256_equals_onchain_hash: (() => { const p = state?.Some?.[0]?.metadata_hash?.Some?.[0]; return !!p && Buffer.from(p).toString('hex') === cardSha; })(),
  module_bytes_equal_mainnet_official: onchain.equals(local),
};
console.log('\n=== VERIFICATION RESULT ===');
let ok = true;
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL'), '-', k); if (!v) ok = false; }
console.log('===========================');
client.shutdown().catch(() => {});
process.exit(ok ? 0 : 1);
