#!/usr/bin/env node
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const CONTRACT_ADDRESS = '0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB';
const DEFAULT_RPC_URL = process.env.PFFT_RPC_URL || process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const ABI = [
  'function freeMint(uint256 powNonce) external',
  'function getInfo() view returns (uint256 currentMinted,uint256 remainingSupply,uint256 currentDecayRate,uint256 nextMintAmount)',
  'function calculateActualMint(uint256 requested) view returns (uint256)',
  'function BASE_MINT_AMOUNT() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function currentPowStage() view returns (uint256)',
  'function currentPowHexZeros() view returns (uint256)',
  'function POW_DIFFICULTY_BITS() view returns (uint256)',
  'function POW_DIFFICULTY_MULTIPLIER() view returns (uint256)',
  'function POW_TARGET() view returns (uint256)',
  'function MIN_MINT_AMOUNT() view returns (uint256)',
  'function currentPowChallenge(address user) view returns (bytes32)',
  'function minted(address user) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)'
];

function usage() {
  console.log(`PFFT miner bot

Usage:
  node pfft-miner.mjs status [--address 0x...]
  node pfft-miner.mjs mine [--count 1] [--workers 4] [--gpu] [--dry-run] [--no-wait-confirm]
  node pfft-miner.mjs selftest

Env:
  PFFT_PRIVATE_KEY   Private key burner wallet for real mint
  PFFT_PRIVATE_KEYS  Optional comma/newline separated private keys for wallet rotation
  PFFT_KEYS_FILE     Optional private key file, default ./wallet-keys.txt if it exists
  PFFT_TX_PER_WALLET Rotate wallet after this many submitted txs, default 100
  PFFT_RPC_URL       Ethereum mainnet RPC URL (default publicnode)
  ETH_RPC_URL        Fallback RPC URL

Options:
  --count N          Number of successful mints, default 1, use 0 for infinite
  --workers N        Parallel CPU workers in this process, default CPU count-ish
  --gpu              Use CUDA solver ./build/pfft-cuda-miner (run make cuda first; rebuild after git pull)
  --cuda-bin PATH    Custom CUDA solver path
  --dry-run          Find valid PoW nonce but do not send transaction
  --max-fee-gwei N   Optional maxFeePerGas override
  --priority-gwei N  Optional maxPriorityFeePerGas override
  --gas-limit N      Gas limit override, default max(estimate*2, 350000)
  --retry-delay-ms N Delay after any mining/tx error, default 1000
  --no-wait-confirm Send tx, do not wait receipt before mining next nonce
  --max-pending N    Max pending txs in --no-wait-confirm mode, default 0 unlimited
  --keys-file PATH   Load private keys from file, default env or ./wallet-keys.txt
  --tx-per-wallet N  Rotate to next wallet after N submitted txs, default 100
  --stop-on-limit    Stop when wallet hits per-address mint limit (default for single wallet)
  --stop-on-error    Exit on first mining/tx error instead of retrying
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (['dry-run', 'help', 'gpu', 'stop-on-error', 'no-wait-confirm', 'stop-on-limit'].includes(key)) { args[key] = true; continue; }
    args[key] = argv[++i];
  }
  return args;
}

function fmtToken(v) {
  return Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtRate(n) {
  if (!Number.isFinite(n)) return '- H/s';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MH/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KH/s`;
  return `${n.toFixed(0)} H/s`;
}
function fmtEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

function provider() {
  return new ethers.JsonRpcProvider(DEFAULT_RPC_URL, 1, { staticNetwork: true });
}
function readContract() {
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, provider());
}
function parseKeyList(raw) {
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

function readKeysFile(path) {
  const raw = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  return parseKeyList(raw);
}

function privateKeys(args = {}) {
  const file = args['keys-file'] || process.env.PFFT_KEYS_FILE || (existsSync('./wallet-keys.txt') ? './wallet-keys.txt' : '');
  let keys = [];
  if (file) {
    if (!existsSync(file)) throw new Error(`Private key file not found: ${file}`);
    keys = readKeysFile(file);
    if (keys.length === 0) throw new Error(`Private key file is empty: ${file}`);
    console.log(`Loaded ${keys.length} private key(s) from ${file}`);
  } else {
    const raw = process.env.PFFT_PRIVATE_KEYS || process.env.PFFT_PRIVATE_KEY || '';
    keys = parseKeyList(raw);
  }
  const seen = new Set();
  keys = keys.filter(k => {
    const norm = k.toLowerCase();
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  if (keys.length === 0) throw new Error('Set PFFT_PRIVATE_KEY/PFFT_PRIVATE_KEYS or create ./wallet-keys.txt. Use burner wallet only.');
  return keys;
}
function walletContract(privateKey) {
  const w = new ethers.Wallet(privateKey, provider());
  return { wallet: w, contract: new ethers.Contract(CONTRACT_ADDRESS, ABI, w) };
}

function randomUint256() {
  return BigInt('0x' + randomBytes(32).toString('hex'));
}
function randomUint64() {
  return randomBytes(8).readBigUInt64BE(0);
}
function powHash(challenge, nonce) {
  // Matches site worker: ethers.solidityPackedKeccak256(['bytes32','uint256'], [challenge, nonce])
  return BigInt(ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [challenge, nonce]));
}
function validPow(challenge, nonce, target) {
  return powHash(challenge, nonce) <= BigInt(target);
}

async function status(address) {
  const c = readContract();
  const [info, base, target, bits, stage, zeros] = await Promise.all([
    c.getInfo(), c.BASE_MINT_AMOUNT(), c.POW_TARGET(), c.POW_DIFFICULTY_BITS(),
    c.currentPowStage().catch(() => null), c.currentPowHexZeros().catch(() => null)
  ]);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`RPC: ${DEFAULT_RPC_URL}`);
  console.log(`Minted: ${fmtToken(info.currentMinted)} PFFT`);
  console.log(`Remaining: ${fmtToken(info.remainingSupply)} PFFT`);
  console.log(`Next mint quote: ${fmtToken(info.nextMintAmount)} PFFT`);
  console.log(`Base request: ${fmtToken(base)} PFFT`);
  console.log(`PoW target: ${target.toString()}`);
  console.log(`Difficulty: ${bits.toString()}-bit${stage !== null ? ` stage ${Number(stage) + 1}/5` : ''}${zeros !== null ? ` hexZeros ${zeros}` : ''}`);
  const expected = Number((2n ** 256n) / (BigInt(target) + 1n));
  console.log(`Expected tries: ${expected.toLocaleString()}`);
  if (address) {
    const [minted, bal, challenge] = await Promise.all([c.minted(address), c.balanceOf(address), c.currentPowChallenge(address)]);
    console.log(`Wallet: ${address}`);
    console.log(`Wallet minted: ${fmtToken(minted)} PFFT`);
    console.log(`Wallet balance: ${fmtToken(bal)} PFFT`);
    console.log(`Current challenge: ${challenge}`);
  }
}

async function findNonce({ challenge, target, workers = 1, reportMs = 2000 }) {
  target = BigInt(target);
  let attempts = 0n;
  let solved = null;
  const started = Date.now();
  const loops = Array.from({ length: workers }, async (_, id) => {
    let local = 0n;
    while (!solved) {
      const nonce = randomUint256();
      local++;
      if ((local & 0x3fffn) === 0n) attempts += 0x4000n;
      if (validPow(challenge, nonce, target)) {
        attempts += local & 0x3fffn;
        solved = { nonce, worker: id };
        return;
      }
      if ((local % 4096n) === 0n) await new Promise(r => setImmediate(r));
    }
  });
  const timer = setInterval(() => {
    const elapsed = Date.now() - started;
    const rate = Number(attempts) / Math.max(elapsed / 1000, 0.001);
    const expected = Number((2n ** 256n) / (target + 1n));
    const eta = rate > 0 ? Math.max(0, (expected - Number(attempts)) / rate * 1000) : NaN;
    process.stdout.write(`\rAttempts ${attempts.toLocaleString()} | ${fmtRate(rate)} | ETA avg ${fmtEta(eta)}   `);
  }, reportMs);
  await Promise.race(loops.map(p => p.then(() => true)));
  clearInterval(timer);
  process.stdout.write('\n');
  return { ...solved, attempts, elapsedMs: Date.now() - started };
}

function uint256Hex(v) {
  let h = BigInt(v).toString(16);
  if (h.length > 64) throw new Error('uint256 too large');
  return '0x' + h.padStart(64, '0');
}

async function findNonceGpu({ challenge, target, bin }) {
  bin ||= process.env.PFFT_CUDA_BIN || './build/pfft-cuda-miner';
  if (!existsSync(bin)) throw new Error(`CUDA solver not found: ${bin}. Build with: make cuda`);
  const targetHex = uint256Hex(target);
  const startNonce = randomUint64();
  console.log(`CUDA solver: ${bin}`);
  console.log(`CUDA start nonce: ${startNonce.toString()}`);
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, [challenge, targetHex, '0', '256', '4096', startNonce.toString()], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`CUDA solver exited ${code}`));
      const line = out.trim().split(/\s+/).pop();
      if (!line || !/^\d+$/.test(line)) return reject(new Error(`CUDA solver returned invalid nonce: ${out}`));
      const nonce = BigInt(line);
      resolve({ nonce, worker: 'cuda', attempts: 0n, elapsedMs: Date.now() - started });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function printStats(stats) {
  console.log(
    `Stats | submitted ${stats.submitted} | success ${stats.confirmed} | failed ${stats.failed} | skipped ${stats.skipped} | errors ${stats.errors} | pending ${stats.pending}`
  );
}

class SkipTxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipTxError';
  }
}

class AddressLimitError extends SkipTxError {
  constructor(message) {
    super(message);
    this.name = 'AddressLimitError';
  }
}

function isAddressLimit(msg) {
  return /Exceed per address limit/i.test(String(msg));
}

async function mine(args) {
  const count = args.count === undefined ? 1 : Number(args.count);
  const workers = args.workers ? Math.max(1, Number(args.workers)) : Math.max(1, Math.min(8, Number(process.env.PFFT_WORKERS || 4)));
  const dryRun = !!args['dry-run'];
  const useGpu = !!args.gpu;
  const retryDelayMs = args['retry-delay-ms'] === undefined ? 1000 : Math.max(0, Number(args['retry-delay-ms']));
  const stopOnError = !!args['stop-on-error'];
  const noWaitConfirm = !!args['no-wait-confirm'];
  const maxPending = args['max-pending'] === undefined ? 0 : Math.max(0, Number(args['max-pending']));
  const keys = privateKeys(args);
  const txPerWallet = args['tx-per-wallet'] === undefined ? Math.max(1, Number(process.env.PFFT_TX_PER_WALLET || 100)) : Math.max(1, Number(args['tx-per-wallet']));
  let walletIndex = 0;
  let { wallet, contract } = walletContract(keys[walletIndex]);
  const limitedWallets = new Set();
  const walletSubmitted = new Map();

  function walletSubmittedCount(address = wallet.address) {
    return walletSubmitted.get(address.toLowerCase()) || 0;
  }

  function markWalletSubmitted(address = wallet.address) {
    const key = address.toLowerCase();
    const next = (walletSubmitted.get(key) || 0) + 1;
    walletSubmitted.set(key, next);
    return next;
  }

  function switchWallet(reason = 'rotate') {
    for (let i = 1; i <= keys.length; i++) {
      const idx = (walletIndex + i) % keys.length;
      const next = walletContract(keys[idx]);
      const nextAddress = next.wallet.address.toLowerCase();
      if (!limitedWallets.has(nextAddress) && walletSubmittedCount(next.wallet.address) < txPerWallet) {
        walletIndex = idx;
        wallet = next.wallet;
        contract = next.contract;
        console.log(`Switch wallet: ${wallet.address} (${walletIndex + 1}/${keys.length}) | reason: ${reason} | tx ${walletSubmittedCount(wallet.address)}/${txPerWallet}`);
        return true;
      }
    }
    return false;
  }

  console.log(`Wallet: ${wallet.address}${keys.length > 1 ? ` (1/${keys.length})` : ''}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Mode: ${dryRun ? 'dry-run (no tx)' : 'real mint'}`);
  console.log(`Confirm wait: ${noWaitConfirm ? `OFF / async receipts${maxPending > 0 ? ` / max pending ${maxPending}` : ''}` : 'ON'}`);
  console.log(`Wallet rotation: ${keys.length} wallet(s) | tx per wallet: ${txPerWallet}`);
  console.log(`Retry: ${stopOnError ? 'stop on error' : `auto-retry after ${retryDelayMs}ms`}`);
  let done = 0;
  let errors = 0;
  const stats = { submitted: 0, confirmed: 0, failed: 0, skipped: 0, errors: 0, pending: 0 };
  const pendingReceipts = new Set();

  function trackReceipt(tx) {
    const p = (async () => {
      try {
        const rcpt = await tx.wait();
        stats.pending--;
        if (rcpt.status === 1) {
          stats.confirmed++;
          console.log(`Mint confirmed: ${tx.hash} block ${rcpt.blockNumber}`);
        } else {
          stats.failed++;
          console.error(`Mint tx failed: ${tx.hash}`);
        }
      } catch (e) {
        stats.pending--;
        stats.failed++;
        console.error(`Receipt failed: ${tx.hash} | ${e.shortMessage || e.reason || e.message || e}`);
      } finally {
        pendingReceipts.delete(p);
        printStats(stats);
      }
    })();
    pendingReceipts.add(p);
  }

  async function waitForPendingSlot() {
    while (maxPending > 0 && pendingReceipts.size >= maxPending) {
      console.log(`Pending tx full (${pendingReceipts.size}/${maxPending}), wait one receipt...`);
      await Promise.race([...pendingReceipts]);
    }
  }

  while (count === 0 || done < count) {
    try {
      const [challenge, target] = await Promise.all([contract.currentPowChallenge(wallet.address), contract.POW_TARGET()]);
      console.log(`\nChallenge: ${challenge}`);
      console.log(`Target: ${target.toString()}`);
      const found = useGpu
        ? await findNonceGpu({ challenge, target, bin: args['cuda-bin'] })
        : await findNonce({ challenge, target, workers });
      const rate = Number(found.attempts) / Math.max(found.elapsedMs / 1000, 0.001);
      console.log(`Solved nonce: ${found.nonce.toString()}`);
      console.log(`Worker: ${found.worker} | Attempts: ${found.attempts.toLocaleString()} | Rate: ${fmtRate(rate)}`);
      if (!validPow(challenge, found.nonce, target)) {
        throw new Error(`Local POW verification failed for nonce ${found.nonce.toString()}`);
      }
      if (dryRun) {
        console.log('Dry-run: transaction not sent.');
        done++;
        errors = 0;
        continue;
      }
      try {
        await contract.freeMint.staticCall(found.nonce, { gasLimit: 1000000n });
        console.log('Preflight: staticCall OK');
      } catch (e) {
        const reason = e.shortMessage || e.reason || e.message || e;
        if (isAddressLimit(reason)) throw new AddressLimitError(`Wallet limit reached: ${wallet.address} | ${reason}`);
        throw new SkipTxError(`Preflight failed, skip tx: ${reason}`);
      }
      const overrides = {};
      if (args['max-fee-gwei']) overrides.maxFeePerGas = ethers.parseUnits(String(args['max-fee-gwei']), 'gwei');
      if (args['priority-gwei']) overrides.maxPriorityFeePerGas = ethers.parseUnits(String(args['priority-gwei']), 'gwei');
      if (args['gas-limit']) {
        overrides.gasLimit = BigInt(args['gas-limit']);
      } else {
        try {
          const estimated = await contract.freeMint.estimateGas(found.nonce);
          overrides.gasLimit = estimated * 2n;
          if (overrides.gasLimit < 350000n) overrides.gasLimit = 350000n;
          console.log(`Gas limit: ${overrides.gasLimit.toString()} (estimate ${estimated.toString()})`);
        } catch (e) {
          const reason = e.shortMessage || e.reason || e.message || e;
          if (isAddressLimit(reason)) throw new AddressLimitError(`Wallet limit reached: ${wallet.address} | ${reason}`);
          throw new SkipTxError(`Gas estimate failed, skip tx: ${reason}`);
        }
      }
      await waitForPendingSlot();
      const txWallet = wallet.address;
      const tx = await contract.freeMint(found.nonce, overrides);
      const sentForWallet = markWalletSubmitted(txWallet);
      stats.submitted++;
      stats.pending++;
      console.log(`Tx sent: ${tx.hash} | wallet ${txWallet} | walletTx ${sentForWallet}/${txPerWallet}`);
      if (noWaitConfirm) {
        trackReceipt(tx);
        done++;
        errors = 0;
        printStats(stats);
        if (sentForWallet >= txPerWallet) {
          limitedWallets.add(txWallet.toLowerCase());
          if (!switchWallet(`tx-per-wallet ${txPerWallet}`)) {
            const rotateMsg = `All ${keys.length} wallet(s) reached tx-per-wallet ${txPerWallet}. Stop mining; add more keys or increase --tx-per-wallet.`;
            console.error(rotateMsg);
            if (pendingReceipts.size > 0) await Promise.allSettled([...pendingReceipts]);
            return;
          }
        }
        continue;
      }
      const rcpt = await tx.wait();
      stats.pending--;
      if (rcpt.status !== 1) {
        stats.failed++;
        throw new Error(`Mint tx failed: ${tx.hash}`);
      }
      stats.confirmed++;
      console.log(`Mint confirmed: block ${rcpt.blockNumber}`);
      done++;
      errors = 0;
      printStats(stats);
      if (sentForWallet >= txPerWallet) {
        limitedWallets.add(txWallet.toLowerCase());
        if (!switchWallet(`tx-per-wallet ${txPerWallet}`)) {
          console.error(`All ${keys.length} wallet(s) reached tx-per-wallet ${txPerWallet}. Stop mining; add more keys or increase --tx-per-wallet.`);
          return;
        }
      }
    } catch (e) {
      errors++;
      const msg = e.shortMessage || e.reason || e.message || String(e);
      if (e instanceof AddressLimitError) {
        limitedWallets.add(wallet.address.toLowerCase());
        console.error(msg);
        if (switchWallet('address limit')) {
          errors = 0;
          printStats(stats);
          continue;
        }
        const limitMsg = `All ${keys.length} wallet(s) reached per-address mint limit. Stop mining; add fresh burner wallet(s) in PFFT_PRIVATE_KEYS.`;
        console.error(limitMsg);
        printStats(stats);
        if (args['stop-on-limit'] || keys.length <= 1 || !stopOnError) throw new Error(limitMsg);
      } else if (e instanceof SkipTxError) {
        stats.skipped++;
        console.error(msg);
      } else {
        stats.errors++;
        console.error(`ERROR #${errors}: ${msg}`);
      }
      printStats(stats);
      if (stopOnError) throw e;
      console.error(`Retry mining again in ${retryDelayMs}ms...`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  if (pendingReceipts.size > 0) {
    console.log(`Waiting ${pendingReceipts.size} pending receipt(s) before exit...`);
    await Promise.allSettled([...pendingReceipts]);
  }
}

async function selftest() {
  const challenge = '0x' + '11'.repeat(32);
  const nonce = 123456789n;
  const h = ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [challenge, nonce]);
  if (powHash(challenge, nonce) !== BigInt(h)) throw new Error('powHash mismatch');
  if (!validPow(challenge, nonce, 2n ** 256n - 1n)) throw new Error('validPow high target failed');
  if (validPow(challenge, nonce, 0n) !== (BigInt(h) === 0n)) throw new Error('validPow zero target failed');
  console.log('selftest ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || (args.help ? 'help' : 'status');
  if (cmd === 'help' || args.help) return usage();
  if (cmd === 'status') return status(args.address || process.env.PFFT_ADDRESS);
  if (cmd === 'mine') return mine(args);
  if (cmd === 'selftest') return selftest();
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch(err => {
  console.error('ERROR:', err.shortMessage || err.reason || err.message || String(err));
  process.exit(1);
});
