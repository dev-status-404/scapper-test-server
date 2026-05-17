const parseLimit = (value) => {
  const n = parseInt(value || "10", 10);
  if (Number.isNaN(n) || n <= 0) return 10;
  return Math.min(n, 100);
};

const parseOffset = (value) => {
  const n = parseInt(value || "0", 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
};

export { parseLimit, parseOffset };
