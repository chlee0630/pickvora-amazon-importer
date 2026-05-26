import prisma from "../../db.server.js";
import { logProviderEvent } from "../../utils/provider-errors.server.js";

const DEGRADED_FAILURE_THRESHOLD = 3;
const VALID_STATUSES = new Set(["ACTIVE", "DEGRADED", "DISABLED"]);

export async function getProviderHealth(providerName) {
  const row = await prisma.providerHealth.findUnique({ where: { providerName } });
  if (row) return row;

  return prisma.providerHealth.create({
    data: {
      providerName,
      status: "ACTIVE",
    },
  });
}

export async function recordProviderSuccess(providerName) {
  const updated = await prisma.providerHealth.upsert({
    where: { providerName },
    create: {
      providerName,
      status: "ACTIVE",
      failureCount: 0,
      lastSuccessAt: new Date(),
    },
    update: {
      status: "ACTIVE",
      failureCount: 0,
      lastSuccessAt: new Date(),
      disabledReason: null,
    },
  });

  logProviderEvent("provider_success", {
    provider: providerName,
    status: updated.status,
  });
  return updated;
}

export async function recordProviderFailure(providerName, normalizedError) {
  const existing = await getProviderHealth(providerName);
  if (existing.status === "DISABLED") return existing;

  const nextFailureCount = existing.failureCount + 1;
  const nextStatus = normalizedError.retryable && nextFailureCount >= DEGRADED_FAILURE_THRESHOLD
    ? "DEGRADED"
    : existing.status;

  const updated = await prisma.providerHealth.update({
    where: { providerName },
    data: {
      status: nextStatus,
      failureCount: nextFailureCount,
      lastFailureAt: new Date(),
    },
  });

  if (updated.status === "DEGRADED") {
    logProviderEvent("provider_degraded", {
      provider: providerName,
      failureCount: updated.failureCount,
      code: normalizedError.code,
    });
  }

  return updated;
}

export async function setProviderStatus(providerName, status, disabledReason = null) {
  if (!VALID_STATUSES.has(status)) throw new Error(`Unsupported provider status: ${status}`);

  const updated = await prisma.providerHealth.upsert({
    where: { providerName },
    create: {
      providerName,
      status,
      disabledReason,
    },
    update: {
      status,
      disabledReason: status === "DISABLED" ? disabledReason : null,
    },
  });

  logProviderEvent(status === "DISABLED" ? "provider_disabled" : "provider_status_updated", {
    provider: providerName,
    status,
    disabledReason,
  });
  return updated;
}
