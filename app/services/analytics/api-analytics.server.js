import prisma from "../../db.server.js";

export async function getApiAnalyticsSummary({ provider, bucketStart, bucketEnd } = {}) {
  const rows = await prisma.analyticsSummary.findMany({
    where: {
      metricName: { startsWith: "api." },
      ...(bucketStart || bucketEnd ? {
        bucketStart: {
          ...(bucketStart ? { gte: bucketStart } : {}),
          ...(bucketEnd ? { lt: bucketEnd } : {}),
        },
      } : {}),
    },
    orderBy: { bucketStart: "desc" },
    take: 200,
  });

  if (!provider) return rows;
  return rows.filter((row) => {
    try {
      return JSON.parse(row.dimensions || "{}").provider === provider;
    } catch {
      return false;
    }
  });
}
