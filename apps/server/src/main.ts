/**
 * The Spark relay.
 *
 * Nest earns its place here and not in the engine (passport §17): this process
 * is a web server and nothing else. It stores finished replays, fans out live
 * turn packets, and serves the built viewer. It never executes bot code, so the
 * whole class of "someone uploaded a fork bomb" problems does not exist.
 *
 *   SPARK_KEY          shared access secret; unset means the network is the gate
 *   SPARK_REPLAY_DIR   where replays are stored (default ./replays)
 *   SPARK_WEB_DIR      built web app to serve (default apps/web/dist)
 *   PORT               default 3000
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';
import { LiveService } from './live.service.js';
import { configuredKey } from './access.js';

async function bootstrap(): Promise<void> {
  const log = new Logger('spark');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });

  // A replay with keyframes runs to a few hundred kB, well past the default limit.
  app.use(express.json({ limit: '64mb' }));

  const webDir = resolve(process.env['SPARK_WEB_DIR'] ?? 'apps/web/dist');
  if (existsSync(webDir)) {
    app.useStaticAssets(webDir);
    // The viewer is a client-routed SPA, so unknown paths return the shell.
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.includes('.'))
        return next();
      res.sendFile(resolve(webDir, 'index.html'));
    });
    log.log(`serving the viewer from ${webDir}`);
  } else {
    log.warn(`no built web app at ${webDir} — run "npm run build --workspace @spark/web"`);
  }

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);

  const httpServer = app.getHttpServer() as Server;
  app.get(LiveService).attach(httpServer);

  log.log(`listening on http://localhost:${port}`);
  log.log(
    configuredKey()
      ? 'access key required: append ?key=... to the URL'
      : 'no SPARK_KEY set — anyone who can reach this port has full access',
  );
}

void bootstrap();
