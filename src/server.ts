import { createApp } from './app';
import { closeDb } from './database';
import { gatewayPort } from './gateway';

async function bootstrap() {
  const { app, gateway } = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HERMES_HOST?.trim() || '127.0.0.1';
  await app.listen({ port, host });
  await gateway.listen({ port: gatewayPort(), host: '127.0.0.1' });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    app.log.info({ signal }, 'Shutting down gracefully...');
    gateway
      .close()
      .catch(() => undefined)
      .then(() => app.close())
      .then(() => {
        closeDb();
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, 'Error during shutdown');
        try {
          closeDb();
        } catch {
          // The first close attempt already failed.
        }
        process.exit(1);
      });
  };

  // once: a second signal keeps Node's default exit, so a hung close can
  // still be interrupted. SIGINT is what the dev reloader sends.
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

bootstrap().catch((error) => {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${text}\n`);
  process.exit(1);
});
