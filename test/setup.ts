process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/backend_base_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-key-not-for-production';
process.env.EMAIL_PROVIDER ??= 'log';
process.env.COOKIE_SECURE ??= 'false';
process.env.CORS_ORIGIN ??= 'http://localhost:5173';
