import { logger } from './config/logger';
import { registerCleanupSessionsSchedule } from './jobs/schedules/cleanup-sessions.schedule';

// Runs as a singleton process (see ecosystem.config.cjs) so repeatable jobs
// are registered exactly once regardless of how many API instances are running.
async function main(): Promise<void> {
  await registerCleanupSessionsSchedule();
  logger.info('Scheduler registered repeatable jobs');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to register schedules');
  process.exit(1);
});
