import prisma from "../../db.server.js";

export async function getDlqAnalyticsSummary({ bucketStart, bucketEnd } = {}) {
  return prisma.analyticsSummary.findMany({
    where: {
      metricName: { startsWith: "dlq." },
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
}
