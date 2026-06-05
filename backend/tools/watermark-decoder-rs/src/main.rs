use image::GenericImageView;
use std::cmp::Ordering;
use std::env;
use std::path::PathBuf;

const CELL_WIDTH_PT: f32 = 3.2;
const CELL_HEIGHT_PT: f32 = 1.1;
const DOT_DIAMETER_PT: f32 = 0.9;
const BLOCK_SPACING_PT: f32 = 8.0;
const BIT_ROWS: usize = 8;
const PAYLOAD_LEN: usize = 7;
const SYNC_BYTE: u8 = 0xB2;
const DEFAULT_SAFE_TOPS: [f32; 3] = [54.0, 59.0, 65.0];
const DEFAULT_SCALES: [f32; 3] = [2.0, 2.769, 3.0];
const DEEP_SAFE_TOPS: [f32; 7] = [47.0, 51.0, 54.0, 59.0, 65.0, 70.0, 76.0];
const DEEP_SCALES: [f32; 7] = [1.85, 2.0, 2.25, 2.769, 3.0, 3.15, 3.3];
const X_DELTAS: [f32; 9] = [-24.0, -12.0, -8.0, -4.0, -0.3, 0.0, 4.0, 8.0, 12.0];
const Y_DELTAS: [f32; 15] = [-16.0, -14.0, -12.0, -10.0, -8.0, -6.0, -4.0, -2.0, -0.3, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0];
const DEEP_X_DELTAS: [f32; 19] = [-42.0, -36.0, -30.0, -24.0, -18.0, -12.0, -8.0, -4.0, -0.3, 0.0, 4.0, 8.0, 12.0, 18.0, 24.0, 30.0, 36.0, 42.0, 48.0];
const DEEP_Y_DELTAS: [f32; 23] = [-28.0, -24.0, -20.0, -16.0, -14.0, -12.0, -10.0, -8.0, -6.0, -4.0, -2.0, -0.3, 0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 16.0, 20.0, 24.0, 28.0];
const DOUBLE_REPAIR_SCORE_THRESHOLD: f32 = 8.0;
const BIT_SAMPLE_OFFSETS: [(f32, f32, f32); 7] = [
    (0.0, 0.0, 1.0),
    (-0.18, 0.0, 0.7),
    (0.18, 0.0, 0.7),
    (0.0, -0.18, 0.7),
    (0.0, 0.18, 0.7),
    (-0.14, -0.14, 0.45),
    (0.14, 0.14, 0.45),
];

#[derive(Clone)]
struct Args {
    image_path: PathBuf,
    limit: usize,
    deep: bool,
}

#[derive(Debug, Clone)]
struct Candidate {
    anchor: &'static str,
    enhancement: &'static str,
    env_name: &'static str,
    uid: u32,
    repaired: bool,
    score: f32,
    scale: f32,
    safe_top: f32,
    start_x: f32,
    start_y: f32,
    payload: [u8; PAYLOAD_LEN],
}

struct GrayImage {
    name: &'static str,
    width: usize,
    height: usize,
    pixels: Vec<f32>,
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            print_usage();
            std::process::exit(2);
        }
    };

    let image = match load_luminance(&args.image_path) {
        Ok(image) => image,
        Err(error) => {
            eprintln!("Failed to load image: {error}");
            std::process::exit(1);
        }
    };

    let mut candidates = decode_candidates(&image, args.deep);
    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
    });
    dedupe_candidates(&mut candidates);

    if candidates.is_empty() {
        println!("No UID watermark decoded.");
        std::process::exit(1);
    }

    println!("Decoded candidates:");
    for item in candidates.iter().take(args.limit) {
        println!(
            "anchor={} env={} uid={} score={:.2} repaired={} scale={:.3} safeTop={:.1} start=({:.1},{:.1}) enhancement={} payloadHex={}",
            item.anchor,
            item.env_name,
            item.uid,
            item.score,
            item.repaired,
            item.scale,
            item.safe_top,
            item.start_x,
            item.start_y,
            item.enhancement,
            hex_payload(&item.payload)
        );
    }
}

fn parse_args() -> Result<Args, String> {
    let mut image_path: Option<PathBuf> = None;
    let mut limit = 10usize;
    let mut deep = false;
    let mut iterator = env::args().skip(1);

    while let Some(arg) = iterator.next() {
        match arg.as_str() {
            "--limit" => {
                let value = iterator.next().ok_or("--limit requires a value")?;
                limit = value
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer")?;
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--deep" => {
                deep = true;
            }
            _ if arg.starts_with('-') => return Err(format!("Unknown argument: {arg}")),
            _ => image_path = Some(PathBuf::from(arg)),
        }
    }

    Ok(Args {
        image_path: image_path.ok_or("Missing image path")?,
        limit,
        deep,
    })
}

fn print_usage() {
    eprintln!("Usage: nn-watermark-decode <image> [--limit 20] [--deep]");
}

fn load_luminance(path: &PathBuf) -> image::ImageResult<GrayImage> {
    let image = image::open(path)?;
    let (width, height) = image.dimensions();
    let rgb = image.to_rgb8();
    let pixels = rgb
        .pixels()
        .map(|pixel| {
            let [r, g, b] = pixel.0;
            f32::from(r) * 0.299 + f32::from(g) * 0.587 + f32::from(b) * 0.114
        })
        .collect();

    Ok(GrayImage {
        name: "raw",
        width: width as usize,
        height: height as usize,
        pixels,
    })
}

fn decode_candidates(image: &GrayImage, deep: bool) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let highpass = highpass_image(image);
    let local_contrast = if deep { Some(local_contrast_image(image)) } else { None };
    let anchors = ["top", "bottom"];
    let scales: &[f32] = if deep { &DEEP_SCALES } else { &DEFAULT_SCALES };
    let safe_tops: &[f32] = if deep { &DEEP_SAFE_TOPS } else { &DEFAULT_SAFE_TOPS };
    let x_deltas: &[f32] = if deep { &DEEP_X_DELTAS } else { &X_DELTAS };
    let y_deltas: &[f32] = if deep { &DEEP_Y_DELTAS } else { &Y_DELTAS };

    let mut scan_images = vec![image, &highpass];
    if let Some(ref local_contrast) = local_contrast {
        scan_images.push(local_contrast);
    }

    for scan_image in scan_images {
        for &scale in scales {
            for &safe_top in safe_tops {
                let block_width = PAYLOAD_LEN as f32 * CELL_WIDTH_PT * scale;
                let block_height = BIT_ROWS as f32 * CELL_HEIGHT_PT * scale;

                for anchor in anchors {
                    let repeat_count = if anchor == "top" { 2 } else { 1 };
                    let block_spacing = BLOCK_SPACING_PT * scale;
                    let (base_x, base_y) = base_origin(
                        scan_image,
                        anchor,
                        block_width,
                        block_height,
                        block_spacing,
                        repeat_count,
                        scale,
                        safe_top,
                    );
                    for &y_delta in y_deltas {
                        for &x_delta in x_deltas {
                            let start_x = base_x + x_delta;
                            let start_y = base_y + y_delta;
                            if start_x < 0.0 || start_y < 0.0 {
                                continue;
                            }

                            let decoded = decode_repeated_block(
                                scan_image,
                                start_x,
                                start_y,
                                scale,
                                repeat_count,
                                block_width + block_spacing,
                            );
                            let allow_double_repair = deep && decoded.score < DOUBLE_REPAIR_SCORE_THRESHOLD;
                            if let Some((env_name, uid, payload, repaired)) = parse_or_repair(decoded.payload, allow_double_repair) {
                                candidates.push(Candidate {
                                    anchor,
                                    enhancement: scan_image.name,
                                    env_name,
                                    uid,
                                    repaired,
                                    score: decoded.score,
                                    scale,
                                    safe_top,
                                    start_x,
                                    start_y,
                                    payload,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    candidates
}

fn base_origin(
    image: &GrayImage,
    anchor: &'static str,
    block_width: f32,
    block_height: f32,
    block_spacing: f32,
    repeat_count: usize,
    scale: f32,
    safe_top: f32,
) -> (f32, f32) {
    let width = image.width as f32;
    let height = image.height as f32;
    let total_width = repeat_count as f32 * block_width + repeat_count.saturating_sub(1) as f32 * block_spacing;
    let x = (width - total_width) * 0.5;

    match anchor {
        "bottom" => (x, height - block_height - 4.0 * scale),
        _ => {
            let y = ((safe_top * scale) - block_height) * 0.5 - scale;
            (x, y.max(scale))
        }
    }
}

fn highpass_image(image: &GrayImage) -> GrayImage {
    let mut pixels = vec![0.0f32; image.pixels.len()];
    for y in 0..image.height {
        for x in 0..image.width {
            let mut sum = 0.0f32;
            let mut count = 0.0f32;
            let x0 = x.saturating_sub(2);
            let y0 = y.saturating_sub(2);
            let x1 = (x + 2).min(image.width.saturating_sub(1));
            let y1 = (y + 2).min(image.height.saturating_sub(1));

            for yy in y0..=y1 {
                let row = yy * image.width;
                for xx in x0..=x1 {
                    sum += image.pixels[row + xx];
                    count += 1.0;
                }
            }

            let index = y * image.width + x;
            let blur = if count > 0.0 { sum / count } else { image.pixels[index] };
            pixels[index] = (image.pixels[index] * 1.8 - blur * 0.8).clamp(0.0, 255.0);
        }
    }

    GrayImage {
        name: "highpass",
        width: image.width,
        height: image.height,
        pixels,
    }
}

fn local_contrast_image(image: &GrayImage) -> GrayImage {
    let mut pixels = vec![0.0f32; image.pixels.len()];
    let radius = 4usize;

    for y in 0..image.height {
        for x in 0..image.width {
            let x0 = x.saturating_sub(radius);
            let y0 = y.saturating_sub(radius);
            let x1 = (x + radius).min(image.width.saturating_sub(1));
            let y1 = (y + radius).min(image.height.saturating_sub(1));

            let mut sum = 0.0f32;
            let mut sum_sq = 0.0f32;
            let mut count = 0.0f32;
            for yy in y0..=y1 {
                let row = yy * image.width;
                for xx in x0..=x1 {
                    let value = image.pixels[row + xx];
                    sum += value;
                    sum_sq += value * value;
                    count += 1.0;
                }
            }

            let index = y * image.width + x;
            let mean = if count > 0.0 { sum / count } else { image.pixels[index] };
            let variance = if count > 0.0 { (sum_sq / count) - mean * mean } else { 0.0 };
            let std_dev = variance.max(0.0).sqrt().max(6.0);
            pixels[index] = ((image.pixels[index] - mean) / std_dev * 32.0 + 128.0).clamp(0.0, 255.0);
        }
    }

    GrayImage {
        name: "localContrast",
        width: image.width,
        height: image.height,
        pixels,
    }
}

struct DecodeBlockResult {
    payload: [u8; PAYLOAD_LEN],
    score: f32,
}

fn decode_repeated_block(
    image: &GrayImage,
    origin_x: f32,
    origin_y: f32,
    scale: f32,
    repeat_count: usize,
    repeat_stride: f32,
) -> DecodeBlockResult {
    let mut payload = [0u8; PAYLOAD_LEN];
    let mut total_confidence = 0.0f32;
    let mut bit_count = 0.0f32;

    for (column, byte_slot) in payload.iter_mut().enumerate() {
        let mut byte_value = 0u8;
        for bit_index in 0..BIT_ROWS {
            let mut merged_diff = 0.0f32;
            let mut merged_confidence = 0.0f32;
            for repeat_index in 0..repeat_count.max(1) {
                let block_x = origin_x + repeat_index as f32 * repeat_stride;
                let cell_x = block_x + column as f32 * CELL_WIDTH_PT * scale;
                let cell_y = origin_y + bit_index as f32 * CELL_HEIGHT_PT * scale;
                let dot_y = cell_y + CELL_HEIGHT_PT * scale * 0.5;
                let left_x = cell_x + CELL_WIDTH_PT * scale * 0.32;
                let right_x = cell_x + CELL_WIDTH_PT * scale * 0.68;
                let (diff, confidence) = sampled_bit_diff(image, left_x, right_x, dot_y, scale);
                merged_diff += diff * confidence.max(1.0);
                merged_confidence += confidence.max(1.0);
            }

            let diff = if merged_confidence > 0.0 {
                merged_diff / merged_confidence
            } else {
                0.0
            };
            let bit = if diff >= 0.0 { 1 } else { 0 };
            byte_value = (byte_value << 1) | bit;
            total_confidence += merged_confidence / repeat_count.max(1) as f32;
            bit_count += 1.0;
        }
        *byte_slot = byte_value;
    }

    DecodeBlockResult {
        payload,
        score: if bit_count > 0.0 { total_confidence / bit_count } else { 0.0 },
    }
}

fn sampled_bit_diff(image: &GrayImage, left_x: f32, right_x: f32, dot_y: f32, scale: f32) -> (f32, f32) {
    let dot_radius = (DOT_DIAMETER_PT * scale * 0.5).max(0.5);
    let mut weighted_diff = 0.0f32;
    let mut total_weight = 0.0f32;
    let mut vote_score = 0.0f32;

    for (x_offset, y_offset, weight) in BIT_SAMPLE_OFFSETS {
        let sample_dx = x_offset * dot_radius;
        let sample_dy = y_offset * dot_radius;
        let left_luma = mean_dot_luma(image, left_x + sample_dx, dot_y + sample_dy, dot_radius);
        let right_luma = mean_dot_luma(image, right_x + sample_dx, dot_y + sample_dy, dot_radius);
        let diff = left_luma - right_luma;
        weighted_diff += diff * weight;
        total_weight += weight;
        vote_score += if diff >= 0.0 { weight } else { -weight };
    }

    if total_weight <= 0.0 {
        return (0.0, 0.0);
    }

    let diff = weighted_diff / total_weight;
    let confidence = diff.abs() * (vote_score.abs() / total_weight);
    (diff, confidence)
}

fn mean_dot_luma(image: &GrayImage, center_x: f32, center_y: f32, radius: f32) -> f32 {
    let x0 = ((center_x - radius).round() as isize).max(0) as usize;
    let y0 = ((center_y - radius).round() as isize).max(0) as usize;
    let x1 = ((center_x + radius).round() as isize).min(image.width.saturating_sub(1) as isize) as usize;
    let y1 = ((center_y + radius).round() as isize).min(image.height.saturating_sub(1) as isize) as usize;

    if x0 > x1 || y0 > y1 {
        return 0.0;
    }

    let mut sum = 0.0f32;
    let mut count = 0.0f32;
    for y in y0..=y1 {
        let row = y * image.width;
        for x in x0..=x1 {
            sum += image.pixels[row + x];
            count += 1.0;
        }
    }

    if count > 0.0 { sum / count } else { 0.0 }
}

fn parse_payload(payload: &[u8; PAYLOAD_LEN]) -> Option<(&'static str, u32)> {
    if payload[0] != SYNC_BYTE || !crc16_ok(payload) {
        return None;
    }

    let packed = u32::from_be_bytes([payload[1], payload[2], payload[3], payload[4]]);
    let env_name = if (packed & 0x8000_0000) != 0 { "production" } else { "offline" };
    let uid = packed & 0x7fff_ffff;
    if uid == 0 {
        return None;
    }
    Some((env_name, uid))
}

fn parse_or_repair(
    payload: [u8; PAYLOAD_LEN],
    allow_double_repair: bool,
) -> Option<(&'static str, u32, [u8; PAYLOAD_LEN], bool)> {
    if let Some((env_name, uid)) = parse_payload(&payload) {
        return Some((env_name, uid, payload, false));
    }

    // The payload is tiny, so one-bit repair is cheap and catches low-alpha dot misses.
    for byte_index in 0..PAYLOAD_LEN {
        for bit_index in 0..8 {
            let mut repaired = payload;
            repaired[byte_index] ^= 1 << bit_index;
            if let Some((env_name, uid)) = parse_payload(&repaired) {
                return Some((env_name, uid, repaired, true));
            }
        }
    }

    if allow_double_repair {
        for first_bit in 0..(PAYLOAD_LEN * 8) {
            for second_bit in (first_bit + 1)..(PAYLOAD_LEN * 8) {
                let mut repaired = payload;
                repaired[first_bit / 8] ^= 1 << (first_bit % 8);
                repaired[second_bit / 8] ^= 1 << (second_bit % 8);
                if let Some((env_name, uid)) = parse_payload(&repaired) {
                    return Some((env_name, uid, repaired, true));
                }
            }
        }
    }

    None
}

fn crc16_ok(payload: &[u8; PAYLOAD_LEN]) -> bool {
    let expected = u16::from_be_bytes([payload[PAYLOAD_LEN - 2], payload[PAYLOAD_LEN - 1]]);
    crc16(&payload[..PAYLOAD_LEN - 2]) == expected
}

fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0xffffu16;
    for value in bytes {
        crc ^= u16::from(*value) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn dedupe_candidates(candidates: &mut Vec<Candidate>) {
    let mut deduped: Vec<Candidate> = Vec::new();
    for candidate in candidates.drain(..) {
        if let Some(existing) = deduped
            .iter_mut()
            .find(|item| item.anchor == candidate.anchor && item.uid == candidate.uid && item.env_name == candidate.env_name)
        {
            if candidate.score > existing.score {
                *existing = candidate;
            }
        } else {
            deduped.push(candidate);
        }
    }
    *candidates = deduped;
}

fn hex_payload(payload: &[u8; PAYLOAD_LEN]) -> String {
    payload.iter().map(|value| format!("{value:02x}")).collect()
}
