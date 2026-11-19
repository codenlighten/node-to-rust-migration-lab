// Single-threaded bcrypt cost-10 timing, same inputs as micro.mjs. Prints one JSON line.
use std::time::Instant;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(40);
    for _ in 0..3 {
        bcrypt::hash("password123", 10).unwrap(); // warm-up
    }
    let mut hash_ms = vec![];
    let h = bcrypt::hash("password123", 10).unwrap();
    for _ in 0..n {
        let t = Instant::now();
        bcrypt::hash("password123", 10).unwrap();
        hash_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let mut verify_ms = vec![];
    for _ in 0..n {
        let t = Instant::now();
        assert!(bcrypt::verify("password123", &h).unwrap());
        verify_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };
    println!("{{\"impl\":\"rust bcrypt crate\",\"n\":{n},\"hashMsMedian\":{:.2},\"hashMsMin\":{:.2},\"hashMsMax\":{:.2},\"verifyMsMedian\":{:.2}}}",
        med(&mut hash_ms.clone()), hash_ms.iter().cloned().fold(f64::MAX, f64::min), hash_ms.iter().cloned().fold(0.0, f64::max), med(&mut verify_ms));
}
