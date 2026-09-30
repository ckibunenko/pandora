-- New enum values get their own migration: PostgreSQL cannot use a value in the transaction that adds it.
ALTER TYPE "MovementType" ADD VALUE 'RESERVATION';
ALTER TYPE "OrderStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "OrderStatus" ADD VALUE 'REJECTED';
ALTER TYPE "StockBucket" ADD VALUE 'RESERVED';
