import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObsidianService } from './obsidian.service';

@Module({
  imports: [ConfigModule, HttpModule],
  providers: [ObsidianService],
  exports: [ObsidianService],
})
export class ObsidianModule {}
