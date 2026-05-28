import { readNumberEnv } from "../utils/scaling-config.server.js";

export function getHealthThresholds() {
  return {
    queueWaitingWarningThreshold: readNumberEnv("QUEUE_WAITING_WARNING_THRESHOLD", {
      defaultValue: 25,
      min: 1,
      max: 100000,
    }),
    queueWaitingCriticalThreshold: readNumberEnv("QUEUE_WAITING_CRITICAL_THRESHOLD", {
      defaultValue: 100,
      min: 1,
      max: 100000,
    }),
    queueOldestJobWarningMinutes: readNumberEnv("QUEUE_OLDEST_JOB_WARNING_MINUTES", {
      defaultValue: 30,
      min: 1,
      max: 10080,
    }),
    queueOldestJobCriticalMinutes: readNumberEnv("QUEUE_OLDEST_JOB_CRITICAL_MINUTES", {
      defaultValue: 120,
      min: 1,
      max: 10080,
    }),
    workerHeartbeatWarningMinutes: readNumberEnv("WORKER_HEARTBEAT_WARNING_MINUTES", {
      defaultValue: 5,
      min: 1,
      max: 1440,
    }),
    workerHeartbeatCriticalMinutes: readNumberEnv("WORKER_HEARTBEAT_CRITICAL_MINUTES", {
      defaultValue: 15,
      min: 1,
      max: 1440,
    }),
    apiFailureWindowMinutes: readNumberEnv("API_FAILURE_WINDOW_MINUTES", {
      defaultValue: 15,
      min: 1,
      max: 1440,
    }),
    apiFailureWarningThreshold: readNumberEnv("API_FAILURE_WARNING_THRESHOLD", {
      defaultValue: 5,
      min: 1,
      max: 10000,
    }),
    apiFailureCriticalThreshold: readNumberEnv("API_FAILURE_CRITICAL_THRESHOLD", {
      defaultValue: 20,
      min: 1,
      max: 10000,
    }),
    apiFailureRateWarningPercent: readNumberEnv("API_FAILURE_RATE_WARNING_PERCENT", {
      defaultValue: 20,
      min: 1,
      max: 100,
    }),
    apiFailureRateCriticalPercent: readNumberEnv("API_FAILURE_RATE_CRITICAL_PERCENT", {
      defaultValue: 50,
      min: 1,
      max: 100,
    }),
    providerFailureWarningThreshold: readNumberEnv("PROVIDER_FAILURE_WARNING_THRESHOLD", {
      defaultValue: 3,
      min: 1,
      max: 10000,
    }),
    providerFailureCriticalThreshold: readNumberEnv("PROVIDER_FAILURE_CRITICAL_THRESHOLD", {
      defaultValue: 10,
      min: 1,
      max: 10000,
    }),
    dlqIncreaseWindowMinutes: readNumberEnv("DLQ_INCREASE_WINDOW_MINUTES", {
      defaultValue: 60,
      min: 1,
      max: 10080,
    }),
    dlqIncreaseWarningThreshold: readNumberEnv("DLQ_INCREASE_WARNING_THRESHOLD", {
      defaultValue: 3,
      min: 1,
      max: 10000,
    }),
    dlqIncreaseCriticalThreshold: readNumberEnv("DLQ_INCREASE_CRITICAL_THRESHOLD", {
      defaultValue: 10,
      min: 1,
      max: 10000,
    }),
    trackingDelayWarningMinutes: readNumberEnv("TRACKING_DELAY_WARNING_MINUTES", {
      defaultValue: 240,
      min: 1,
      max: 43200,
    }),
    trackingDelayCriticalMinutes: readNumberEnv("TRACKING_DELAY_CRITICAL_MINUTES", {
      defaultValue: 1440,
      min: 1,
      max: 43200,
    }),
  };
}
