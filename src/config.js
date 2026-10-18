export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  port: Number(process.env.PORT || 3000),
};
if (!process.env.JWT_SECRET) console.warn('[config] JWT_SECRET not set - using an insecure dev default');
