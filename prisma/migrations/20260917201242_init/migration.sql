-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "EventRole" AS ENUM ('COUPLE', 'PLANNER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "VendorProfileStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "EventVendorStatus" AS ENUM ('SHORTLISTED', 'BOOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RsvpStatus" AS ENUM ('CONFIRMED', 'PENDING', 'DECLINED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'RESPONDED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "systemRole" "SystemRole" NOT NULL DEFAULT 'USER',
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "businessName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "specialty" TEXT,
    "bio" TEXT,
    "contact" JSONB,
    "status" "VendorProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "weddingDate" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "venueLocation" TEXT,
    "ownerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_memberships" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "EventRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invitedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_vendors" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "vendorProfileId" UUID,
    "externalName" TEXT,
    "externalEmail" TEXT,
    "externalPhone" TEXT,
    "category" TEXT NOT NULL,
    "specialty" TEXT,
    "assignedBudget" DECIMAL(12,2),
    "status" "EventVendorStatus" NOT NULL DEFAULT 'SHORTLISTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "group" TEXT NOT NULL,
    "rsvp" "RsvpStatus" NOT NULL DEFAULT 'PENDING',
    "dietary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_invitations" (
    "id" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'QUEUED',
    "resendMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "eventId" UUID,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_profiles_userId_key" ON "vendor_profiles"("userId");

-- CreateIndex
CREATE INDEX "vendor_profiles_category_status_idx" ON "vendor_profiles"("category", "status");

-- CreateIndex
CREATE INDEX "events_ownerId_idx" ON "events"("ownerId");

-- CreateIndex
CREATE INDEX "event_memberships_userId_idx" ON "event_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "event_memberships_eventId_userId_key" ON "event_memberships"("eventId", "userId");

-- CreateIndex
CREATE INDEX "event_vendors_eventId_idx" ON "event_vendors"("eventId");

-- CreateIndex
CREATE INDEX "event_vendors_vendorProfileId_idx" ON "event_vendors"("vendorProfileId");

-- CreateIndex
CREATE INDEX "guests_eventId_createdAt_id_idx" ON "guests"("eventId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "guests_eventId_rsvp_idx" ON "guests"("eventId", "rsvp");

-- CreateIndex
CREATE UNIQUE INDEX "guest_invitations_tokenHash_key" ON "guest_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "guest_invitations_guestId_idx" ON "guest_invitations"("guestId");

-- CreateIndex
CREATE INDEX "guest_invitations_resendMessageId_idx" ON "guest_invitations"("resendMessageId");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_eventId_createdAt_idx" ON "notifications"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_eventId_createdAt_idx" ON "audit_logs"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_memberships" ADD CONSTRAINT "event_memberships_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_memberships" ADD CONSTRAINT "event_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_vendors" ADD CONSTRAINT "event_vendors_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_vendors" ADD CONSTRAINT "event_vendors_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "vendor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_invitations" ADD CONSTRAINT "guest_invitations_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un EventVendor es O una ficha del marketplace O un proveedor externo, nunca
-- ambos ni ninguno. La base de datos es la última línea: sobrevive a los bugs
-- del código de aplicación.
ALTER TABLE "event_vendors"
  ADD CONSTRAINT "event_vendors_origen_exclusivo"
  CHECK (
    ("vendorProfileId" IS NOT NULL AND "externalName" IS NULL)
    OR
    ("vendorProfileId" IS NULL AND "externalName" IS NOT NULL)
  );

-- Índice único PARCIAL: impide dos invitados con el mismo correo en un evento,
-- y permite tantos invitados sin correo como haga falta. Postgres ya trata los
-- NULL como distintos, pero el índice parcial deja la intención escrita en el
-- esquema en vez de depender de que quien lo lea conozca esa sutileza del SQL.
CREATE UNIQUE INDEX "guests_event_email_unico"
  ON "guests" ("eventId", "email")
  WHERE "email" IS NOT NULL;
