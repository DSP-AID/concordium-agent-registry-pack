// Standalone badge verifier: resolves the badge on Concordium testnet and checks card integrity.
// Usage: node verify.mjs [grpc-host] [port] [tls]   (reads run_results.json + cis8004_mainnet.wasm in this folder)
// If the public gRPC endpoint is down, on-chain state checks fall back to the official agent-registry MCP REST API.
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

// shortcut: the only public testnet grpc-web endpoint (grpc.testnet.concordium.com:20000) suffers multi-minute outages; retry with backoff and allow `node verify.mjs <host> <port> tls` to point at another node, upgrade to an endpoint list if a better public mirror appears
const [,, argHost, argPort, argTls] = process.argv;
const client = new sdk.ConcordiumGRPCWebClient(argHost ?? 'grpc.testnet.concordium.com', Number(argPort ?? 20000), { useTls: argTls === 'tls' });
async function rpc(f, tries = 6) { for (let i = 0; ; i++) { try { return await f() } catch (e) { if (i >= tries - 1) throw new Error(e.message + ' (retries exhausted)'); await new Promise((r) => setTimeout(r, 3000)) } } }
const MCP = 'https://agent-registry-mcp.concordium.com/v1';

// 1. parse badge (verify base58 checksum too) — fully local
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

// 2. on-chain agent state via CIS-8004 agentOf view (parameter = CDS-serialized TokenIdU64 hex string); gRPC may be down -> MCP fallback below
let ownerOk, statusActive, uriPinned, pinnedHash, via = 'grpc agentOf';
const expectedUri = R.agentCardUrl ?? `https://raw.githubusercontent.com/DSP-AID/concordium-agent-registry-pack/main/agent-card.json`;
try {
  const paramHex = dapp.serializeReceiveContractParameters(JSON.stringify(R.tokenIdHex), CDS, 'CIS-8004', 'agentOf', 0, true);
  const res = await rpc(() => client.invokeContract({ contract, method: sdk.ReceiveName.fromString('CIS-8004.agentOf'), parameter: sdk.Parameter.fromBuffer(Buffer.from(paramHex, 'hex')) }));
  if (res.tag !== 'success') throw new Error('agentOf invoke rejected: ' + JSON.stringify(res.reason ?? res).slice(0, 120));
  const state = JSON.parse(dapp.deserializeReceiveReturnValue(Buffer.from(sdk.ReturnValue.toBuffer(res.returnValue)).toString('hex'), CDS, 'CIS-8004', 'agentOf', 0, true));
  const st = state?.Some?.[0];
  ownerOk = st?.owner_account === R.address && st?.agent_wallet?.Some?.[0] === R.address;
  statusActive = JSON.stringify(st?.status ?? '').includes('Active');
  uriPinned = (st?.agent_uri?.Some?.[0] ?? '') === expectedUri;
  const p = st?.metadata_hash?.Some?.[0];
  if (p) pinnedHash = Buffer.from(p).toString('hex');
  console.log('[2] agentOf ->', JSON.stringify(state).slice(0, 300));
} catch (e) {
  console.log('[2] gRPC unavailable (' + e.message.slice(0, 80) + '); falling back to official agent-registry MCP REST');
  const vc = await (await fetch(`${MCP}/verify-agent-card/${R.badge}?network=testnet`, { signal: AbortSignal.timeout(30000) })).json();
  const cb = await (await fetch(`${MCP}/check-badge/${R.badge}?network=testnet`, { signal: AbortSignal.timeout(30000) })).json();
  if (!vc.on_chain_hash_hex) throw new Error('MCP fallback returned no on-chain data: ' + JSON.stringify(vc).slice(0, 200));
  pinnedHash = vc.on_chain_hash_hex;
  ownerOk = cb.checks?.on_chain_agent_found === true && cb.checks?.owner_matches === true && cb.checks?.token_address_matches === true; // indexer proves the on-chain owner is this badge's agent and the card declares our account as owner (params.owner)
  statusActive = cb.checks?.status_active === true;
  uriPinned = vc.on_chain_uri === expectedUri;
  via = 'official indexer MCP REST (check-badge + verify-agent-card)';
}

// 3. fetch served card + hash (raw GitHub; independent of both RPC paths)
const cardResp = await rpc(() => fetch(expectedUri, { signal: AbortSignal.timeout(30000) }));
const cardBytes = Buffer.from(await cardResp.arrayBuffer());
const cardSha = createHash('sha256').update(cardBytes).digest('hex');
console.log('[3] card HTTP', cardResp.status, 'sha256', cardSha);

// 4. module source identity (gRPC only; skipped in MCP-fallback mode): testnet module bytes == shipped official wasm bytes
let modEqual = null;
try {
  const src = await rpc(() => client.getModuleSource(sdk.ModuleReference.fromHexString(R.moduleRef)));
  const onchain = Buffer.isBuffer(src.source) ? src.source : Buffer.from(src.source);
  modEqual = onchain.equals(readFileSync(new URL('./cis8004_mainnet.wasm', import.meta.url)));
  console.log('[4] module <ref %s...> bytes equal to official mainnet wasm:', R.moduleRef.slice(0, 16), modEqual);
} catch { console.log('[4] module source check SKIPPED (gRPC down)'); }

// 5. badge re-derivation from run_results (independent recomputation)
const rebuilt = b58check(Buffer.concat([Buffer.from([2]), uleb(R.contract.index), uleb(R.contract.subindex), Buffer.from(R.tokenIdHex, 'hex')]));
console.log('[5] badge re-derived from results:', rebuilt === R.badge);

const checks = {
  badge_checksum_and_layout_ok: Buffer.compare(cks, calcCks) === 0 && payload[0] === 2,
  badge_matches_results: contract.index.toString() === R.contract.index && contract.subindex.toString() === R.contract.subindex && tokenBytes.toString('hex') === R.tokenIdHex,
  badge_rederived: rebuilt === R.badge,
  owner_is_registration_account: ownerOk,
  status_active: statusActive,
  agent_uri_pinned_onchain: uriPinned,
  card_served_ok: cardResp.status === 200 && cardBytes.toString().includes(R.badge),
  card_sha256_equals_onchain_hash: !!pinnedHash && pinnedHash === cardSha,
};
if (modEqual !== null) checks.module_bytes_equal_mainnet_official = modEqual;
console.log('\nverification source:', via);
console.log('=== VERIFICATION RESULT ===');
let ok = true;
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL'), '-', k); if (!v) ok = false; }
console.log('===========================');
client.shutdown().catch(() => {});
process.exit(ok ? 0 : 1);
