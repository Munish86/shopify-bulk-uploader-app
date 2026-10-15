-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "planCheckedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Usage" (
    "shop" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "products" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Usage_pkey" PRIMARY KEY ("shop","month")
);

-- CreateIndex
CREATE INDEX "ProductBackup_shop_jobId_idx" ON "ProductBackup"("shop", "jobId");

-- AddForeignKey
ALTER TABLE "Usage" ADD CONSTRAINT "Usage_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shop") ON DELETE CASCADE ON UPDATE CASCADE;
