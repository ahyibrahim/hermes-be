import { createApp } from './app';

async function bootstrap() {
  const { app } = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Server listening on http://0.0.0.0:${port}`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
