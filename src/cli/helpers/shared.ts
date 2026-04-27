export function validateNum(value: number, flag: string): number {
  if (isNaN(value)) {
    console.error(`Invalid numeric value for ${flag}`);
    process.exit(1);
  }
  return value;
}
