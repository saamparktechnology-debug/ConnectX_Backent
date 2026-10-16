// src/jobs/call-sweeper.job.ts
import { CallModel } from "../models/call.model.js";
import { UserModel } from "../models/user.model.js";
import { CallsService } from "../modules/calls/calls.service.js";
import { logger } from "../utils/logger.util.js";

export function startCallSweeperDaemon(): void {
  setInterval(async () => {
    try {
      // 1. Sweep expired incoming calls (> 60 seconds)
      const expired = await CallModel.findExpiredInitiated(25);
      for (const session of expired) {
        await CallsService.endCall(session.uuid, "network_drop");
        logger.info(
          { sessionUuid: session.uuid },
          "Swept expired unanswered call session to missed/completed",
        );
      }

      // 2. Monitor ongoing active calls for balance depletion
      const ongoing = await CallModel.findActiveOngoingSessions();
      for (const call of ongoing) {
        const caller = await UserModel.findById(call.caller_id);
        if (caller) {
          const currentBal = parseFloat(caller.wallet_balance);
          const elapsedSeconds = Math.floor(
            (Date.now() - new Date(call.accepted_at).getTime()) / 1000,
          );
          const currentMinutesBilled = Math.ceil(elapsedSeconds / 60);
          const costAccrued = currentMinutesBilled * 3.0;

          // Low balance warning: emit once per session when balance < 2 minutes' worth
          const TWO_MINUTES_COST = 6.0;
          if (
            currentBal >= costAccrued &&
            currentBal < costAccrued + TWO_MINUTES_COST
          ) {
            const { emitToUser } = await import("../socket/socket.server.js");
            emitToUser(call.caller_id, "call:low-balance", {
              sessionUuid: call.uuid,
              balance: currentBal.toFixed(2),
              remainingSeconds: Math.max(
                0,
                Math.floor((currentBal / 3.0) * 60),
              ),
            });
          }

          if (currentBal < costAccrued) {
            logger.warn(
              { sessionUuid: call.uuid, callerId: call.caller_id },
              "Terminating active call: Balance depleted",
            );
            const { emitToUser } = await import("../socket/socket.server.js");
            emitToUser(call.caller_id, "call:balance-exhausted", {
              sessionUuid: call.uuid,
            });
            emitToUser(call.receiver_id, "call:balance-exhausted", {
              sessionUuid: call.uuid,
            });
            await CallsService.endCall(call.uuid, "balance_exhausted");
          }
        }
      }
    } catch (err) {
      logger.error(
        { err },
        "Error occurred inside call sweeper daemon execution",
      );
    }
  }, 5000);
}
