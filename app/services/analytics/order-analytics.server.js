import prisma from "../../db.server.js";

export async function getOrderAnalyticsSummary({ metricName, bucketStart, bucketEnd } = {}) {
  return prisma.analyticsSummary.findMany({
    where: {
      ...(metricName ? { metricName } : {}),
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
