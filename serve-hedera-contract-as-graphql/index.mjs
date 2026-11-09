// serve-hedera-contract-as-graphql
//
// Minimal Express server that exposes ANY Hedera contract as a
// standardized GraphQL / subgraph endpoint. Query shape matches
// Messari's standardized subgraphs on The Graph — so the same query
// works against a Studio-hosted subgraph AND this endpoint unchanged.
//
// Why: The Graph doesn't index Hedera (as of 2026-09; 129 EVM chains
// supported, Hedera not among them). Hedera Mirror Node already indexes
// every contract event. This snippet bridges the two so all Graph-native
// tooling (subgraph MCP servers, playgrounds, GraphiQL) works over
// Hedera contracts without waiting for native support.
//
// Run:
//   npm install
//   node index.mjs
//   curl -sX POST http://localhost:4000/graphql \
//     -H 'content-type: application/json' \
//     -d '{"query":"{ pools { id network totalNav memberCount } transactions(first: 3) { type actor amount } _meta { block { number } deployment } }"}'
//
// Point it at your own vault by setting VAULT_ADDRESS. Default is
// ZkWard's live testnet vault so this snippet is runnable out of the box.

import express from 'express';
import { createHederaGraphQLAdapter } from './adapter.mjs';

const NETWORK = process.env.HEDERA_NETWORK || 'testnet'; // 'testnet' | 'mainnet'
const VAULT = process.env.VAULT_ADDRESS || '0xe7E6fEDce9d72D112137B631E8D51831D30729A9';

const adapter = createHederaGraphQLAdapter({
  network: NETWORK,
  contract: VAULT,
});

const app = express();
app.use(express.json());

app.post('/graphql', async (req, res) => {
  const result = await adapter.execute({
    query: req.body.query,
    variables: req.body.variables,
    operationName: req.body.operationName,
  });
  res.json(result);
});

app.get('/graphql/sdl', (_req, res) => {
  res.type('text/plain').send(adapter.getSchemaSDL());
});

app.get('/', (_req, res) => {
  res.json({
    endpoint: 'hedera-graphql-adapter',
    network: NETWORK,
    vault: VAULT,
    graphql: 'POST /graphql',
    schema: 'GET /graphql/sdl',
    example: 'curl -sX POST /graphql -d {"query":"{ pools { id totalNav memberCount } }"}',
  });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`hedera-graphql-adapter live on http://localhost:${port}`);
  console.log(`  vault: ${VAULT}`);
  console.log(`  network: ${NETWORK}`);
  console.log(`  try: curl -sX POST http://localhost:${port}/graphql -H 'content-type: application/json' -d '{"query":"{ pools { id totalNav } _meta { block { number } } }"}'`);
});
