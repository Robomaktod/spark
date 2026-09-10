import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { isReplayFile, type ReplayFile, type ReplaySummary } from '@spark/replay';
import { AccessGuard } from './access.js';
import { ReplaysService } from './replays.service.js';
import { LiveService, type LiveSummary } from './live.service.js';

/** Four endpoints. The server stores and relays; it never simulates. */
@Controller('api')
@UseGuards(AccessGuard)
export class ApiController {
  constructor(
    private readonly replays: ReplaysService,
    private readonly live: LiveService,
  ) {}

  @Get('replays')
  list(): ReplaySummary[] {
    return this.replays.list();
  }

  @Get('replays/:id')
  get(@Param('id') id: string): ReplayFile {
    return this.replays.get(id);
  }

  @Post('replays')
  publish(@Body() body: unknown): ReplaySummary {
    if (!isReplayFile(body)) throw new BadRequestException('not a Spark replay');
    return this.replays.save(body);
  }

  @Get('live')
  liveMatches(): LiveSummary[] {
    return this.live.list();
  }
}
