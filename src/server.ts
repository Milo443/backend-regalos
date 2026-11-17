import { app } from './app.js';
import { env } from './core/config/env.js';

const server = app.listen(env.PORT, () => {
  console.info(
    `[CEMCOP Backend] Express.js 5 corriendo en puerto ${env.PORT} (${env.NODE_ENV}) | Node ${process.version}`,
  );
});

process.on('SIGTERM', () => {
  console.info('[CEMCOP Backend] Recibida señal SIGTERM, cerrando servidor...');
  server.close(() => process.exit(0));
});

