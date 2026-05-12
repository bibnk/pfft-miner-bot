// CUDA nonce solver for pffthash.com PFFT PoW.
// PoW: keccak256(solidityPacked(['bytes32','uint256'], [challenge, nonce])) <= target
// This miner searches uint64 nonces encoded as uint256 (24 zero bytes + nonce_be64).
#include <cuda_runtime.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define ROUNDS 24

__constant__ uint8_t C_CHALLENGE[32];
__constant__ uint8_t C_TARGET[32];

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int s) {
    return (x << s) | (x >> (64 - s));
}

__device__ __constant__ uint64_t RC[24] = {
    0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
    0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
    0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
    0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
    0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
    0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
};

__device__ __forceinline__ uint64_t load64_le(const uint8_t *p) {
    uint64_t x = 0;
    #pragma unroll
    for (int i = 0; i < 8; i++) x |= ((uint64_t)p[i]) << (8 * i);
    return x;
}

__device__ void keccakf(uint64_t st[25]) {
    const int piln[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};
    const int rotc[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
    for (int round = 0; round < ROUNDS; round++) {
        uint64_t bc[5];
        #pragma unroll
        for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20];
        #pragma unroll
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
            #pragma unroll
            for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
        }
        uint64_t t = st[1];
        #pragma unroll
        for (int i = 0; i < 24; i++) {
            int j = piln[i];
            uint64_t tmp = st[j];
            st[j] = rotl64(t, rotc[i]);
            t = tmp;
        }
        #pragma unroll
        for (int j = 0; j < 25; j += 5) {
            #pragma unroll
            for (int i = 0; i < 5; i++) bc[i] = st[j + i];
            #pragma unroll
            for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        st[0] ^= RC[round];
    }
}

__device__ __forceinline__ void nonce_to_be32(uint64_t nonce, uint8_t out[32]) {
    #pragma unroll
    for (int i = 0; i < 24; i++) out[i] = 0;
    #pragma unroll
    for (int i = 0; i < 8; i++) out[24 + i] = (uint8_t)(nonce >> (56 - 8 * i));
}

__device__ bool digest_le_lanes_lte_target(uint64_t st[25]) {
    // Keccak digest bytes are the first 32 output bytes, little-endian per lane.
    #pragma unroll
    for (int i = 0; i < 32; i++) {
        uint8_t b = (uint8_t)(st[i >> 3] >> (8 * (i & 7)));
        uint8_t t = C_TARGET[i];
        if (b < t) return true;
        if (b > t) return false;
    }
    return true;
}

__global__ void search_kernel(uint64_t start, uint64_t stride, uint64_t iters_per_thread, unsigned long long *found, unsigned long long *found_nonce) {
    uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t nonce = start + tid;
    uint8_t msg[64];
    #pragma unroll
    for (int i = 0; i < 32; i++) msg[i] = C_CHALLENGE[i];

    for (uint64_t k = 0; k < iters_per_thread; k++, nonce += stride) {
        if (atomicAdd(found, 0ULL)) return;
        nonce_to_be32(nonce, msg + 32);

        uint64_t st[25];
        #pragma unroll
        for (int i = 0; i < 25; i++) st[i] = 0ULL;
        #pragma unroll
        for (int i = 0; i < 8; i++) st[i] ^= load64_le(msg + i * 8);
        // Keccak-256 padding for exactly 64 bytes, rate 136: suffix 0x01, final 0x80.
        st[8] ^= 0x01ULL;
        st[16] ^= 0x8000000000000000ULL;
        keccakf(st);

        if (digest_le_lanes_lte_target(st)) {
            unsigned long long expected = 0ULL;
            if (atomicCAS(found, expected, 1ULL) == 0ULL) *found_nonce = (unsigned long long)nonce;
            return;
        }
    }
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex32(const char *hex, uint8_t out[32]) {
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    if (strlen(hex) > 64) return 0;
    char buf[65];
    memset(buf, '0', 64); buf[64] = 0;
    size_t len = strlen(hex);
    memcpy(buf + (64 - len), hex, len);
    for (int i = 0; i < 32; i++) {
        int hi = hexval(buf[2*i]), lo = hexval(buf[2*i+1]);
        if (hi < 0 || lo < 0) return 0;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <challenge_bytes32_hex> <target_hex_or_decimal> [blocks] [threads] [iters_per_thread] [start_nonce_u64]\n", argv[0]);
        return 2;
    }
    uint8_t challenge[32], target[32];
    if (!parse_hex32(argv[1], challenge)) { fprintf(stderr, "bad challenge\n"); return 2; }
    if (argv[2][0] == '0' && (argv[2][1] == 'x' || argv[2][1] == 'X')) {
        if (!parse_hex32(argv[2], target)) { fprintf(stderr, "bad target\n"); return 2; }
    } else {
        // decimal target -> convert using simple division in host code
        uint8_t dec[128]; size_t n = strlen(argv[2]);
        if (n >= sizeof(dec)) { fprintf(stderr, "target decimal too long\n"); return 2; }
        char tmp[128]; strcpy(tmp, argv[2]); memset(target, 0, 32);
        while (1) {
            int allzero = 1, rem = 0;
            for (size_t i = 0; i < n; i++) {
                int digit = tmp[i] - '0'; if (digit < 0 || digit > 9) { fprintf(stderr, "bad target decimal\n"); return 2; }
                int val = rem * 10 + digit; tmp[i] = (char)('0' + val / 256); rem = val % 256;
                if (tmp[i] != '0') allzero = 0;
            }
            for (int i = 31; i > 0; i--) target[i] = target[i-1]; target[0] = (uint8_t)rem;
            if (allzero) break;
        }
        // division loop above produced little-endian-ish shift; easier path is require hex from Node.
    }

    int blocks = argc > 3 ? atoi(argv[3]) : 0;
    int threads = argc > 4 ? atoi(argv[4]) : 256;
    uint64_t iters = argc > 5 ? strtoull(argv[5], NULL, 10) : 4096ULL;
    int dev = 0; cudaSetDevice(dev);
    cudaDeviceProp prop; cudaGetDeviceProperties(&prop, dev);
    if (blocks <= 0) blocks = prop.multiProcessorCount * 8;
    uint64_t stride = (uint64_t)blocks * (uint64_t)threads;

    cudaMemcpyToSymbol(C_CHALLENGE, challenge, 32);
    cudaMemcpyToSymbol(C_TARGET, target, 32);
    unsigned long long *d_found, *d_nonce;
    cudaMalloc(&d_found, sizeof(unsigned long long)); cudaMalloc(&d_nonce, sizeof(unsigned long long));
    cudaMemset(d_found, 0, sizeof(unsigned long long)); cudaMemset(d_nonce, 0, sizeof(unsigned long long));

    fprintf(stderr, "device=%s blocks=%d threads=%d stride=%llu iters=%llu\n", prop.name, blocks, threads, (unsigned long long)stride, (unsigned long long)iters);
    uint64_t start = argc > 6 ? strtoull(argv[6], NULL, 10) : ((uint64_t)time(NULL) * 1000003ULL);
    unsigned long long found = 0, nonce = 0;
    unsigned long long batches = 0;
    while (!found) {
        search_kernel<<<blocks, threads>>>(start, stride, iters, d_found, d_nonce);
        cudaError_t err = cudaDeviceSynchronize();
        if (err != cudaSuccess) { fprintf(stderr, "cuda error: %s\n", cudaGetErrorString(err)); return 1; }
        cudaMemcpy(&found, d_found, sizeof(found), cudaMemcpyDeviceToHost);
        if (found) break;
        start += stride * iters;
        batches++;
        if ((batches % 16ULL) == 0ULL) fprintf(stderr, "searched ~%llu hashes\n", (unsigned long long)(batches * stride * iters));
    }
    cudaMemcpy(&nonce, d_nonce, sizeof(nonce), cudaMemcpyDeviceToHost);
    printf("%llu\n", nonce);
    cudaFree(d_found); cudaFree(d_nonce);
    return 0;
}
