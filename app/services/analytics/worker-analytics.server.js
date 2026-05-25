import prisma from "../../db.server.js";

export async function getWorkerAnalyticsSummary({ workerName, bucketStart, bucketEnd } = {}) {
  const rows = await prisma.analyticsSummary.findMany({
    where: {
      metricName: { startsWith: "worker." },
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

  if (!workerName) return rows;
  return rows.filter((row) => {
    try {
      return JSON.parse(row.dimensions || "{}").workerName === workerName;
    } catch {
      return false;
    }
  });
}
