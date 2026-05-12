# PFFT Miner Bot

CLI bot untuk mining/mint `https://pffthash.com/` (Pow Free Fair Mint) di Ethereum mainnet.

- Contract: `0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB`
- PoW: `keccak256(solidityPacked(['bytes32','uint256'], [currentPowChallenge(wallet), nonce])) <= POW_TARGET()`
- Submit: `freeMint(uint256 powNonce)`
- GPU mode: CUDA solver untuk NVIDIA RTX, termasuk 1x RTX 5090.

> Gunakan burner wallet. Jangan commit private key / `.env`.

## Fresh VPS GPU install — 1x RTX 5090

```bash
apt update
apt install -y git curl screen build-essential make
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Cek GPU/CUDA dari image provider
nvidia-smi
nvcc --version || true
```

Kalau `nvcc` belum ada, install CUDA toolkit sesuai image Ubuntu/provider. Di Vast biasanya pilih image CUDA dev/runtime yang sudah ada `nvcc`; kalau belum:

```bash
apt install -y nvidia-cuda-toolkit || true
```

## Clone & install

```bash
cd /root
git clone https://github.com/bibnk/pfft-miner-bot.git
cd pfft-miner-bot
npm install
npm run selftest
```

## Build CUDA solver

```bash
cd /root/pfft-miner-bot
make cuda
# hasil binary:
ls -lh build/pfft-cuda-miner
```

Jika `-arch=native` gagal di nvcc lama, edit `Makefile` ganti:

```makefile
-arch=native
```

menjadi salah satu:

```makefile
-arch=sm_120
```

atau fallback:

```makefile
-gencode arch=compute_120,code=sm_120
```

RTX 5090 / Blackwell butuh CUDA baru. VPS kamu tertulis Max CUDA 13.2, jadi seharusnya cocok.

## Config

Single wallet via env:

```bash
export PFFT_RPC_URL="https://ethereum-rpc.publicnode.com"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"
```

Multi-wallet via file, rekomendasi untuk rotate otomatis:

```bash
cd /root/pfft-miner-bot
cp wallet-keys.example.txt wallet-keys.txt
nano wallet-keys.txt
chmod 600 wallet-keys.txt
```

Isi `wallet-keys.txt` satu private key per baris:

```text
0xPRIVATE_KEY_WALLET_1
0xPRIVATE_KEY_WALLET_2
0xPRIVATE_KEY_WALLET_3
```

Default miner akan baca `./wallet-keys.txt` kalau file itu ada. Bisa juga pilih file custom:

```bash
node pfft-miner.mjs mine --gpu --keys-file /root/pfft-miner-bot/wallet-keys.txt
```

Disarankan pakai RPC premium/low latency, bukan public RPC.

## Cek status

```bash
node pfft-miner.mjs status --address 0xWalletKamu
```

## Dry-run GPU dulu

Cari nonce valid pakai RTX 5090 tapi **tidak kirim transaksi**:

```bash
node pfft-miner.mjs mine --gpu --dry-run --count 1
```

## Real GPU mining / mint

```bash
node pfft-miner.mjs mine --gpu --count 1
```

Mode cepat + auto rotate wallet setiap 100 tx terkirim:

```bash
node pfft-miner.mjs mine --gpu --count 0 --retry-delay-ms 0 --gas-limit 500000 --no-wait-confirm --max-pending 2 --tx-per-wallet 100
```

Kalau wallet sudah 100 tx, log akan seperti:

```text
Switch wallet: 0x... (2/5) | reason: tx-per-wallet 100 | tx 0/100
```

Dengan gas manual:

```bash
node pfft-miner.mjs mine --gpu --count 1 --max-fee-gwei 3 --priority-gwei 0.2 --gas-limit 350000
```

Catatan: kalau muncul `transaction execution reverted` dan receipt `gasUsed == gasLimit`, itu biasanya **out of gas**, bukan nonce salah. Miner sekarang otomatis pakai `max(estimate*2, 350000)`, tapi kamu bisa override:

```bash
node pfft-miner.mjs mine --gpu --count 0 --gas-limit 500000
```

Mint berkali-kali:

```bash
# mint 5x lalu stop
node pfft-miner.mjs mine --gpu --count 5

# infinite loop: mint terus sampai screen/process distop
# kalau error/revert/RPC gagal, otomatis mining ulang
node pfft-miner.mjs mine --gpu --count 0

# retry langsung tanpa delay
node pfft-miner.mjs mine --gpu --count 0 --retry-delay-ms 0
```

Preflight sebelum kirim tx:

- validasi hash nonce lokal
- `staticCall freeMint(nonce)` dulu
- kalau `Duplicate POW nonce`, `Invalid POW`, revert, atau estimate gas gagal → **tidak kirim tx**, langsung mining nonce baru
- CUDA start nonce dibuat random tiap percobaan supaya tidak mengulang nonce lama

```bash
# shortcut npm infinite loop
npm run mine:gpu
```

Helper script infinite loop:

```bash
./start-gpu-loop.sh
```

Atur jumlah mint lewat env:

```bash
PFFT_COUNT=10 ./start-gpu-loop.sh
```

## Run screen infinite GPU

```bash
cd /root/pfft-miner-bot
export PFFT_RPC_URL="RPC_ETH_KAMU"
export PFFT_PRIVATE_KEY="PRIVATE_KEY_BURNER_WALLET"

screen -S pfft -dm bash -lc 'node pfft-miner.mjs mine --gpu --count 0 --retry-delay-ms 0 --gas-limit 500000 2>&1 | tee -a /root/pfft-miner.log'
```

Cek log:

```bash
tail -f /root/pfft-miner.log
```

Attach:

```bash
screen -r pfft
```

Stop:

```bash
screen -S pfft -X quit
```

## CPU fallback

Kalau CUDA build belum siap:

```bash
node pfft-miner.mjs mine --dry-run --count 1 --workers 4
node pfft-miner.mjs mine --count 1 --workers 4
```

## Update VPS

```bash
cd /root/pfft-miner-bot
git pull
npm install
make cuda
npm run selftest
```
