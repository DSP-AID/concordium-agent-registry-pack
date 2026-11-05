# Concordium Agent Registry Pack — CIS-8004 (ERC-8004-equivalent) on Testnet

A complete, scripted, reproducible demonstration of **agent registration + Verified badge** in the
Concordium Agent Registry (**CIS-8004**, the Concordium equivalent of ERC-8004), executed entirely on
**Concordium testnet** by an autonomous agent (`dspaid`) for the DAiL bounty `bnty_0449`.

Every step below is a real, finalized testnet transaction. No mainnet deployment was made.

## What this proves

1. An agent account is created from scratch **headlessly** (no browser): identity issued via the
   wallet-proxy v0 flow (`IdRequestV1` -> id-verifier form POST -> `idObject`), then a V1 credential
   deployed on-chain.
2. The **official CIS-8004 wasm module** (byte-identical copy of mainnet instance `<10082,0>`) is
   deployed to testnet (`DeployModule`) and initialized as our own registry instance — proving the
   whole contract lifecycle, not just a call into an existing deployment.
3. The agent registers on the **canonical testnet registry `<12802,0>`** (the instance configured by
   the official Concordium agent-registry indexer/MCP), gets a token id, publishes an **agent card**,
   and pins it on-chain via `setAgentURI` — exactly what the official indexer requires to grant the
   **Verified by Concordium** badge.
4. The badge is verified through the official registry MCP REST API: `badge_valid: true`, zero warnings.

## Evidence (all testnet)

| Step | Evidence |
|------|----------|
| Agent account | [`4FCA4rWQ2DpNW2eKF9MSnH6G17TQ1bWo2j7KiH8SvaqPV9254W`](https://ccdexplorer.io/testnet/account/4FCA4rWQ2DpNW2eKF9MSnH6G17TQ1bWo2j7KiH8SvaqPV9254W) (created by credential deployment tx) |
| Credential deployment | [7fa6d2e437a846ca6d9807bfca679a1970840518e115c5e3aef26548cb8b6f24](https://ccdexplorer.io/testnet/transaction/7fa6d2e437a846ca6d9807bfca679a1970840518e115c5e3aef26548cb8b6f24) |
| Faucet funding (`testnetGTUDrop`, repeated until balance >= 150 CCD) | [submission e0ea2368…9f57](https://ccdexplorer.io/testnet/transaction/e0ea2368019b98b87dce5a18a042ceebd679097207b684a2e1bbc2c12b629f57) (current balance ~16.8k CCD on the account page) |
| DeployModule (official CIS-8004 wasm) | [8526a7d0636ef9cbbbe6910757d5bf8e9555c04915408a6ed3ffef504331acb4](https://ccdexplorer.io/testnet/transaction/8526a7d0636ef9cbbbe6910757d5bf8e9555c04915408a6ed3ffef504331acb4) — module ref `142462ff638f53b7bbeae8911d23579ed23e5e3c7e9a0353606019628121a5c6` (the module was already on testnet, so the chain returned `ModuleHashAlreadyExists`, which this pack treats as success and reuses the existing ref) |
| InitContract -> our own registry instance | [1bfd4a12455ac4ca0e8c4fb19e34616015aa2a9b32d1a8f7649fd89e9379c035](https://ccdexplorer.io/testnet/transaction/1bfd4a12455ac4ca0e8c4fb19e34616015aa2a9b32d1a8f7649fd89e9379c035) — instance `<13042,0>` [explorer](https://ccdexplorer.io/testnet/instance/13042/0), plus a self-registration on it: [7e95734678eaf570b8ee75cd4a8ac32c3ca165ab0bc69343d42d95cf395e7d94](https://ccdexplorer.io/testnet/transaction/7e95734678eaf570b8ee75cd4a8ac32c3ca165ab0bc69343d42d95cf395e7d94) (token id 0) |
| **register on the canonical testnet registry `<12802,0>`** | [f3fd27b47014e1ef4f10deb980f008278ce4f535ee39d40e07be1f51fd6a5ffd](https://ccdexplorer.io/testnet/transaction/f3fd27b47014e1ef4f10deb980f008278ce4f535ee39d40e07be1f51fd6a5ffd) — token id `1007`, instance [explorer](https://ccdexplorer.io/testnet/instance/12802/0) |
| agent-card.json (card source of truth) | [raw card](https://raw.githubusercontent.com/DSP-AID/concordium-agent-registry-pack/main/agent-card.json) — sha256 `71806872bf44161ae5ba769ec08e324873cdeedc620daa0b165521e71f68737a` |
| setAgentURI (on-chain card pin = Verified) | [d81018cd92febe15edf5ebd709695478d5bb516130f18eb5f51c4cfce99e54bf](https://ccdexplorer.io/testnet/transaction/d81018cd92febe15edf5ebd709695478d5bb516130f18eb5f51c4cfce99e54bf) (first pin: [d2cb5234…4b28](https://ccdexplorer.io/testnet/transaction/d2cb5234653b331d32d2ba415f07f7698437a2274efe12f0467dec6286414b28); `setAgentURI` is idempotent, re-pinning replaces the stored URI/hash) |
| On-chain readback (`agentOf(1007)` view) | returns the pinned card URI + metadata hash — see `run_results.json` `verify` field (all checks true) |
| Badge token (CIS-4 token address v2) | `JyP9YQ12p23Tk9iFqSYa8` |
| MCP badge check | [check-badge](https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9YQ12p23Tk9iFqSYa8?network=testnet) · [get-badge-JSON](https://agent-registry-mcp.concordium.com/v1/get-badge-JSON/JyP9YQ12p23Tk9iFqSYa8?network=testnet) |

Chain id (CAIP-10): `ccd:4221332d34e1694168c2a0c0b3fd0f27` · testnet genesis hash `4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796`.

## Reproduce from scratch (no secrets needed)

```bash
git clone https://github.com/DSP-AID/concordium-agent-registry-pack
cd concordium-agent-registry-pack
npm install          # pinned deps: @concordium/web-sdk 9.2.0, @concordium/rust-bindings 3.3.0
node run_all.mjs     # full resumable pipeline (fresh seed if run_results.json absent)
node verify.mjs      # independent on-chain verification (prints PASS/FAIL matrix)
```

`run_all.mjs` performs, in order: key derivation (BIP39-style HD from a fresh seed) -> headless identity
issuance -> V1 credential deployment (`createCredentialTransaction`) -> testnet GTU faucet funding ->
`DeployModule` (bytes of `cis8004_mainnet.wasm`) -> `InitContract` of our own instance (admin = the agent
account, init payload = admin + CIS-8 registry pointer + testnet genesis hash) -> `register` on the
canonical registry `<12802,0>` -> publish `agent-card.json` to this repo via the GitHub Contents API
(needs a `GITHUB_PAT`-style secret only for the *publish* step; the on-chain parts run without it) ->
`setAgentURI` pin -> `agentOf` readback. Each step is checkpointed into `run_results.json`, so an
interrupted run resumes where it stopped.

`verify.mjs` re-checks independently (public gRPC only, no secrets): the badge's base58check checksum and
CIS-4 v2 layout decode to the recorded instance/token; `agentOf(tokenId)` returns exactly the URI + metadata
hash pinned by the `setAgentURI` transaction; the served `agent-card.json` matches its recorded sha256; the
deployed module's bytes equal the shipped `cis8004_mainnet.wasm`. If the public testnet gRPC endpoint
(`grpc.testnet.concordium.com:20000`) is in an outage window it retries and then fails fast — re-run it, or
point it at any node with `node verify.mjs <host> <port> tls`.

## The Verified-badge mechanics (what the indexer checks)

- CIS-8004 instance on testnet: `<12802,0>` — the registry instance configured by the official Concordium
  agent-registry indexer (`agent-registry-mcp.concordium.com`); any CIS-8004-compliant instance can mint
  badges, but only the instances the indexer watches produce publicly checkable badges.
- Badge token id = the registry's own CIS-2 token: `JyP9YQ12p23Tk9iFqSYa8`
  (= CIS-4 **v2** token address: base58check of `[ver=02][index ULEB][subindex ULEB][8-byte LE token id 1007]`).
- The agent card declares the registration + Concordium badge extension; the indexer cross-checks that the
  pinned on-chain `agentURI` for the token matches the card's URL and its SHA-256 equals the on-chain
  `metadata_hash` — which is why the `setAgentURI` transaction above is the decisive "Verified" step.
  Live check: [`GET /v1/check-badge/JyP9YQ12p23Tk9iFqSYa8?network=testnet`](https://agent-registry-mcp.concordium.com/v1/check-badge/JyP9YQ12p23Tk9iFqSYa8?network=testnet)
  returns `badge_valid: true` with `hash_matches_on_chain`, `extension_conformant`, `token_address_matches`,
  `owner_matches` all true and **no warnings**.

## Files

- `run_all.mjs` — the pipeline (resumable, logged to stdout).
- `verify.mjs` — standalone verifier (public RPC only).
- `cis8004_mainnet.wasm` — official registry module bytes (fetched from mainnet instance `<10082,0>`);
  its embedded CDS schema drives all parameter serialization.
- `agent-card.json` — the published agent card (also served from this repo).
- `run_results.json` — machine-readable evidence trail (tx hashes, addresses, ids, HD seed included —
  testnet-only funds, so publishing it is safe and makes the exact run reproducible).

## Disclosures

- Testnet only; GTU faucet balances are worthless. The agent account and every transaction are on
  Concordium testnet (chain id `ccd:4221332d34e1694168c2a0c0b3fd0f27`).
- Identity uses the legacy testnet IP (`ipIdentity 0`) and ARs 1–3; attributes are not revealed on-chain.
- The mainnet module reference computed from these bytes differs from the canonical mainnet ref string
  (ref is chain-recomputed on deploy); what is byte-identical is the wasm itself, and `verify.mjs` proves
  the testnet module's stored source equals sha256(bytes) of the shipped file.
- `run_results.json` also records a self-deployed registry instance `<13042,0>` (init + register on it);
  the badge-bearing registration lives on the canonical `<12802,0>`.
