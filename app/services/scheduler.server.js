import cron from "node-cron";
import prisma from "../db.server.js";
import { syncAllProductsForShop } from "./amazon-sync.server.js";

// Singleton pattern using globalThis to survive HMR in development
const g = globalThis;
if (!g.__schedulerTasks) g.__schedulerTasks = {};

const CRON_EXPRESSIONS = {
  hourly: "0 * * * *",
  twice_daily: "0 9,18 * * *",
  daily: "0 9 * * *",
};

export async function initAllSchedulers() {
  const configs = await prisma.schedulerConfig.findMany({ where: { enabled: true } });
  for (const config of configs) {
    await startSchedulerForShop(config.shop, config.schedule);
  }
}

export async function startSchedulerForShop(shop, schedule) {
  stopSchedulerForShop(shop);

  const expression = CRON_EXPRESSIONS[schedule] || CRON_EXPRESSIONS.daily;

  g.__schedulerTasks[shop] = cron.schedule(expression, async () => {
    try {
      const session = await prisma.session.findFirst({
        where: { shop, isOnline: false },
      });
      if (!session) return;

      await syncAllProductsForShop(shop, session.accessToken);

      await prisma.schedulerConfig.updateMany({
        where: { shop },
        data: { lastRunAt: new Date() },
      });
    } catch (err) {
      console.error(`Scheduler error for ${shop}:`, err);
    }
  });
}

export function stopSchedulerForShop(shop) {
  if (g.__schedulerTasks[shop]) {
    g.__schedulerTasks[shop].stop();
    delete g.__schedulerTasks[shop];
  }
}

export async function updateScheduler(shop, { schedule, enabled }) {
  await prisma.schedulerConfig.upsert({
    where: { shop },
    create: { shop, schedule, enabled },
    update: { schedule, enabled },
  });

  if (enabled) {
    await startSchedulerForShop(shop, schedule);
  } else {
    stopSchedulerForShop(shop);
  }
}

export async function runNow(shop, accessToken) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });
  const token = accessToken || session?.accessToken;
  if (!token) throw new Error("No access token found for shop");
  return syncAllProductsForShop(shop, token);
}
