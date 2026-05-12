#!/usr/bin/env node
import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  node pfft-miner.mjs mine [--count 1] [--workers 4] [--gpu] [--dry-run]
  node pfft-miner.mjs selftest

Env:
  PFFT_PRIVATE_KEY   Private key burner wallet for real mint
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
  --stop-on-error    Exit on first mining/tx error instead of retrying
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (['dry-run', 'help', 'gpu', 'stop-on-error'].includes(key)) { args[key] = true; continue; }
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
function walletContract() {
  const pk = process.env.PFFT_PRIVATE_KEY;
  if (!pk) throw new Error('Set PFFT_PRIVATE_KEY for mine command. Use burner wallet only.');
  const w = new ethers.Wallet(pk, provider());
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

async function mine(args) {
  const count = args.count === undefined ? 1 : Number(args.count);
  const workers = args.workers ? Math.max(1, Number(args.workers)) : Math.max(1, Math.min(8, Number(process.env.PFFT_WORKERS || 4)));
  const dryRun = !!args['dry-run'];
  const useGpu = !!args.gpu;
  const retryDelayMs = args['retry-delay-ms'] === undefined ? 1000 : Math.max(0, Number(args['retry-delay-ms']));
  const stopOnError = !!args['stop-on-error'];
  const { wallet, contract } = walletContract();
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Mode: ${dryRun ? 'dry-run (no tx)' : 'real mint'}`);
  console.log(`Retry: ${stopOnError ? 'stop on error' : `auto-retry after ${retryDelayMs}ms`}`);
  let done = 0;
  let errors = 0;
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
        throw new Error(`Preflight failed, skip tx: ${e.shortMessage || e.reason || e.message || e}`);
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
          throw new Error(`Gas estimate failed, skip tx: ${e.shortMessage || e.reason || e.message || e}`);
        }
      }
      const tx = await contract.freeMint(found.nonce, overrides);
      console.log(`Tx sent: ${tx.hash}`);
      const rcpt = await tx.wait();
      if (rcpt.status !== 1) throw new Error(`Mint tx failed: ${tx.hash}`);
      console.log(`Mint confirmed: block ${rcpt.blockNumber}`);
      done++;
      errors = 0;
    } catch (e) {
      errors++;
      const msg = e.shortMessage || e.reason || e.message || String(e);
      console.error(`ERROR #${errors}: ${msg}`);
      if (stopOnError) throw e;
      console.error(`Retry mining again in ${retryDelayMs}ms...`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
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
