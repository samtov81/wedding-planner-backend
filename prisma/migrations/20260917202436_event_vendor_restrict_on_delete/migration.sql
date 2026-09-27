-- DropForeignKey
ALTER TABLE "event_vendors" DROP CONSTRAINT "event_vendors_vendorProfileId_fkey";

-- AddForeignKey
ALTER TABLE "event_vendors" ADD CONSTRAINT "event_vendors_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "vendor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
