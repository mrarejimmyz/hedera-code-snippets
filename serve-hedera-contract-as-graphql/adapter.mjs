// Standalone adapter (single-file version of @zkward/hedera-graphql-adapter).
// Source: https://github.com/ZkVanguard/zkward-ethglobal/tree/main/packages/hedera-graphql-adapter
// Bundled here so this snippet is `npm install && node index.mjs` ready.

import { buildSchema, execute, parse, validate } from 'graphql';

// ─── Mirror Node client ────────────────────────────────────────────────────
const MIRROR_HOSTS = {
  testnet: 'https://testnet.mirrornode.hedera.com/api/v1',
  mainnet: 'https://mainnet.mirrornode.hedera.com/api/v1',
};

async function mirrorFetch(base, path) {
  const r = await fetch(base + path);
  if (!r.ok) return null;
  return r.json();
}

// ─── Precomputed event topic0 hashes (ERC-4626 preset) ─────────────────────
// keccak256(utf8Bytes("EventName(argTypes)"))
const ERC4626_TOPICS = {
  Deposited: '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca',
  Withdrawn: '0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6',
};

// SimpleUsdcVault-style auto-getter selectors (fallback to ERC-20 totalSupply)
const ERC4626_SELECTORS = {
  totalShares: '0x3a98ef39',
  totalSupply: '0x18160ddd',
  totalAssets: '0x01e1d114',
  memberCount: '0x11aee380',
};

function topicToAddress(topic) {
  if (!topic) return '0x' + '0'.repeat(40);
  return '0x' + topic.slice(-40).toLowerCase();
}

function decodeUint(data, wordOffset = 0) {
  if (!data || data === '0x') return 0n;
  const chunk = data.slice(2 + wordOffset * 64, 2 + (wordOffset + 1) * 64);
  return chunk ? BigInt('0x' + chunk) : 0n;
}

function decodeUint256Response(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex.length > 66 ? '0x' + hex.slice(2, 66) : hex);
}

async function readViewUint(base, address, selector, fallback) {
  const call = async (sel) => {
    const r = await fetch(`${base}/contracts/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: address, data: sel, estimate: false }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result;
  };
  const primary = await call(selector);
  if (primary && primary !== '0x') return decodeUint256Response(primary);
  if (fallback) {
    const alt = await call(fallback);
    if (alt && alt !== '0x') return decodeUint256Response(alt);
  }
  return 0n;
}

// ─── Standardized schema (mirrors Messari) ─────────────────────────────────
const TYPEDEFS = /* GraphQL */ `
  scalar BigInt
  scalar Bytes
  enum OrderDirection { asc, desc }
  enum TxType { DEPOSIT, WITHDRAW, OTHER }
  type Pool {
    id: Bytes!
    network: String!
    totalShares: BigInt!
    totalNav: BigInt!
    sharePrice: BigInt!
    memberCount: Int!
    totalFeesCollected: BigInt!
    createdAtBlock: BigInt!
    createdAtTimestamp: BigInt!
    updatedAtBlock: BigInt
    updatedAtTimestamp: BigInt
  }
  type Transaction {
    id: Bytes!
    pool: Pool!
    type: TxType!
    actor: Bytes!
    amount: BigInt!
    shares: BigInt!
    sharePrice: BigInt!
    blockNumber: BigInt!
    timestamp: BigInt!
    transactionHash: Bytes!
  }
  type _Block_ { number: Int! timestamp: Int }
  type _Meta_ { block: _Block_! deployment: String! hasIndexingErrors: Boolean! }
  input Pool_filter { id: Bytes network: String }
  input Transaction_filter { type: TxType actor: Bytes }
  type Query {
    pool(id: Bytes!): Pool
    pools(first: Int = 10, where: Pool_filter): [Pool!]!
    transactions(first: Int = 25, orderBy: String, orderDirection: OrderDirection, where: Transaction_filter): [Transaction!]!
    _meta: _Meta_
  }
`;

// ─── Adapter factory ───────────────────────────────────────────────────────
export function createHederaGraphQLAdapter({ network, contract, mirrorNodeBase }) {
  const base = mirrorNodeBase || MIRROR_HOSTS[network];
  const vault = contract.toLowerCase();
  const networkLabel = `hedera-${network}`;
  const DECIMALS = 6n;
  const ONE = 10n ** DECIMALS;

  async function fetchPool() {
    const meta = await mirrorFetch(base, `/contracts/${vault}`);
    if (!meta) return null;
    const [totalShares, totalAssets, memberCount] = await Promise.all([
      readViewUint(base, vault, ERC4626_SELECTORS.totalShares, ERC4626_SELECTORS.totalSupply),
      readViewUint(base, vault, ERC4626_SELECTORS.totalAssets),
      readViewUint(base, vault, ERC4626_SELECTORS.memberCount),
    ]);
    const sharePrice = totalShares === 0n ? ONE : (totalAssets * ONE) / totalShares;
    return {
      id: vault,
      network: networkLabel,
      totalShares: totalShares.toString(),
      totalNav: totalAssets.toString(),
      sharePrice: sharePrice.toString(),
      memberCount: Number(memberCount),
      totalFeesCollected: '0',
      createdAtBlock: '0',
      createdAtTimestamp: '0',
      updatedAtBlock: null,
      updatedAtTimestamp: String(Math.floor(Date.now() / 1000)),
    };
  }

  async function fetchTransactions(limit, filter = {}) {
    const params = new URLSearchParams({ order: 'desc', limit: String(Math.min(limit * 3, 100)) });
    const r = await mirrorFetch(base, `/contracts/${vault}/results/logs?${params}`);
    const rows = [];
    for (const log of r?.logs ?? []) {
      const topic0 = (log.topics[0] || '').toLowerCase();
      let type = null;
      if (topic0 === ERC4626_TOPICS.Deposited) type = 'DEPOSIT';
      else if (topic0 === ERC4626_TOPICS.Withdrawn) type = 'WITHDRAW';
      if (!type) continue;
      if (filter.type && filter.type !== type) continue;
      const actor = topicToAddress(log.topics[1]);
      if (filter.actor && filter.actor.toLowerCase() !== actor) continue;
      const [w0, w1] = [decodeUint(log.data, 0), decodeUint(log.data, 1)];
      const amount = type === 'DEPOSIT' ? w0 : w1;
      const shares = type === 'DEPOSIT' ? w1 : w0;
      const tsSec = parseInt((log.timestamp || '0').split('.')[0], 10);
      rows.push({
        id: `${log.transaction_hash}-${log.index}`,
        pool: vault,
        type,
        actor,
        amount: amount.toString(),
        shares: shares.toString(),
        sharePrice: '0',
        blockNumber: String(log.block_number),
        timestamp: String(tsSec),
        transactionHash: log.transaction_hash,
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  const resolvers = {
    Query: {
      pool: async (_r, args) => (args.id.toLowerCase() === vault ? fetchPool() : null),
      pools: async (_r, args) => {
        if (args.where?.id && args.where.id.toLowerCase() !== vault) return [];
        if (args.where?.network && args.where.network !== networkLabel) return [];
        const p = await fetchPool();
        return p ? [p].slice(0, args.first ?? 10) : [];
      },
      transactions: async (_r, args) => fetchTransactions(args.first ?? 25, args.where),
      _meta: async () => {
        const txs = await fetchTransactions(1).catch(() => []);
        return {
          block: { number: txs[0] ? Number(txs[0].blockNumber) : 0, timestamp: Math.floor(Date.now() / 1000) },
          deployment: `hedera-mirror-adapter:${vault}`,
          hasIndexingErrors: false,
        };
      },
    },
    Transaction: { pool: async () => fetchPool() },
  };

  const schema = buildSchema(TYPEDEFS);
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const t = schema.getType(typeName);
    if (!t || !t.getFields) continue;
    const tf = t.getFields();
    for (const [k, fn] of Object.entries(fields)) if (tf[k]) tf[k].resolve = fn;
  }

  return {
    async execute({ query, variables, operationName }) {
      const doc = parse(query);
      const errs = validate(schema, doc);
      if (errs.length) return { errors: errs.map((e) => ({ message: e.message })) };
      const r = await execute({ schema, document: doc, variableValues: variables, operationName });
      return { data: r.data, errors: r.errors?.map((e) => ({ message: e.message })) };
    },
    getSchemaSDL: () => TYPEDEFS,
  };
}
