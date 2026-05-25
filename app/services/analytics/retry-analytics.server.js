import prisma from "../../db.server.js";

export async function getRetryAnalyticsSummary({ bucketStart, bucketEnd } = {}) {
  return prisma.analyticsSummary.findMany({
    where: {
      metricName: { startsWith: "retry." },
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
