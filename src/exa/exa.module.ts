import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExaService } from './exa.service';

@Module({
  imports: [ConfigModule],
  providers: [ExaService],
  exports: [ExaService],
})
export class ExaModule {}
