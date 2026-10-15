import { TargetsService } from "../modules/targets/targets.service.js";
import { logger } from "../utils/logger.util.js";

/**
 * Runs hourly. Awards targets only on the 1st of each month at 00:05 UTC.
 * Idempotent — repeated runs won't double-award.
 */
export function startTargetsAwardDaemon(): void {
  const tick = async () => {
    const now = new Date();
    // Run only during the first day of the month
    if (now.getUTCDate() !== 1) return;
    if (now.getUTCHours() !== 0) return;

    // Award for previous month
    const y =
      now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const m = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();

    try {
      const result = await TargetsService.awardCompletedTargets(y, m);
      logger.info(result, "monthly target awards run");
    } catch (err) {
      logger.error({ err }, "monthly target award daemon failed");
    }
  };

  // Run every hour
  setInterval(tick, 60 * 60 * 1000);
  logger.info("Targets award daemon started");
}
