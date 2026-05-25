export function startOfHour(date = new Date()) {
  const value = new Date(date);
  value.setMinutes(0, 0, 0);
  return value;
}

export function previousHourWindow(now = new Date()) {
  const bucketEnd = startOfHour(now);
  const bucketStart = new Date(bucketEnd.getTime() - 60 * 60 * 1000);
  return { bucketStart, bucketEnd };
}

export function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function safeRate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(6));
}

export function safeAverage(total, count) {
  if (!count) return 0;
  return Number((total / count).toFixed(2));
}

export function parseMetricPayload(payload) {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function dimensionsKey(dimensions = {}) {
  return JSON.stringify(Object.keys(dimensions).sort().reduce((result, key) => {
    result[key] = dimensions[key];
    return result;
  }, {}));
}
