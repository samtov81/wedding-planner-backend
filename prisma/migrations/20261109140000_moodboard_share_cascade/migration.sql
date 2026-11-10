-- Una compartición es de la contratación: borrar el EventVendor (DELETE
-- /events/:id/vendors/:eventVendorId) se la lleva. Con RESTRICT ese borrado
-- daba 500 en cuanto la contratación había recibido alguna foto, aunque la
-- compartición estuviera revocada. Las notas cuelgan de la foto y sobreviven.

-- DropForeignKey
ALTER TABLE "moodboard_shares" DROP CONSTRAINT "moodboard_shares_eventVendorId_fkey";

-- AddForeignKey
ALTER TABLE "moodboard_shares" ADD CONSTRAINT "moodboard_shares_eventVendorId_fkey" FOREIGN KEY ("eventVendorId") REFERENCES "event_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
