-- New enum values get their own migration: PostgreSQL cannot use a value in the transaction that adds it.
ALTER TYPE "MovementType" ADD VALUE 'SHIPMENT';
ALTER TYPE "MovementType" ADD VALUE 'RELEASE';
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIALLY_SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE 'SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE 'CLOSED_PARTIAL';
