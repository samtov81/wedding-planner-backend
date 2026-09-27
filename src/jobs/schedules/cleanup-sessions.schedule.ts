import { maintenanceQueue } from '../../infrastructure/queue/queue.registry';

// Registered by src/scheduler.ts, a singleton process, so this repeatable job
// isn't duplicated when the API is scaled horizontally.
export async function registerCleanupSessionsSchedule(): Promise<void> {
  await maintenanceQueue.add(
    'cleanup-expired-sessions',
    {},
    {
      repeat: { pattern: '0 3 * * *' }, // daily at 03:00
      jobId: 'cleanup-expired-sessions',
    },
  );
}
