import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { MerkleAuditService } from './merkle.service';

@Module({
  controllers: [AuditController],
  providers: [MerkleAuditService],
  exports: [MerkleAuditService],
})
export class AuditModule {}
