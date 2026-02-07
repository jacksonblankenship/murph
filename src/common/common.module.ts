import { Global, Module } from '@nestjs/common';
import { AppClsService } from './cls.service';

@Global()
@Module({
  providers: [AppClsService],
  exports: [AppClsService],
})
export class CommonModule {}
