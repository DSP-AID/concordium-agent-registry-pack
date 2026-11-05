// Concordium CIS-8004 agent registration on testnet — full pipeline (resumable).
// Steps: seed -> headless ID issuance -> credential deployment -> funding -> deploy official CIS-8004 wasm
//        -> init instance -> register agent -> GitHub card publish -> setAgentURI pin -> verify.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as sdk from '@concordium/web-sdk';
import * as dapp from '@concordium/rust-bindings/dapp';

const WP = 'https://wallet-proxy.testnet.concordium.com';
const GRPC = 'https://grpc.testnet.concordium.com';
const REDIRECT = 'https://wallet.testnet.concordium.com/callback';
const EXPLORER = (h) => `https://ccdexplorer.io/testnet/transaction/${h}`;
const GH_PAT = readFileSync('C:/workspace/earn/.secrets', 'utf8').match(/github_pat=(\S+)/)[1];
const GH_OWNER = 'DSP-AID';
const GH_REPO = 'concordium-agent-registry-pack';

const client = new sdk.ConcordiumGRPCWebClient(GRPC, 20000);
const RES_FILE = new URL('./run_results.json', import.meta.url);
const R = existsSync(RES_FILE) ? JSON.parse(readFileSync(RES_FILE, 'utf8')) : {};
// migrate tx hashes stored as branded objects -> base58 strings
const bufOf = (h) => { const b = h.buffer; if (!b) return Buffer.from(Object.values(h)); if (Array.isArray(b.data)) return Buffer.from(b.data); return Buffer.from(Object.values(b).filter((v) => typeof v === 'number')); };
for (const k of ['credTx', 'deployTx', 'initTx', 'registerTx', 'pinTx']) if (R[k] && typeof R[k] === 'object') R[k] = sdk.TransactionHash.toHexString(bufOf(R[k]));
const save = () => writeFileSync(RES_FILE, JSON.stringify(R, null, 1));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// Canonical CIS-8004 testnet registry <12802,0> is the one configured on agent-registry-mcp (the official
// "Verified by Concordium" explorer). Migrate state: registration targets the canonical instance;
// our self-initialized <13042,0> (same module) stays recorded as deployment evidence in contractSelf.
if (R.contract && R.contract.index === '13042' && !R.contractSelf) {
  R.contractSelf = { index: '13042', subindex: '0' };
  R.contract = { index: '12802', subindex: '0' };
  if (R.registerTx) R.selfRegisterTx = R.registerTx; // successful register on our own instance (evidence)
  delete R.registerTx; delete R.tokenId; delete R.tokenIdHex; delete R.agentState;
  save(); log('switched registration target to canonical testnet registry <12802,0>');
}

// ---------- helpers ----------
function uleb(n) { const out = []; let v = BigInt(n); while (true) { const b = Number(v & 0x7fn); v >>= 7n; if (v !== 0n) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); }
const tokParam = (tid) => { const b = Buffer.alloc(9); b[0] = 0; b.writeBigUInt64LE(BigInt(tid), 1); return b; }; // CIS-2 TokenId::Number: variant tag 00 + u64 LE
// CIS-4 token address (badge) v2: [ver=02][index ULEB][subindex ULEB][token bytes]; double-sha256 checksum.
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) { let n = 0n; for (const x of buf) n = (n << 8n) | BigInt(x); let out = ''; while (n > 0n) { out = B58A[Number(n % 58n)] + out; n /= 58n; } for (const x of buf) { if (x === 0) out = '1' + out; else break; } return out; }
function b58check(payload) { const c = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4); return b58encode(Buffer.concat([payload, c])); }
async function finalizeStep(hash, label) {
  const h = typeof hash === 'string' ? sdk.TransactionHash.fromHexString(hash) : hash;
  for (let i = 0; i < 25; i++) {
    const s = await client.waitForTransactionFinalization(h, 15000).catch((e) => { if (i === 24) throw e; return null; });
    if (s) {
      const j = JSON.stringify(s, (_k, v) => typeof v === 'bigint' ? String(v) : v);
      writeFileSync(new URL(`./tmp_sum_${label}.json`, import.meta.url), j);
      const status = s.outcome?.status ?? s.summary?.tag;
      log(label, 'finalized', JSON.stringify(s.outcome ?? {}).slice(0, 120));
      return { summary: s, json: j };
    }
  }
  throw new Error(label + ' not finalized');
}
function findInJson(j, re) { const m = j.match(re); return m ? m[1] : null; }
function failedOf(json) { const m = json.match(/"transactionType":"failed".*?"rejectReason":\{"tag":"(\w+)","contents":"?([^"}]*)"?/); return m ? { tag: m[1], contents: m[2] } : null; }
function assertOk(json, label, allow = []) {
  const f = failedOf(json);
  if (f && !allow.includes(f.tag)) throw new Error(`${label} rejected on-chain: ${f.tag} ${f.contents}`);
  return f;
}

// CDS schema extracted from official wasm (downloaded from mainnet <10082,0>)
function extractCds() {
  const b = readFileSync(new URL('./cis8004_mainnet.wasm', import.meta.url));
  function u(buf, off) { let r = 0, s = 0, i = off; while (true) { const x = buf[i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return [r, i]; }
  let off = 8;
  while (off < b.length) {
    const id = b[off]; const [size, p] = u(b, off + 1); const end = p + size;
    if (id === 0) { const [nlen, q] = u(b, p); if (b.slice(q, q + nlen).toString('utf8') === 'concordium-schema') return b.slice(q + nlen, end).toString('hex'); }
    off = end;
  }
  throw new Error('no concordium-schema section');
}
const CDS = extractCds();
const serInit = (json) => Buffer.from(dapp.serializeInitContractParameters(JSON.stringify(json), CDS, 'CIS-8004', 0, true), 'hex');
const serRecv = (fn, json) => Buffer.from(dapp.serializeReceiveContractParameters(JSON.stringify(json), CDS, 'CIS-8004', fn, 0, true), 'hex');
const deRecvRet = (fn, bytes) => JSON.parse(dapp.deserializeReceiveReturnValue(Buffer.from(sdk.ReturnValue.toBuffer(bytes)).toString('hex'), CDS, 'CIS-8004', fn, 0, true));

async function sendTx(tx, signer) {
  const sig = await sdk.signTransaction(tx, signer);
  return sdk.TransactionHash.toHexString(await client.sendAccountTransaction(tx, sig));
}
async function accountTx(type, payload, signer, energy) {
  const addr = sdk.AccountAddress.fromBase58(R.address);
  const nfo = await client.getNextAccountNonce(addr);
  const nonce = nfo.seqNumber ?? nfo.nonce;
  const header = { expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)), nonce, sender: addr };
  const tx = { type, header, payload: { ...payload, maxContractExecutionEnergy: energy ? sdk.Energy.create(BigInt(energy)) : undefined } };
  if (!energy) delete tx.payload.maxContractExecutionEnergy;
  return sendTx(tx, signer);
}

// ---------- step 1: seed ----------
if (!R.seed) {
  R.seed = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('hex');
  save(); log('seed generated');
}
const wallet = sdk.ConcordiumHdWallet.fromHex(R.seed, 'Testnet');
const signingKey = wallet.getAccountSigningKey(0, 0, 0).toString('hex'); // ip0, identity0, credential counter 0

// ---------- step 2: headless ID issuance ----------
if (!R.idObject) {
  const provs = await (await fetch(WP + '/v1/ip_info')).json();
  const p0 = provs.find((x) => x.ipInfo?.ipIdentity === 0);
  const gp = await client.getCryptographicParameters();
  const ars = []; for await (const a of client.getAnonymityRevokers()) ars.push(a);
  const arsInfos = Object.fromEntries(ars.map((a) => [String(a.arIdentity), a]));
  R.arsUsed = Object.keys(arsInfos);
  const idReq = sdk.createIdentityRequest({ ipInfo: p0.ipInfo, globalContext: gp, arsInfos, arThreshold: ars.length, seed: R.seed, net: 'Testnet', identityIndex: 0 });
  let url = p0.metadata.issuanceStart + '?' + new URLSearchParams({ scope: 'identity', response_type: 'code', redirect_uri: REDIRECT, state: JSON.stringify({ idObjectRequest: idReq }) });
  let verifierPage = null;
  for (let hop = 0; hop < 6 && !verifierPage; hop++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (r.status === 200) { verifierPage = url; break; }
    const loc = r.headers.get('location') ?? '';
    if (loc) url = loc.startsWith('http') ? loc : new URL(loc, url).toString(); else break;
  }
  if (!verifierPage) throw new Error('no verifier page');
  const page = await (await fetch(verifierPage)).text();
  const fields = {};
  for (const m of page.matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name && !['fail', 'submit', 'expiry'].includes(name)) fields[name] = value;
  }
  fields.expiry = '2030-12';
  const postUrl = new URL(/action="([^"]+)"/.exec(page)[1], verifierPage).toString();
  const post = await fetch(postUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(30000) });
  let codeUri = null; let next = post.headers.get('location');
  for (let hop = 0; hop < 6 && !codeUri; hop++) {
    if (!next) break;
    const m = decodeURIComponent(next).match(/code_uri=(https?:\/\/[^\s&#]+)/);
    if (m) { codeUri = m[1]; break; }
    const r2 = await fetch(next.startsWith('http') ? next : new URL(next, postUrl), { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    next = r2.headers.get('location');
  }
  if (!codeUri) throw new Error('no code_uri after form POST');
  R.codeUri = codeUri; save();
  for (let i = 0; i < 10; i++) {
    const s = await (await fetch(codeUri, { signal: AbortSignal.timeout(15000) })).json().catch(() => ({ status: 'pending' }));
    if (s.status === 'done') { R.idObject = s.token.identityObject; break; }
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  if (!R.idObject) throw new Error('identity object not issued in time');
  save(); log('ID issued (idObject v' + R.idObject.v + ')');
}

// ---------- step 3: credential deployment ----------
if (!R.credTx) {
  const provs = await (await fetch(WP + '/v1/ip_info')).json();
  const p0 = provs.find((x) => x.ipInfo?.ipIdentity === 0);
  const gp = await client.getCryptographicParameters();
  const ars = []; for await (const a of client.getAnonymityRevokers()) ars.push(a);
  const arsInfos = Object.fromEntries(ars.map((a) => [String(a.arIdentity), a]));
  const expiry = sdk.TransactionExpiry.fromDate(new Date(Date.now() + 60 * 60 * 1000)); // long window: funding loop runs before send
  // V1 credential: idObject must be the unwrapped value; legacy IP needs ipRealName for the V1 wasm
  const cdt = sdk.createCredentialTransaction({ ipInfo: { ...p0.ipInfo, ipRealName: p0.ipInfo.ipDescription?.name ?? 'Concordium testnet identity provider' }, globalContext: gp, arsInfos, idObject: R.idObject.value ?? R.idObject, revealedAttributes: [], credNumber: 0, seedAsHex: R.seed, net: 'Testnet', identityIndex: 0 }, expiry);
  const sig = await sdk.signCredentialTransaction(cdt, signingKey);
  const payload = sdk.serializeCredentialDeploymentPayload([sig], cdt);
  R.credId = cdt.unsignedCdi.values?.credId ?? cdt.unsignedCdi.credId;
  R.address = sdk.AccountAddress.toBase58(sdk.getAccountAddress(R.credId));
  save(); log('account (pre-computed from credId):', R.address);
  R.credTx = sdk.TransactionHash.toHexString(await client.sendCredentialDeploymentTransaction(payload, expiry));
  save(); log('credential deployment sent', R.credTx);
  await finalizeStep(R.credTx, 'cred');
  await fundUntilReady(); // GTU drop only works once the account exists on-chain
}
if (!R.address) {
  await finalizeStep(R.credTx, 'cred');
  if (R.credId) R.address = sdk.getAccountAddress(R.credId);
  else {
    const cs = await (await fetch(WP + '/v1/accountAddress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: R.credTx }) })).json().catch(() => null);
    if (cs?.accountAddress) R.address = cs.accountAddress;
    else {
      const sj = readFileSync(new URL('./tmp_sum_cred.json', import.meta.url), 'utf8');
      const m = sj.match(/"accountAddress":\s*\\?"?([1-9A-HJ-NP-Za-km-z]{30,60})"?/) || sj.match(/"address":\s*\\?"?([1-9A-HJ-NP-Za-km-z]{30,60})"?/);
      if (!m) throw new Error('cannot derive address; inspect tmp_sum_cred.json');
      R.address = m[1];
    }
  }
  save(); log('account:', R.address);
}

// ---------- step 4: funding via testnet GTU drop ----------
async function balance() {
  const info = await client.getAccountInfo(sdk.AccountAddress.fromBase58(R.address)).catch(() => null);
  if (!info) return 0n;
  const micro = info.accountAmount ?? info.accountBalance?.microCcdAmount ?? info.balance?.balance?.microCcdAmount ?? 0n;
  if (typeof micro === 'bigint') return micro;
  const s = String(micro);
  if (s.includes('.')) { const [i, f = ''] = s.split('.'); return BigInt(i || '0') * 1000000n + BigInt((f + '000000').slice(0, 6)); }
  return BigInt(s);
}
async function fundUntilReady() {
  while (await balance() < 150_000_000n) { // >= 150 CCD
    const r = await fetch(`${WP}/v0/testnetGTUDrop/${R.address}`, { method: 'PUT', signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!j.submissionId) { log('drop response unexpected:', JSON.stringify(j).slice(0, 200)); break; }
    R.drops = [...(R.drops ?? []), j.submissionId]; save();
    log('GTU drop sent', j.submissionId);
    await finalizeStep(j.submissionId, 'drop' + R.drops.length).catch(() => null);
  }
  log('balance CCD:', Number(await balance()) / 1e6);
}
await fundUntilReady();

// ---------- shared signer ----------
const signer = sdk.buildBasicAccountSigner(signingKey);
const genesis = findInJson(JSON.stringify(await client.getConsensusStatus(), (_k, v) => typeof v === 'bigint' ? String(v) : v), /"genesisBlock":"?([0-9a-f]{64})"?/) || R.genesisHash;
R.chainId = genesis.slice(0, 32); save();

// ---------- step 5: deploy official CIS-8004 module ----------
if (!R.moduleRef) {
  const wasmBytes = readFileSync(new URL('./cis8004_mainnet.wasm', import.meta.url));
  const h = await accountTx(sdk.AccountTransactionType.DeployModule, { version: 1, source: new Uint8Array(wasmBytes) }, signer);
  R.deployTx = h; save(); log('DeployModule sent', h);
  const { json } = await finalizeStep(h, 'deploy');
  const f = assertOk(json, 'DeployModule', ['ModuleHashAlreadyExists']);
  R.moduleRef = f?.tag === 'ModuleHashAlreadyExists' ? f.contents : findInJson(json, /"moduleDeployed":"?([0-9a-f]{64})"?/);
  if (!R.moduleRef) throw new Error('cannot extract module ref from deploy summary');
  save(); log('module ref:', R.moduleRef, f ? '(already existed on-chain)' : '');
}

// ---------- step 6: init instance ----------
if (!R.contract) {
  const initJson = { admin: R.address, cis8_contract: { index: Number(R.cis8Index ?? 10081), subindex: 0 }, genesis_hash: [...Buffer.from(genesis, 'hex')] };
  const param = serInit(initJson);
  const addr = sdk.AccountAddress.fromBase58(R.address);
  const nfo = await client.getNextAccountNonce(addr);
  const nonce = nfo.seqNumber ?? nfo.nonce;
  const tx = {
    type: sdk.AccountTransactionType.InitContract,
    header: { expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)), nonce, sender: addr },
    payload: {
      amount: sdk.CcdAmount.zero(),
      moduleRef: sdk.ModuleReference.fromHexString(R.moduleRef),
      initName: sdk.ContractName.fromString('CIS-8004'),
      maxContractExecutionEnergy: sdk.Energy.create(5000n),
      param: sdk.Parameter.fromBuffer(param),
    },
  };
  const h = await sendTx(tx, signer);
  R.initTx = h; save(); log('InitContract sent', h, 'param hex:', param.toString('hex'));
  const { json } = await finalizeStep(h, 'init');
  assertOk(json, 'InitContract');
  const idx = findInJson(json, /"address":\{?"index":"?(\d+)"?/) ?? findInJson(json, /"contractAddress":\{?"index":"?(\d+)"?/);
  if (!idx) throw new Error('cannot parse instance address from init summary');
  R.contract = { index: idx, subindex: '0' }; save(); log('instance:', JSON.stringify(R.contract));
}

// ---------- step 7: register agent ----------
const contractProto = { index: BigInt(R.contract.index), subindex: 0n };
const CN = sdk.ContractName.fromString('CIS-8004');
if (!R.tokenId) {
  const cardUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/main/agent-card.json`;
  const regSumFile = new URL('./tmp_sum_register.json', import.meta.url);
  // reuse a finalized successful register if its summary is already on disk (idempotent resume)
  let reused = false;
  if (R.registerTx && existsSync(regSumFile)) {
    const prev = readFileSync(regSumFile, 'utf8');
    reused = prev.includes(R.registerTx) && /"events":\["(?:fe|f0|f5)08[0-9a-f]{16}/.test(prev);
  }
  if (!reused) {
    const regJson = { agent_uri: { Some: [cardUrl] }, metadata_hash: { None: null }, external_reference: { None: null }, initial_metadata: [] };
    const h = await accountTx(sdk.AccountTransactionType.Update, {
      amount: sdk.CcdAmount.zero(),
      address: contractProto,
      receiveName: sdk.ReceiveName.fromString('CIS-8004.register'),
      message: sdk.Parameter.fromBuffer(serRecv('register', regJson)),
    }, signer, 5000n);
    R.registerTx = h; save(); log('register sent', h);
    { const { json } = await finalizeStep(h, 'register'); assertOk(json, 'register'); }
  } else log('reusing finalized register tx', R.registerTx);
  // Extract the exact minted token from the register tx events (CIS-8004 mints 8-byte TokenIdU64;
  // each custom event embeds it as [u8 len=08][8 bytes]). Anchor on the events array to avoid hex-hash false hits.
  const sumJ = readFileSync(regSumFile, 'utf8');
  if (!sumJ.includes(R.registerTx)) throw new Error('register summary does not match registerTx; aborting');
  const tm = sumJ.match(/"events":\["(?:fe|f0|f5)08([0-9a-f]{16})/);
  if (!tm) throw new Error('minted token not found in register events; inspect tmp_sum_register.json');
  R.tokenIdHex = tm[1];
  R.tokenId = String(Buffer.from(tm[1], 'hex').readBigUInt64LE(0));
  save();
  log('registered token_id:', R.tokenId, '(hex', R.tokenIdHex + ') on <' + R.contract.index + ',' + R.contract.subindex + '>');
}

// ---------- step 8: badge (CIS-4 v2 token address) ----------
const badge = b58check(Buffer.concat([Buffer.from([2]), uleb(R.contract.index), uleb(R.contract.subindex), Buffer.from(R.tokenIdHex, 'hex')]));
R.badge = badge; save(); log('badge:', badge);

// ---------- step 9: GitHub repo + agent card ----------
async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, { ...opts, headers: { Authorization: `token ${GH_PAT}`, 'User-Agent': 'dspaid', Accept: 'application/vnd.github+json', ...(opts.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(30000) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
if (!R.repoUrl) {
  let repo = await gh(`/repos/${GH_OWNER}/${GH_REPO}`);
  if (repo.status === 404) {
    repo = await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name: GH_REPO, owner: GH_OWNER, private: false, description: 'Concordium testnet CIS-8004 agent registry registration pack (bounty bnty_0449)' }) });
    if (![201, 422].includes(repo.status)) throw new Error('repo create failed: ' + JSON.stringify(repo.json).slice(0, 300));
  }
  R.repoUrl = `https://github.com/${GH_OWNER}/${GH_REPO}`; save(); log('repo:', R.repoUrl);
}
function buildCard() {
  // Prefer the official extension/registration objects returned by the Concordium agent-registry MCP
  // (get-badge-JSON) — verbatim embedding is what badge-check conformance expects.
  let mcpBadge = null;
  try { mcpBadge = JSON.parse(R.mcp?.badgeJson?.body ?? ''); } catch { /* truncated on first runs */ }
  const fallbackExtension = {
    uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1',
    description: 'Verified by Concordium badge - on-chain agent identity in a CIS-8004 registry',
    required: false,
    params: {
      tokenAddress: `ccd:${R.chainId}/cis-2:${badge}`,
      owner: { account: `ccd:${R.chainId}:${R.address}` },
      contracts: { cis8004: `ccd:${R.chainId}:${R.contract.index}.${R.contract.subindex}`, cis8: `ccd:${R.chainId}:12801.0` },
      verify: 'Resolve tokenAddress via CIS-8004 agent_of; confirm owner + status is Active + card SHA-256 equals metadata_hash.',
    },
  };
  return {
    name: 'DSP-AID Testnet Agent',
    description: 'Autonomous agent (OpenCode / DSP-AID) with on-chain identity registered in the Concordium CIS-8004 Agent Registry on testnet. Demonstrates the Verified by Concordium badge flow.',
    version: '1.0.0',
    url: 'https://github.com/DSP-AID',
    protocolVersion: '0.3.0',
    preferredTransport: 'JSON-RPC',
    capabilities: { extensions: [mcpBadge?.extension ?? fallbackExtension] },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'general-automation', name: 'General automation agent', description: 'Executes arbitrary developer/research tasks autonomously.', tags: ['a2a', 'autonomy'] }],
    registrations: [mcpBadge?.registrations_entry ?? { agentId: Number(R.tokenId), agentRegistry: `ccd:${R.chainId}:${R.contract.index}.${R.contract.subindex}` }],
  };
}
// Publish the card and ensure raw.githubusercontent serves EXACTLY these bytes (re-upload if stale).
{
  const want = JSON.stringify(buildCard(), null, 2);
  writeFileSync(new URL('./agent-card.json', import.meta.url), want);
  const rawUrl = R.repoUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/agent-card.json';
  let served = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) });
  let text = served.status === 200 ? await served.text() : null;
  if (text !== want) {
    let sha = null;
    const cur = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/agent-card.json`);
    if (cur.status === 200) sha = cur.json.sha;
    const put = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/agent-card.json`, { method: 'PUT', body: JSON.stringify({ message: 'chore: publish agent card with Concordium badge (testnet registration)', content: Buffer.from(want).toString('base64'), ...(sha ? { sha } : {}) }) });
    if (![200, 201].includes(put.status) && !(put.status === 422 && String(put.json?.message).includes('no changes'))) throw new Error('card upload failed: ' + JSON.stringify(put.json).slice(0, 300));
    log('card uploaded/updated');
    for (let i = 0; i < 10 && text !== want; i++) { await new Promise((r) => setTimeout(r, 2000)); served = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) }); text = served.status === 200 ? await served.text() : null; }
  }
  if (text !== want) throw new Error('card not yet served correctly');
  R.cardServedOk = true;
  R.cardSha = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  save(); log('served card sha256:', R.cardSha);
}

// ---------- step 10: setAgentURI (pin uri + hash); repin only when the on-chain hash differs ----------
{
  let pinnedHash = null;
  try {
    const cur = await client.invokeContract({ contract: contractProto, method: sdk.ReceiveName.fromString('CIS-8004.agentOf'), parameter: sdk.Parameter.fromBuffer(serRecv('agentOf', R.tokenIdHex)) });
    if (cur.tag === 'success') { const s0 = deRecvRet('agentOf', cur.returnValue)?.Some?.[0]; if (s0?.metadata_hash?.Some?.[0]) pinnedHash = Buffer.from(s0.metadata_hash.Some[0]).toString('hex'); }
  } catch { /* fresh state */ }
  if (pinnedHash !== R.cardSha || !R.pinTx) {
    // metadata_hash Some wraps the fixed [u8;32] in a newtype struct => double-nested array in CDS JSON.
    const pinJson = { token_id: R.tokenIdHex, agent_uri: { Some: [`https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/main/agent-card.json`] }, metadata_hash: { Some: [[...Buffer.from(R.cardSha, 'hex')]] } };
    const h = await accountTx(sdk.AccountTransactionType.Update, {
      amount: sdk.CcdAmount.zero(),
      address: contractProto,
      receiveName: sdk.ReceiveName.fromString('CIS-8004.setAgentURI'),
      message: sdk.Parameter.fromBuffer(serRecv('setAgentURI', pinJson)),
    }, signer, 5000n);
    if (R.pinTx) { R.pinTxHistory = [...(R.pinTxHistory ?? [R.pinTx]), h]; } R.pinTx = h; save(); log('setAgentURI sent', h, '(repin, on-chain was', pinnedHash ?? 'none');
    { const { json } = await finalizeStep(h, 'pin'); assertOk(json, 'setAgentURI'); }
  } else log('on-chain metadata_hash already equals served card sha; no repin needed');
}

// ---------- step 11: verify on-chain ----------
{
  const res = await client.invokeContract({ contract: contractProto, method: sdk.ReceiveName.fromString('CIS-8004.agentOf'), parameter: sdk.Parameter.fromBuffer(serRecv('agentOf', R.tokenIdHex)) });
  if (res.tag !== 'success') throw new Error('agentOf failed post-pin');
  const st = deRecvRet('agentOf', res.returnValue);
  R.agentState = st;
  const j = JSON.stringify(st);
  const pinned = st?.Some?.[0]?.metadata_hash?.Some?.[0];
  R.verify = {
    owner_ok: j.includes(R.address),
    status_active: /"Active"|active/i.test(j),
    uri_pinned: j.includes('raw.githubusercontent.com'),
    hash_pinned: !!pinned && Buffer.from(pinned).toString('hex') === R.cardSha,
  };
  save(); log('verify:', JSON.stringify(R.verify));
}

// ---------- step 12: MCP explorer evidence (official "Verified by Concordium" service) ----------
{
  const MCP = 'https://agent-registry-mcp.concordium.com';
  const grab = async (p) => { try { const r = await fetch(`${MCP}${p}`, { signal: AbortSignal.timeout(20000) }); return { url: `${MCP}${p}`, status: r.status, body: (await r.text()).slice(0, 8000) }; } catch (e) { return { url: `${MCP}${p}`, status: 'ERR', body: String(e.message).slice(0, 150) }; } };
  R.mcp = {
    checkBadge: await grab(`/v1/check-badge/${badge}?network=testnet`),
    badgeJson: await grab(`/v1/get-badge-JSON/${badge}?network=testnet`),
    verifyCard: await grab(`/v1/verify-agent-card/${badge}?network=testnet`),
  };
  save(); log('mcp:', 'check', R.mcp.checkBadge.status, '| badge-json', R.mcp.badgeJson.status, '| verify-card', R.mcp.verifyCard.status);
}

// ---------- step 13: link checks ----------
R.links = {};
for (const [k, h] of Object.entries({ credTx: R.credTx, deployTx: R.deployTx, initTx: R.initTx, registerTx: R.registerTx, pinTx: R.pinTx, ...(Object.fromEntries((R.drops ?? []).map((h2, i) => ['drop' + (i + 1), h2]))) })) {
  const r = await fetch(EXPLORER(h), { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch(() => null);
  R.links[k] = { url: EXPLORER(h), status: r?.status ?? 'ERR' };
}
R.agentCardUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/main/agent-card.json`;
save();
log('DONE. badge:', badge, '| contract:', JSON.stringify(R.contract), '| links:', JSON.stringify(Object.fromEntries(Object.entries(R.links).map(([k, v]) => [k, v.status]))));
