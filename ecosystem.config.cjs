module.exports = {
  apps: [
    {
      name: 'api',
      script: 'dist/index.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'worker',
      script: 'dist/worker.js',
      instances: 2,
      exec_mode: 'fork',
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'scheduler',
      script: 'dist/scheduler.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      // One-shot: registers BullMQ repeatable jobs in Redis and exits.
      // Redis stores the repeat state, so this only needs to run once per deploy,
      // not stay alive - run it manually or as a post-deploy step, not on a restart loop.
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
