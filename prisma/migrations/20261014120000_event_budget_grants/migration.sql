-- CreateTable
CREATE TABLE "event_budget_grants" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_budget_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_budget_grants_membershipId_key" ON "event_budget_grants"("membershipId");

-- AddForeignKey
ALTER TABLE "event_budget_grants" ADD CONSTRAINT "event_budget_grants_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "event_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
