# nn-watermark-decode

Rust decoder for NN screenshot UID dot watermark.

The tool focuses on the current payload:

```text
sync(0xB2) + packed(UInt32 big-endian) + crc16
packed = envBit << 31 | uid
```

It scans only the known anchors, not the full image:

- top notch center
- bottom center near the bottom edge

Usage:

```bash
cargo run --release -- /path/to/screenshot.png
cargo run --release -- /path/to/screenshot.png --limit 20
cargo run --release -- /path/to/screenshot.png --deep --limit 20
```

`--deep` expands scale / safe-top / x-y offset candidates, enables local contrast
normalization, and only tries double-bit repair for low-confidence candidates.

Output fields:

```text
anchor env uid score repaired scale safeTop start enhancement payloadHex
```
