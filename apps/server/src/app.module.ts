import { Module } from '@nestjs/common';
import { ApiController } from './api.controller.js';
import { LiveService } from './live.service.js';
import { ReplaysService } from './replays.service.js';

@Module({
  controllers: [ApiController],
  providers: [ReplaysService, LiveService],
})
export class AppModule {}
