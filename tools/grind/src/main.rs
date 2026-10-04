//! Grinds Solana keypairs whose base58 address ends in a suffix (default `hook`).
//!
//!   hooker-grind [suffix] [count] [threads] [out_dir]
//!
//! Writes each hit as `<address>.json` (the 64-byte keypair array `solana-keygen` uses) into
//! out_dir. The suffix test is arithmetic on the 32-byte key — the last n base58 digits are the key
//! modulo 58^n — so only hits are ever base58-encoded.
use ed25519_dalek::SigningKey;
use rand::RngCore;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// The value the last `suffix.len()` base58 digits must have, and 58^len.
fn target(suffix: &str) -> (u64, u64) {
    let mut v = 0u64;
    for c in suffix.bytes() {
        let d = ALPHABET.iter().position(|&a| a == c).expect("not a base58 character") as u64;
        v = v * 58 + d;
    }
    (v, 58u64.pow(suffix.len() as u32))
}

/// The 32-byte big-endian number modulo m (m < 2^32 so the running remainder fits in u64).
fn modulo(bytes: &[u8; 32], m: u64) -> u64 {
    bytes.iter().fold(0u64, |r, &b| (r * 256 + b as u64) % m)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let suffix = args.get(1).cloned().unwrap_or_else(|| "hook".into());
    let count: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let threads: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    let out = args.get(4).cloned().unwrap_or_else(|| ".".into());
    let (want, m) = target(&suffix);
    assert!(m < (1 << 32), "suffix too long for the fast path");

    let found = Arc::new(AtomicUsize::new(0));
    let tried = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let handles: Vec<_> = (0..threads).map(|_| {
        let (found, tried, out, suffix) = (found.clone(), tried.clone(), out.clone(), suffix.clone());
        std::thread::spawn(move || {
            let mut rng = rand::rngs::OsRng;
            let mut seed = [0u8; 32];
            let mut local = 0u64;
            while found.load(Ordering::Relaxed) < count {
                rng.fill_bytes(&mut seed);
                let sk = SigningKey::from_bytes(&seed);
                let pk = sk.verifying_key().to_bytes();
                local += 1;
                if local % 65_536 == 0 { tried.fetch_add(65_536, Ordering::Relaxed); }
                if modulo(&pk, m) != want { continue; }
                let addr = bs58::encode(pk).into_string();
                if !addr.ends_with(&suffix) { continue; } // belt and braces
                if found.fetch_add(1, Ordering::SeqCst) >= count { break; }
                let mut kp = Vec::with_capacity(64);
                kp.extend_from_slice(&seed);
                kp.extend_from_slice(&pk);
                let json = format!("[{}]", kp.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(","));
                let tmp = format!("{}/.{}.tmp", out, addr);
                std::fs::write(&tmp, json).expect("write");
                std::fs::rename(&tmp, format!("{}/{}.json", out, addr)).expect("rename");
                println!("{}", addr);
            }
        })
    }).collect();
    for h in handles { h.join().unwrap(); }
    let secs = start.elapsed().as_secs_f64();
    eprintln!("{} found, ~{} tried in {:.1}s ({:.0}/s)", count, tried.load(Ordering::Relaxed), secs, tried.load(Ordering::Relaxed) as f64 / secs);
}
