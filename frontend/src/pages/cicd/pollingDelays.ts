export const BUILD_REFRESH_DELAYS_MS = [0, 1500, 1500, 2000, 3000, 4000, 4000, 4000];

export const QUALITY_REFRESH_DELAYS_MS = [
  0,
  1000,
  1500,
  2000,
  3000,
  4000,
  5000,
  5000,
  5000,
  5000,
  5000,
  5000,
  5000,
  5000,
  5000,
  5000,
];

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
