import prisma from "../../db.server.js";
import { aggregateAnalyticsWindow } from "./metrics-aggregator.server.js";
import { logAnalyticsEvent } from "./analytics-logger.server.js";
import { isValidDate, previousHourWindow } from "./analytics-utils.server.js";

const DEFAULT_AGGREGATION_INTERVAL_MS = 15 * 60 * 1000;
let aggregationRunning = false;

export function initAnalyticsAggregation() {
  // eslint-disable-next-line no-undef
  const g = globalThis;
  if (g.__analyticsAggregationInterval) return;

  g.__analyticsAggregationInterval = setInterval(() => {
    runAnalyticsAggregationOnce().catch((err) =>
      logAnalyticsEvent("analytics_aggregation_failure", {
        error: err?.message || String(err),
      })
    );
  }, DEFAULT_AGGREGATION_INTERVAL_MS);

  setTimeout(() => {
    runAnalyticsAggregationOnce().catch((err) =>
      logAnalyticsEvent("analytics_aggregation_failure", {
        error: err?.message || String(err),
      })
    );
  }, 0);
}

export async function runAnalyticsAggregationOnce({ bucketStart, bucketEnd } = {}) {
  if (aggregationRunning) {
    logAnalyticsEvent("analytics_aggregation_skipped", {
      reason: "aggregation_already_running",
    });
    return { skipped: true };
  }

  aggregationRunning = true;
  const window = bucketStart && bucketEnd ? { bucketStart, bucketEnd } : await getNextAggregationWindow();

  try {
    if (!isValidDate(window.bucketStart) || !isValidDate(window.bucketEnd)) {
      throw new Error("Invalid analytics aggregation window");
    }

    const startedAt = Date.now();
    const result = await aggregateAnalyticsWindow(window);
    await prisma.analyticsAggregationRun.upsert({
      where: {
        bucketStart_bucketEnd: {
          bucketStart: window.bucketStart,
          bucketEnd: window.bucketEnd,
        },
      },
      create: {
        bucketStart: window.bucketStart,
        bucketEnd: window.bucketEnd,
        status: "success",
        summaryCount: result.summaryCount,
        durationMs: Date.now() - startedAt,
      },
      update: {
        status: "success",
        summaryCount: result.summaryCount,
        durationMs: Date.now() - startedAt,
        error: null,
      },
    });
    logAnalyticsEvent("analytics_aggregation_completed", {
      bucketStart: window.bucketStart,
      bucketEnd: window.bucketEnd,
      summaryCount: result.summaryCount,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    await recordAggregationFailure(window, err);
    logAnalyticsEvent("analytics_aggregation_failure", {
      bucketStart: window.bucketStart,
      bucketEnd: window.bucketEnd,
      error: err?.message || String(err),
    });
    return { failed: true, error: err?.message || String(err) };
  } finally {
    aggregationRunning = false;
  }
}

async function getNextAggregationWindow() {
  const lastRun = await prisma.analyticsAggregationRun.findFirst({
    where: { status: "success" },
    orderBy: { bucketEnd: "desc" },
  });
  if (lastRun?.bucketEnd && lastRun.bucketEnd < previousHourWindow().bucketEnd) {
    return {
      bucketStart: lastRun.bucketEnd,
      bucketEnd: new Date(lastRun.bucketEnd.getTime() + 60 * 60 * 1000),
    };
  }
  return previousHourWindow();
}

async function recordAggregationFailure(window, error) {
  try {
    if (!isValidDate(window.bucketStart) || !isValidDate(window.bucketEnd)) {
      logAnalyticsEvent("analytics_calculation_error", {
        error: error?.message || String(error),
        bucketStart: window.bucketStart,
        bucketEnd: window.bucketEnd,
      });
      return;
    }

    await prisma.analyticsAggregationRun.upsert({
      where: {
        bucketStart_bucketEnd: {
          bucketStart: window.bucketStart,
          bucketEnd: window.bucketEnd,
        },
      },
      create: {
        bucketStart: window.bucketStart,
        bucketEnd: window.bucketEnd,
        status: "failed",
        error: (error?.message || String(error)).slice(0, 1000),
      },
      update: {
        status: "failed",
        error: (error?.message || String(error)).slice(0, 1000),
      },
    });
  } catch (err) {
    logAnalyticsEvent("analytics_calculation_error", {
      error: err?.message || String(err),
    });
  }
}
