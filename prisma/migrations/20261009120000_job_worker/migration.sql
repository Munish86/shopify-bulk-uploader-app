-- DropIndex
DROP INDEX "Job_status_createdAt_idx";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "report",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "reportKey" TEXT;

-- CreateIndex
CREATE INDEX "Job_shop_status_idx" ON "Job"("shop", "status");

-- CreateIndex
CREATE INDEX "Job_status_heartbeatAt_idx" ON "Job"("status", "heartbeatAt");

