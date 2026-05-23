ALTER TABLE "AmazonProduct" ADD COLUMN "availabilityStatus" TEXT;
ALTER TABLE "AmazonProduct" ADD COLUMN "cannotBeShipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AmazonProduct" ADD COLUMN "shippingUnavailableReason" TEXT;
