# Serve any Hedera contract as a standardized GraphQL / subgraph endpoint

**The Graph doesn't index Hedera.** This snippet bridges the gap: point at any Hedera contract, get a GraphQL endpoint whose query shape matches a Messari-style standardized subgraph on The Graph. All Graph-native tooling — subgraph MCP servers, playgrounds, GraphiQL, subgraph explorers — works over Hedera contracts unchanged.

## The gap this fills

- Hedera Mirror Node already indexes every contract event on Hedera for free, with sub-second consensus. But it speaks REST/JSON.
- The Graph ecosystem speaks GraphQL and has years of tooling — but doesn't index Hedera. Verified via the [official networks registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json): 129 EVM chains supported, Hedera not among them.

This snippet is the missing glue — a ~200 LOC self-contained adapter that reads Mirror Node and speaks standardized-subgraph GraphQL.

## Run it

```bash
npm install
node index.mjs

# In a second terminal:
curl -sX POST http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ pools { id network totalNav memberCount } transactions(first: 3) { type actor amount } _meta { block { number } deployment } }"}'
```

Default `VAULT_ADDRESS` points at a live ZkWard testnet vault so this runs out-of-the-box with real data. Point at your own contract:

```bash
VAULT_ADDRESS=0xYourContract node index.mjs
```

## What ships in the ERC-4626 preset

Any contract with these two event signatures gets the whole standardized query surface:

```solidity
event Deposited(address indexed member, uint256 amount, uint256 shares);
event Withdrawn(address indexed member, uint256 shares, uint256 amount);
```

Supported queries (identical shape to Messari standardized-vaults):

- `pool(id)` / `pools(first, where)`
- `transactions(first, orderBy, orderDirection, where)`
- `_meta { block, deployment, hasIndexingErrors }`

Storage reads (`totalShares`, `totalAssets`, `memberCount`) come from Mirror Node's `eth_call` bridge — no server-side state.

## Same query, both indexing backends

```bash
# Studio-hosted subgraph (Sepolia example):
curl -sX POST https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1 \
  -H 'content-type: application/json' \
  -d '{"query":"{ pools { id network totalNav } _meta { block { number } deployment } }"}'

# This snippet's endpoint (Hedera):
curl -sX POST http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ pools { id network totalNav } _meta { block { number } deployment } }"}'
```

Same query. Same shape. Different indexing backends. That's the moat: one schema, N backends, N chains.

## Extended library

This snippet bundles the adapter inline as `adapter.mjs` to keep it self-contained. The upstream package with more presets, TypeScript types, and HCS-attestation add-ons lives at:

- Package: [`@zkward/hedera-graphql-adapter`](https://github.com/ZkVanguard/zkward-ethglobal/tree/main/packages/hedera-graphql-adapter)
- Reference deployment: https://www.zkward.com/api/subgraph/hedera
- Related MCP server: [`mcp/zkward-vaults`](https://github.com/ZkVanguard/zkward-ethglobal/tree/main/mcp/zkward-vaults) — Claude Desktop / Cursor tool that queries this shape across multiple backends
