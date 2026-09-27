import { createApp } from './app';
import { closeDb } from './database';

async function bootstrap() {
  const { app } = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    app.log.info({ signal }, 'Shutting down gracefully...');
    app
      .close()
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
